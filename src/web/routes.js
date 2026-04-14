// Server-rendered web UI routes. All require auth except /login.

import { Router } from 'express';
import { verifyLogin, requireAuth } from '../auth.js';
import { query } from '../db/index.js';
import { getPendingDrafts, getPendingReplies } from '../queue/approval_queue.js';
import { researchAndDraft, runDiscoveryCycle } from '../pipeline.js';

export const webRouter = Router();

// ---------- Auth ----------

webRouter.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect(req.query.next || '/');
  res.render('login', {
    title: 'Sign in',
    error: req.query.error || null,
    next: req.query.next || '/',
    user: null,
  });
});

webRouter.post('/login', async (req, res) => {
  const { email, password, next } = req.body || {};
  const target = (typeof next === 'string' && next.startsWith('/')) ? next : '/';
  if (!email || !password) {
    return res.redirect(`/login?error=${encodeURIComponent('Email and password required')}&next=${encodeURIComponent(target)}`);
  }
  try {
    const user = await verifyLogin(email, password);
    if (!user) {
      return res.redirect(`/login?error=${encodeURIComponent('Invalid email or password')}&next=${encodeURIComponent(target)}`);
    }
    req.session.userId = user.id;
    req.session.email = user.email;
    res.redirect(target);
  } catch (err) {
    console.error('[login] error:', err);
    res.redirect(`/login?error=${encodeURIComponent('Login failed, try again')}&next=${encodeURIComponent(target)}`);
  }
});

webRouter.post('/logout', (req, res) => {
  req.session?.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

// ---------- Authenticated pages ----------

webRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const counts = await getCounts();
    const connections = await getConnectionStatus();
    res.render('dashboard', { title: 'Dashboard', counts, connections });
  } catch (err) {
    next(err);
  }
});

webRouter.get('/drafts', requireAuth, async (req, res, next) => {
  try {
    const drafts = await getPendingDrafts(req.session.userId);
    const discovering = req.query.discovering ? Number(req.query.discovering) : null;
    res.render('drafts', { title: 'Drafts', drafts, discovering });
  } catch (err) {
    next(err);
  }
});

webRouter.get('/replies', requireAuth, async (req, res, next) => {
  try {
    const replies = await getPendingReplies(req.session.userId);
    res.render('replies', { title: 'Replies', replies });
  } catch (err) {
    next(err);
  }
});

// Run the full sourcing pipeline on a single prospect from the UI:
// research (Claude + web_search) → score fit → draft sequence → queue for
// approval. Same pipeline the scheduled cron will run once Salesforce is wired.
webRouter.get('/prospects/new', requireAuth, (_req, res) => {
  res.render('prospect_new', { title: 'Add prospect', form: {}, error: null, notice: null });
});

webRouter.post('/prospects/new', requireAuth, async (req, res) => {
  const body = req.body || {};
  const form = {
    company: (body.company || '').trim(),
    domain: (body.domain || '').trim() || null,
    contact_name: (body.contact_name || '').trim() || null,
  };

  if (!form.company) {
    return res.render('prospect_new', {
      title: 'Add prospect', form,
      error: 'Company is required.', notice: null,
    });
  }

  try {
    const result = await researchAndDraft({
      company: form.company,
      domain: form.domain,
      contact_name: form.contact_name,
      owner_user_id: req.session.userId,
    });

    if (!result.draft) {
      // Prospect was saved, but didn't meet the drafting bar — explain why
      // so the operator can judge whether the sourcing got it right.
      return res.render('prospect_new', {
        title: 'Add prospect', form,
        error: null,
        notice: `Researched, but no draft created: ${result.reason}. The prospect was saved for later.`,
      });
    }
    res.redirect('/drafts');
  } catch (err) {
    console.error('[prospects/new] pipeline failed:', err);
    res.render('prospect_new', {
      title: 'Add prospect', form,
      error: 'Pipeline failed: ' + (err.message || 'unknown error') + '. Check the Railway logs.',
      notice: null,
    });
  }
});

// Trigger an autonomous discovery cycle. Fires the work in the background
// so the HTTP request returns immediately — drafts appear on /drafts as
// Claude finishes each one.
webRouter.post('/discover', requireAuth, (req, res) => {
  const count = Math.min(Number(req.body?.count) || 5, 10);
  const hint = (req.body?.hint || '').trim();
  const ownerId = req.session.userId;

  // Fire and forget — don't await. Node keeps the promise alive.
  runDiscoveryCycle({ count, hint, owner_user_id: ownerId })
    .then((r) => console.log('[discover] cycle finished:', r))
    .catch((err) => console.error('[discover] cycle crashed:', err));

  res.redirect('/drafts?discovering=' + count);
});

webRouter.get('/settings', requireAuth, async (_req, res, next) => {
  try {
    const providers = await getProviders();
    const usersRes = await query(
      `SELECT email, name, last_login_at FROM users ORDER BY created_at ASC;`
    );
    res.render('settings', {
      title: 'Settings',
      providers,
      users: usersRes.rows,
      sendWindow: {
        start: process.env.SEND_WINDOW_START || 8,
        end: process.env.SEND_WINDOW_END || 17,
        tz: process.env.SEND_TIMEZONE || 'America/Chicago',
        dailyLimit: process.env.DAILY_EMAIL_LIMIT || 50,
      },
    });
  } catch (err) {
    next(err);
  }
});

webRouter.post('/settings/disconnect/:provider', requireAuth, async (req, res, next) => {
  try {
    await query(`DELETE FROM integrations WHERE provider = $1;`, [req.params.provider]);
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

// ---------- Helpers ----------

async function getCounts() {
  const [drafts, replies, researched, sent] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM approval_queue WHERE status = 'pending';`),
    query(`SELECT COUNT(*)::int AS n FROM reply_queue WHERE status = 'pending';`),
    query(`SELECT COUNT(*)::int AS n FROM prospects WHERE researched_at >= date_trunc('day', NOW());`),
    query(`SELECT COUNT(*)::int AS n FROM sent_messages WHERE sent_at >= date_trunc('week', NOW());`),
  ]);
  return {
    pendingDrafts: drafts.rows[0].n,
    pendingReplies: replies.rows[0].n,
    researchedToday: researched.rows[0].n,
    sentThisWeek: sent.rows[0].n,
  };
}

async function getConnectionStatus() {
  const { rows } = await query(`SELECT provider, account_label FROM integrations;`);
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));

  return [
    {
      label: 'Anthropic',
      ok: !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_key_here',
      detail: process.env.ANTHROPIC_API_KEY ? 'API key configured' : 'Set ANTHROPIC_API_KEY in .env',
    },
    {
      label: 'Gmail',
      ok: !!byProvider.gmail,
      detail: byProvider.gmail?.account_label || 'Not connected',
    },
    {
      label: 'Salesforce',
      ok: !!byProvider.salesforce,
      detail: byProvider.salesforce?.account_label || 'Not connected',
    },
    {
      label: 'CommonRoom',
      ok: !!byProvider.commonroom,
      detail: byProvider.commonroom?.account_label || 'Not connected',
    },
  ];
}

async function getProviders() {
  const { rows } = await query(`SELECT provider, account_label, connected_at FROM integrations;`);
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));

  // OAuth URLs are stubbed for now; Phase 3 will wire the real flows.
  return [
    {
      provider: 'gmail',
      label: 'Gmail',
      description: 'Send messages and read replies from your team inbox.',
      connected: !!byProvider.gmail,
      account_label: byProvider.gmail?.account_label,
      connected_at: byProvider.gmail?.connected_at,
      oauth_url: null, // will be /oauth/gmail/start once wired
    },
    {
      provider: 'salesforce',
      label: 'Salesforce',
      description: 'Pull accounts and contacts. Mark accounts as researched.',
      connected: !!byProvider.salesforce,
      account_label: byProvider.salesforce?.account_label,
      connected_at: byProvider.salesforce?.connected_at,
      oauth_url: null,
    },
    {
      provider: 'commonroom',
      label: 'CommonRoom',
      description: 'Pull intent signals to enrich the timing-signal field.',
      connected: !!byProvider.commonroom,
      account_label: byProvider.commonroom?.account_label,
      connected_at: byProvider.commonroom?.connected_at,
      oauth_url: null,
    },
  ];
}

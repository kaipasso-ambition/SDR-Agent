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
    res.render('drafts', { title: 'Drafts', drafts });
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

// Trigger an autonomous discovery cycle. Creates a discovery_jobs row so
// progress is visible from any page (dashboard/drafts/replies), not just
// the one that triggered it. Work runs in the background; the HTTP
// request returns immediately.
webRouter.post('/discover', requireAuth, async (req, res, next) => {
  try {
    const count = Math.min(Number(req.body?.count) || 5, 10);
    const hint = (req.body?.hint || '').trim();
    const ownerId = req.session.userId;

    // Don't allow a user to kick off a second cycle while one is already running.
    const existing = await query(
      `SELECT id FROM discovery_jobs WHERE user_id = $1 AND status = 'running' LIMIT 1`,
      [ownerId]
    );
    if (existing.rows[0]) {
      return res.redirect('/drafts');
    }

    const { rows } = await query(
      `INSERT INTO discovery_jobs (user_id, status, requested_count)
       VALUES ($1, 'running', $2) RETURNING id`,
      [ownerId, count]
    );
    const jobId = rows[0].id;

    // Fire and forget — don't await. Node keeps the promise alive.
    runDiscoveryCycle({ count, hint, owner_user_id: ownerId, job_id: jobId })
      .then((r) => console.log('[discover] cycle finished:', r))
      .catch((err) => {
        console.error('[discover] cycle crashed:', err);
        query(
          `UPDATE discovery_jobs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
          [jobId, err.message || 'unknown']
        ).catch(() => {});
      });

    res.redirect('/drafts');
  } catch (err) {
    next(err);
  }
});

// Researched prospects log — every prospect we've seen, whether drafted or
// not, so the operator can tell "did the agent look at this company?"
webRouter.get('/prospects', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id, p.company, p.domain, p.contact_name, p.contact_title,
              p.industry, p.persona, p.seniority, p.fit_score,
              p.timing_signal, p.timing_signal_source,
              p.disqualified, p.disqualify_reason, p.researched_at,
              EXISTS(
                SELECT 1 FROM approval_queue aq
                 WHERE aq.prospect_id = p.id AND aq.status = 'pending'
              ) AS has_pending_draft,
              EXISTS(
                SELECT 1 FROM approval_queue aq
                 WHERE aq.prospect_id = p.id AND aq.status = 'approved'
              ) AS has_approved_draft
         FROM prospects p
        WHERE p.owner_user_id = $1 OR p.owner_user_id IS NULL
        ORDER BY p.researched_at DESC NULLS LAST
        LIMIT 200`,
      [req.session.userId]
    );
    res.render('prospects_list', { title: 'Prospects', prospects: rows });
  } catch (err) {
    next(err);
  }
});

// Discovery run history — so failures, empty runs, and low-fit-score skips
// are visible after the transient banner expires.
webRouter.get('/discovery', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, status, requested_count, discovered_count, drafted_count,
              skipped_count, error, started_at, finished_at, diagnostics,
              EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int AS duration_sec
         FROM discovery_jobs
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [req.session.userId]
    );
    res.render('discovery_list', { title: 'Discovery runs', runs: rows });
  } catch (err) {
    next(err);
  }
});

// Force-cancel a stuck discovery job so the user can retry. Doesn't actually
// kill the background promise (Node can't from here), but clearing the row
// lets them kick off a fresh cycle.
webRouter.post('/discover/cancel', requireAuth, async (req, res, next) => {
  try {
    await query(
      `UPDATE discovery_jobs SET status = 'failed', error = 'cancelled by user', finished_at = NOW()
        WHERE user_id = $1 AND status = 'running'`,
      [req.session.userId]
    );
    res.redirect('/drafts');
  } catch (err) {
    next(err);
  }
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

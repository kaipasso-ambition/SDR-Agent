// Server-rendered web UI routes. All require auth except /login.

import { Router } from 'express';
import { verifyLogin, requireAuth } from '../auth.js';
import { query } from '../db/index.js';
import { getPendingDrafts, getPendingReplies } from '../queue/approval_queue.js';
import { researchAndDraft, runDiscoveryCycle, runPilotBatch, draftChampionReconnect, draftLaunchIntro, draftFromSignal } from '../pipeline.js';
import { PILOT_BATCH } from '../lib/pilot_batch.js';
import { parsePastedCsv } from '../lib/paste_csv.js';
import {
  ingestChampionCsv,
  listChampions,
  listPendingMoves,
  countPendingMoves,
  setMoveStatus,
} from '../db/champions.js';
import {
  ingestAccountCsv,
  listAccounts,
  listChurnedWithWinbackContext,
  getAccountStatusCounts,
  getAccountBundle,
  getCoverageByAccount,
  clearAllAccounts,
  updateAccountNotes,
} from '../db/accounts_registry.js';
import { PERSONAS } from '../lib/personas.js';
import { runChampionCheckCycle } from '../agents/champion_tracker.js';
import { runSignalScanCycle } from '../agents/signal_analyzer.js';
import {
  getSignalsForBrief,
  getSignalById,
  acknowledgeSignal,
  dismissSignal,
  setSignalPlaying,
  restoreSignal,
  getSignalCounts,
  getLastScanForAccount,
} from '../db/signals.js';
import {
  getPresenceFeed,
  getPresenceStats,
  markPosted,
  markSkipped,
  setThumbs,
  startPresenceJob,
  finishPresenceJob,
  failPresenceJob,
  getLatestPresenceJob,
} from '../db/presence.js';
import { pollPresenceInbox } from '../integrations/gmail_imap.js';
import { runRankerCycle } from '../lib/presence_ranker.js';
import {
  listContactsForAccount,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  listHypothesesForAccount,
  getHypothesisById,
  createHypothesis,
  updateHypothesis,
  deleteHypothesis,
  listPlaysForAccount,
  listPlaysForUser,
  getPlayById,
  createPlay,
  updatePlay,
  deletePlay,
  countActivePlays,
} from '../db/game_plan.js';
import {
  listEvents,
  getEventById,
  listPlaysForEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  setResearchStatus,
} from '../db/play_events.js';
import {
  listAttendeesForEvent,
  getAttendeeById,
  createAttendee,
  bulkCreateAttendees,
  updateAttendee,
  deleteAttendee,
  findAccountIdForCompany,
} from '../db/event_attendees.js';
import { buildPlay } from '../agents/play_builder.js';
import { runEventResearch } from '../agents/event_researcher.js';
import {
  draftSessionInvite,
  draftMeetingRequest,
} from '../agents/event_outreach_writer.js';

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

webRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const counts = await getCounts(req.session.userId);
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

// One-shot pilot-batch page: preview the 10 hand-picked prospects and, on
// click, kick them all through research+draft at 5-way parallelism. Exists so
// we can validate the full pipeline end-to-end on known-good picks without
// burning discovery credits.
webRouter.get('/prospects/import', requireAuth, async (req, res, next) => {
  try {
    // ?limit=N caps how many of the pre-sorted batch actually run. Batch is
    // ordered strongest-signal first, alternating owners, so limit=4 picks
    // the top 2 per rep.
    const raw = Number(req.query.limit);
    const queryLimit = Number.isFinite(raw) && raw > 0 && raw <= PILOT_BATCH.length ? raw : null;

    // Owner-resolution lookup always uses the full roster — we flag unresolved
    // owners regardless of limit so the operator sees the problem before it
    // bites them on the next run.
    const uniqueOwners = [...new Set(PILOT_BATCH.map((p) => p.owner_name))];
    const ownerStatus = {};
    for (const name of uniqueOwners) {
      const { rows } = await query(
        `SELECT email, name FROM users WHERE LOWER(name) LIKE $1 OR LOWER(email) LIKE $1 LIMIT 1`,
        [name.toLowerCase() + '%']
      );
      ownerStatus[name] = rows[0] || null;
    }

    // Running pilot job (if any) so we can lock the highlighted rows to what
    // is actually in flight. Detection key is diagnostics->>'pilot_batch' =
    // 'true' — we stamp that on the INSERT now, along with the chosen
    // indices, so the in-flight page can reflect the real selection instead
    // of falling back to a top-N slice.
    const runningPilot = (await query(
      `SELECT id, requested_count, started_at, diagnostics
         FROM discovery_jobs
        WHERE user_id = $1 AND status = 'running'
          AND diagnostics->>'pilot_batch' = 'true'
        ORDER BY started_at DESC LIMIT 1`,
      [req.session.userId]
    )).rows[0] || null;

    // Persisted selection: the POST handler stores indices in
    // diagnostics.pilot_indices. Absent or empty array → fall back to the
    // top-N view driven by requested_count (legacy path).
    const runningPilotIndices = Array.isArray(runningPilot?.diagnostics?.pilot_indices)
      ? runningPilot.diagnostics.pilot_indices.map(Number).filter(Number.isFinite)
      : null;

    const recentJob = (await query(
      `SELECT id, status, started_at, finished_at, drafted_count, skipped_count,
              discovered_count, error, diagnostics,
              EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int AS duration_sec
         FROM discovery_jobs
        WHERE user_id = $1 AND diagnostics->>'pilot_batch' = 'true'
        ORDER BY started_at DESC LIMIT 1`,
      [req.session.userId]
    )).rows[0] || null;

    // Row-level active flag. If we have persisted pilot indices (running job
    // or if we later add recentJob indices), use them verbatim — that's
    // what the operator actually picked. Otherwise fall back to top-N.
    let activeSet = null;
    if (runningPilotIndices && runningPilotIndices.length > 0) {
      activeSet = new Set(runningPilotIndices);
    }
    const activeCount = activeSet
      ? activeSet.size
      : (runningPilot?.requested_count ?? queryLimit ?? PILOT_BATCH.length);
    const batch = PILOT_BATCH.map((p, i) => ({
      ...p,
      active: activeSet ? activeSet.has(i) : (i < activeCount),
    }));

    res.render('prospects_import', {
      title: 'Pilot batch',
      batch,
      fullBatchSize: PILOT_BATCH.length,
      activeCount,
      limit: queryLimit,
      runningPilot,
      ownerStatus,
      recentJob,
    });
  } catch (err) {
    next(err);
  }
});

webRouter.post('/prospects/import', requireAuth, async (req, res, next) => {
  try {
    const ownerId = req.session.userId;

    // Selection priority: explicit checkbox list (selected[]) > legacy limit
    // (top-N slice) > full batch. Checkboxes submit as either a single string
    // or an array depending on how many were ticked, so normalize both.
    const rawSelected = req.body?.selected;
    const selectedArr = Array.isArray(rawSelected)
      ? rawSelected
      : (rawSelected != null ? [rawSelected] : []);
    const indices = selectedArr
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < PILOT_BATCH.length);

    // Keep legacy ?limit= path working for anyone who bookmarked it.
    const rawLimit = Number(req.body?.limit ?? req.query?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= PILOT_BATCH.length ? rawLimit : null;

    const runCount = indices.length > 0 ? indices.length : (limit ?? PILOT_BATCH.length);

    if (runCount === 0) {
      // No selection at all — bounce back with nothing to do.
      return res.redirect('/prospects/import');
    }

    const existing = await query(
      `SELECT id FROM discovery_jobs WHERE user_id = $1 AND status = 'running' LIMIT 1`,
      [ownerId]
    );
    if (existing.rows[0]) {
      return res.redirect('/prospects/import');
    }

    // Stamp pilot_batch + selected indices into diagnostics at INSERT time so
    // the GET route can (a) reliably detect a running pilot and (b) highlight
    // the exact rows the user ticked, not a misleading top-N slice. The
    // pipeline's final diagnostics write must preserve pilot_indices.
    const diagnosticsSeed = {
      pilot_batch: true,
      pilot_indices: indices.length > 0 ? indices : null,
    };
    const { rows } = await query(
      `INSERT INTO discovery_jobs (user_id, status, requested_count, diagnostics)
       VALUES ($1, 'running', $2, $3::jsonb) RETURNING id`,
      [ownerId, runCount, JSON.stringify(diagnosticsSeed)]
    );
    const jobId = rows[0].id;

    // Fire and forget — HTTP returns immediately, the banner tracks progress.
    runPilotBatch({ job_id: jobId, limit, indices: indices.length > 0 ? indices : null })
      .then((r) => console.log('[pilot] batch finished:', r.drafted, 'drafted'))
      .catch((err) => {
        console.error('[pilot] batch crashed:', err);
        query(
          `UPDATE discovery_jobs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
          [jobId, err.message || 'unknown']
        ).catch(() => {});
      });

    res.redirect('/prospects/import');
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

// ---------- Presence copilot ----------

webRouter.get('/presence', requireAuth, async (_req, res, next) => {
  try {
    const [feed, stats, activePresenceJob] = await Promise.all([
      getPresenceFeed({ limit: 30 }),
      getPresenceStats(),
      getLatestPresenceJob(),
    ]);
    res.render('presence', { title: 'Presence', feed, stats, activePresenceJob });
  } catch (err) {
    next(err);
  }
});

// Manual trigger: pull new Sales Nav digests and rank immediately. Fire-and-
// forget, but we log each run as a presence_refresh_jobs row so the view can
// render a "Refreshing…" banner until the work finishes. If a job is already
// running we skip starting a second one — prevents the user hammering the
// button from queueing up duplicate work.
webRouter.post('/presence/refresh', requireAuth, async (req, res) => {
  try {
    const existing = await getLatestPresenceJob();
    if (existing && existing.status === 'running') {
      // Don't start a second job — the banner will show the one in flight.
      return res.redirect('/presence');
    }
    const job = await startPresenceJob({ userId: req.session?.userId || null });

    // Run the actual work in the background and update the job row as we go.
    Promise.resolve()
      .then(async () => {
        const poll = await pollPresenceInbox();
        console.log('[presence/refresh] poll result:', poll);
        const rank = await runRankerCycle();
        console.log('[presence/refresh] rank result:', rank);
        await finishPresenceJob(job.id, {
          emails_seen: poll.emails_seen,
          posts_upserted: poll.posts_upserted,
          posts_new: poll.posts_new,
          drafted: rank.drafted,
          skipped: rank.skipped,
          errored: rank.errored,
        });
      })
      .catch(async (err) => {
        console.error('[presence/refresh] failed:', err);
        try { await failPresenceJob(job.id, err.message || String(err)); } catch (_) {}
      });

    res.redirect('/presence');
  } catch (err) {
    console.error('[presence/refresh] route error:', err);
    res.redirect('/presence');
  }
});

webRouter.post('/presence/:id/posted', requireAuth, async (req, res, next) => {
  try {
    await markPosted(req.params.id);
    res.redirect('/presence');
  } catch (err) {
    next(err);
  }
});

webRouter.post('/presence/:id/skip', requireAuth, async (req, res, next) => {
  try {
    await markSkipped(req.params.id);
    res.redirect('/presence');
  } catch (err) {
    next(err);
  }
});

webRouter.post('/presence/:id/thumbs', requireAuth, async (req, res, next) => {
  try {
    const thumbs = req.body?.thumbs === 'up' ? 'up' : req.body?.thumbs === 'down' ? 'down' : null;
    await setThumbs(req.params.id, { thumbs, note: req.body?.note || null });
    res.redirect('/presence');
  } catch (err) {
    next(err);
  }
});

// ---------- Champions + Accounts (Strategic-AE track) ----------

// Stash import results on the session so the next GET can render per-row
// feedback. Cleared after one render so it doesn't stick around.
function flashImport(req, key, results) {
  req.session = req.session || {};
  req.session[key] = results;
}
function popImport(req, key) {
  const v = req.session?.[key] || null;
  if (req.session) delete req.session[key];
  return v;
}

// /champions is gated behind an ?unlock= query param while the security
// review for PII handling is in flight. The tables, routes, cron, and agent
// all exist — we just don't surface the UI until access control, log
// scrubbing, and an explicit delete/DNC flow are in place. Anyone hitting
// the bare URL gets the placeholder; testing is possible via ?unlock=1.
webRouter.get('/champions', requireAuth, async (req, res, next) => {
  if (req.query.unlock !== '1') {
    return res.render('champions_placeholder', { title: 'Champions' });
  }
  try {
    const ownerId = req.session.userId;
    const [champions, pendingMoves, newMoveCount, activeJobRow] = await Promise.all([
      listChampions({ ownerUserId: ownerId }),
      listPendingMoves({ ownerUserId: ownerId }),
      countPendingMoves(ownerId),
      query(`SELECT * FROM champion_check_jobs ORDER BY started_at DESC LIMIT 1`),
    ]);

    const activeJob = activeJobRow.rows[0] || null;
    const runningJob = activeJob && activeJob.status === 'running';

    const drafted = pendingMoves.filter((m) => m.status === 'drafted').length;
    const tracking = champions.filter((c) => c.status === 'tracking').length;
    const lastChecks = champions.map((c) => c.last_checked_at).filter(Boolean);
    const lastCheck = lastChecks.length ? new Date(Math.max(...lastChecks.map((d) => new Date(d).getTime()))) : null;

    res.render('champions', {
      title: 'Champions',
      champions,
      pendingMoves,
      runningJob,
      activeJob,
      counts: {
        tracking,
        newMoves: newMoveCount,
        drafted,
        lastCheckLabel: lastCheck ? lastCheck.toLocaleString() : 'never — click "Check for moves now"',
      },
      importResults: popImport(req, 'championsImport'),
    });
  } catch (err) {
    next(err);
  }
});

webRouter.post('/champions/import', requireAuth, async (req, res, next) => {
  try {
    const { rows } = parsePastedCsv(req.body?.csv || '');
    if (rows.length === 0) {
      flashImport(req, 'championsImport', [{ index: 0, ok: false, errors: ['nothing to import — paste a header row + at least one data row'] }]);
      return res.redirect('/champions');
    }
    const results = await ingestChampionCsv(rows);
    flashImport(req, 'championsImport', results);
    res.redirect('/champions');
  } catch (err) {
    next(err);
  }
});

// Trigger an on-demand champion check. Fires in the background; the banner
// on /champions polls via page reload.
webRouter.post('/champions/check-now', requireAuth, async (req, res, next) => {
  try {
    const existing = await query(
      `SELECT id FROM champion_check_jobs WHERE status = 'running' LIMIT 1`
    );
    if (existing.rows[0]) return res.redirect('/champions');

    const { rows } = await query(
      `INSERT INTO champion_check_jobs (user_id, status) VALUES ($1, 'running') RETURNING id`,
      [req.session.userId]
    );
    const jobId = rows[0].id;

    runChampionCheckCycle({ limit: 25, job_id: jobId })
      .then((r) => console.log('[champions/check-now] finished:', r))
      .catch((err) => {
        console.error('[champions/check-now] failed:', err);
        query(
          `UPDATE champion_check_jobs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
          [jobId, err.message || 'unknown']
        ).catch(() => {});
      });

    res.redirect('/champions');
  } catch (err) {
    next(err);
  }
});

// Act on a single detected move: generate the reconnect draft and queue it.
webRouter.post('/champions/moves/:id/draft', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.*, c.full_name, c.email, c.linkedin_url, c.source, c.tier,
              c.one_line_context
         FROM champion_moves m
         JOIN champions c ON c.id = m.champion_id
        WHERE m.id = $1 LIMIT 1`,
      [req.params.id]
    );
    const move = rows[0];
    if (!move) return res.redirect('/champions');

    const result = await draftChampionReconnect(move);
    if (result.draft) {
      console.log(`[champions] drafted reconnect for ${move.full_name} → ${move.to_company}`);
      return res.redirect('/drafts');
    }
    console.log(`[champions] skipped draft for move ${move.id}: ${result.skipped}`);
    res.redirect('/champions');
  } catch (err) {
    console.error('[champions/moves/draft]', err);
    res.redirect('/champions');
  }
});

webRouter.post('/champions/moves/:id/dismiss', requireAuth, async (req, res, next) => {
  try {
    await setMoveStatus(req.params.id, 'dismissed');
    res.redirect('/champions');
  } catch (err) {
    next(err);
  }
});

webRouter.get('/accounts', requireAuth, async (req, res, next) => {
  try {
    const filter = ['customer', 'prospect', 'churned', 'disqualified'].includes(req.query.status)
      ? req.query.status : null;

    // Churned accounts get their own focused view: the goal there is
    // always "what's the best play to run, and which prospects or
    // champions can we resurface?" — a generic list column doesn't
    // capture that. We render accounts_churned.ejs with an enriched
    // per-account context bundle (active play, champion count,
    // prospect count at the domain, recent offense signal count).
    if (filter === 'churned') {
      const [rows, counts] = await Promise.all([
        listChurnedWithWinbackContext(),
        getAccountStatusCounts(),
      ]);
      return res.render('accounts_churned', {
        title: 'Churned — win-back',
        rows,
        counts,
      });
    }

    // readiness=not_ready surfaces only customers missing persona coverage
    // for the May 15 launch. Implicitly forces the status filter to customer.
    const readinessFilter = req.query.readiness === 'not_ready' ? 'not_ready' : null;
    const effectiveStatus = readinessFilter ? 'customer' : filter;

    const [accountsRaw, counts, coverageByAccount] = await Promise.all([
      listAccounts({ status: effectiveStatus }),
      getAccountStatusCounts(),
      getCoverageByAccount(),
    ]);

    // Decorate each account with its readiness row so the list can show a
    // launch-ready pill + gap count inline.
    const accounts = accountsRaw.map((a) => {
      const cov = coverageByAccount[a.id];
      return {
        ...a,
        launchReady: cov?.ready ?? null,
        launchGaps: cov?.gaps ?? null,
      };
    }).filter((a) => !readinessFilter || a.launchReady === false);

    // Launch-readiness rollup across all customers (ignores any active filter
    // so the stat card always tells the truth).
    const customerIds = Object.keys(coverageByAccount);
    const launchReadyCount = customerIds.filter((id) => coverageByAccount[id].ready).length;
    const launchGapCount = customerIds.length - launchReadyCount;

    res.render('accounts', {
      title: 'Accounts',
      accounts,
      counts,
      filter,
      readinessFilter,
      launchReadiness: {
        total: customerIds.length,
        ready: launchReadyCount,
        gaps: launchGapCount,
      },
      importResults: popImport(req, 'accountsImport'),
    });
  } catch (err) {
    next(err);
  }
});

webRouter.post('/accounts/import', requireAuth, async (req, res, next) => {
  try {
    const { rows } = parsePastedCsv(req.body?.csv || '');
    if (rows.length === 0) {
      flashImport(req, 'accountsImport', [{ index: 0, ok: false, errors: ['nothing to import'] }]);
      return res.redirect('/accounts');
    }
    const results = await ingestAccountCsv(rows);
    flashImport(req, 'accountsImport', results);
    res.redirect('/accounts');
  } catch (err) {
    next(err);
  }
});

// Wipe the entire accounts book. Destructive + fast to call, so we require
// the operator to type the confirm string in the UI; the server re-checks it
// as a belt-and-braces so a malformed POST can't nuke the table.
webRouter.post('/accounts/clear', requireAuth, async (req, res, next) => {
  try {
    if ((req.body?.confirm || '').trim().toUpperCase() !== 'CLEAR') {
      flashImport(req, 'accountsImport', [{ index: 0, ok: false, errors: ['clear cancelled — confirmation string did not match'] }]);
      return res.redirect('/accounts');
    }
    const removed = await clearAllAccounts();
    flashImport(req, 'accountsImport', [{ index: 0, ok: true, inserted: false, name: `cleared ${removed} account${removed === 1 ? '' : 's'}`, status: 'removed' }]);
    res.redirect('/accounts');
  } catch (err) {
    next(err);
  }
});

// Account detail page — the Strategic-AE's home base for one company. Pulls
// the registry row + every prospect we've researched with that domain + the
// drafts + sent messages against those prospects + a champion-count summary
// (no PII at the account level, just "3 customer_champion, 1 FoA").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
webRouter.get('/accounts/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const includeArchive = req.query?.archive === '1';
    const bundle = await getAccountBundle(req.params.id, { includeArchive });
    if (!bundle) return res.redirect('/accounts');
    res.render('account_detail', {
      title: bundle.account.account_name,
      personas: PERSONAS,
      rescanStatus: typeof req.query?.rescan === 'string' ? req.query.rescan : null,
      archiveOpen: includeArchive,
      ...bundle,
    });
  } catch (err) {
    next(err);
  }
});

// Draft a May 15 launch intro to a specific persona at this customer
// account. Click target for every cell of the whitespace map. Fires
// synchronously (generateSequence is one Claude call, a few seconds) and
// redirects to /drafts so the AE sees the new row immediately.
webRouter.post('/accounts/:id/draft-launch', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const personaId = (req.body?.persona || '').trim();
    const prospectId = (req.body?.prospect_id || '').trim() || null;
    if (!PERSONAS.some((p) => p.id === personaId)) {
      return res.redirect(`/accounts/${req.params.id}`);
    }
    const result = await draftLaunchIntro({
      account_id: req.params.id,
      persona_id: personaId,
      prospect_id: prospectId && UUID_RE.test(prospectId) ? prospectId : null,
      owner_user_id: req.session.userId,
    });
    if (result.skipped) {
      console.log(`[accounts/draft-launch] skipped: ${result.skipped}`);
      return res.redirect(`/accounts/${req.params.id}`);
    }
    res.redirect('/drafts');
  } catch (err) {
    console.error('[accounts/draft-launch]', err);
    next(err);
  }
});

// Update the editable notes on an account. The notes feed the signal
// analyzer's per-account context block so the AE can seed "SDR team uses
// us, want Ascend AE expansion" without re-typing every scan.
webRouter.post('/accounts/:id/notes', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    // 4000 char soft cap — anything bigger is going to blow the prompt budget
    const clipped = notes.slice(0, 4000);
    await updateAccountNotes(req.params.id, clipped);
    res.redirect(`/accounts/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Signals (Sprint 1: Pulse + Monday Brief) ----------

// Monday Brief — top 5 ranked unacked signals for the current user.
// Ranked risk-first (defense > offense > neutral), severity-weighted,
// recency as tiebreak. See src/db/signals.js for the exact SQL ordering.
webRouter.get('/brief', requireAuth, async (req, res, next) => {
  try {
    const [signals, counts, activeJobRow] = await Promise.all([
      getSignalsForBrief(req.session.userId, { limit: 100 }),
      getSignalCounts(req.session.userId),
      query(`SELECT * FROM account_signal_jobs ORDER BY started_at DESC LIMIT 1`),
    ]);
    const activeJob = activeJobRow.rows[0] || null;
    const runningJob = activeJob && activeJob.status === 'running';
    res.render('brief', {
      title: 'Monday Brief',
      signals,
      counts,
      activeJob,
      runningJob,
    });
  } catch (err) {
    next(err);
  }
});

// Signal staging page — surfaces the signal summary and three CTAs.
// Only "Draft outbound" is wired end-to-end in Sprint 1; the other two
// transition the signal to status='playing' with a "coming soon" hint.
webRouter.get('/signals/:id/stage', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/brief');
    const signal = await getSignalById(req.params.id);
    if (!signal) return res.redirect('/brief');
    res.render('signal_staging', {
      title: 'Start a play',
      signal,
      comingSoon: req.query?.coming_soon === '1',
    });
  } catch (err) {
    next(err);
  }
});

webRouter.post('/signals/:id/ack', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/brief');
    await acknowledgeSignal(req.params.id);
    res.redirect(req.body?.back || '/brief');
  } catch (err) {
    next(err);
  }
});

webRouter.post('/signals/:id/dismiss', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/brief');
    await dismissSignal(req.params.id);
    res.redirect(req.body?.back || '/brief');
  } catch (err) {
    next(err);
  }
});

// Bring an archived signal back into the active list. Used when a newer
// related signal lands on the same account and the AE wants the older
// context back in view.
webRouter.post('/signals/:id/restore', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/brief');
    await restoreSignal(req.params.id);
    res.redirect(req.body?.back || '/brief');
  } catch (err) {
    next(err);
  }
});

// "Play" handler — branches on the action. draft_outbound is the only
// end-to-end wire; the others are Sprint 3 placeholders that mark the
// signal as 'playing' so the AE knows they chose a direction.
webRouter.post('/signals/:id/play', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/brief');
    const action = (req.body?.action || '').trim();
    const signal = await getSignalById(req.params.id);
    if (!signal) return res.redirect('/brief');

    if (action === 'draft_outbound') {
      await setSignalPlaying(signal.id);
      await draftFromSignal({ signal, owner_user_id: req.session.userId });
      return res.redirect('/drafts');
    }

    if (action === 'internal_intro' || action === 'meeting_prep') {
      // Sprint 3 stub: mark playing + redirect back with a flash note.
      await setSignalPlaying(signal.id);
      return res.redirect(`/signals/${signal.id}/stage?coming_soon=1`);
    }

    res.redirect(`/signals/${signal.id}/stage`);
  } catch (err) {
    console.error('[signals/play]', err);
    next(err);
  }
});

// ============================================================================
// Game Plan — /accounts/:id/plan + contacts/hypotheses/plays CRUD
//
// Shared scope: plays and hypotheses are team-visible on the account
// (per design decision). author_user_id is captured so we can attribute
// but access checks only gate by account visibility.
// ============================================================================

// Extract the three-beat narrative (current_state / future_state / bridge)
// from a form body. Returns:
//   undefined — no narrative fields were submitted at all (don't touch column)
//   null      — all three beats were submitted empty (clear the column)
//   object    — at least one beat has content (persist as JSONB)
// Kept out of the route body so create and update share the exact rules.
function pickNarrative(body) {
  if (!body) return undefined;
  const hasAny =
    body.narrative_current_state !== undefined ||
    body.narrative_future_state !== undefined ||
    body.narrative_bridge !== undefined;
  if (!hasAny) return undefined;
  const current_state = (body.narrative_current_state || '').trim();
  const future_state = (body.narrative_future_state || '').trim();
  const bridge = (body.narrative_bridge || '').trim();
  if (!current_state && !future_state && !bridge) return null;
  return { current_state, future_state, bridge };
}

// Plan view — the chess board (org chart), hypotheses, and plays for one
// account. Pre-fills the play composer when called with
// ?new_play=1&signal=<id> from the /brief Start-a-play button.
webRouter.get('/accounts/:id/plan', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const accountId = req.params.id;
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return res.redirect('/accounts');

    const [contacts, hypotheses, plays, events] = await Promise.all([
      listContactsForAccount(accountId),
      listHypothesesForAccount(accountId),
      listPlaysForAccount(accountId),
      listEvents({ includeCompleted: false }),
    ]);

    // If the Start-a-play button handed us a signal_id, hydrate it so
    // the composer can show "triggered by: <signal title>".
    const triggerSignalId = typeof req.query?.signal === 'string' ? req.query.signal : null;
    const triggerSignal = triggerSignalId && UUID_RE.test(triggerSignalId)
      ? await getSignalById(triggerSignalId)
      : null;

    res.render('account_plan', {
      title: `${bundle.account.account_name} — Plan`,
      account: bundle.account,
      contacts,
      hypotheses,
      plays,
      events,
      pulseSignals: bundle.signals,
      triggerSignal,
      composerOpen: req.query?.new_play === '1',
      personas: PERSONAS,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Contacts ----------

webRouter.post('/accounts/:id/contacts', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const name = (req.body?.name || '').trim();
    if (!name) return res.redirect(`/accounts/${req.params.id}/plan`);
    await createContact({
      account_id: req.params.id,
      name,
      title: (req.body?.title || '').trim() || null,
      email: (req.body?.email || '').trim() || null,
      linkedin_url: (req.body?.linkedin_url || '').trim() || null,
      deal_role: req.body?.deal_role || 'unknown',
      stance: req.body?.stance || 'neutral',
      reports_to_contact_id: req.body?.reports_to_contact_id && UUID_RE.test(req.body.reports_to_contact_id)
        ? req.body.reports_to_contact_id
        : null,
      notes: (req.body?.notes || '').trim() || null,
      created_by_user_id: req.session.userId,
    });
    res.redirect(`/accounts/${req.params.id}/plan`);
  } catch (err) {
    next(err);
  }
});

// Movable. Accepts any subset of the editable fields; undefined fields
// stay put. Handles re-role, re-stance, re-parent in one route.
webRouter.post('/contacts/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const contact = await getContactById(req.params.id);
    if (!contact) return res.redirect('/accounts');

    // Special case: re-parenting to self or a descendant would create a
    // cycle. Cheapest defense: disallow re-parenting to self. Broader
    // descendant-cycle detection deferred — at AE scale the tree is <50 nodes
    // and the editor will make cycles visually obvious.
    const patch = {};
    for (const k of ['name', 'title', 'email', 'linkedin_url', 'deal_role', 'stance', 'notes']) {
      if (req.body?.[k] !== undefined) patch[k] = req.body[k] || null;
    }
    if (req.body?.reports_to_contact_id !== undefined) {
      const v = req.body.reports_to_contact_id;
      if (!v || v === '') patch.reports_to_contact_id = null;
      else if (UUID_RE.test(v) && v !== contact.id) patch.reports_to_contact_id = v;
    }
    await updateContact(contact.id, patch);
    res.redirect(`/accounts/${contact.account_id}/plan`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/contacts/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const contact = await getContactById(req.params.id);
    if (!contact) return res.redirect('/accounts');
    await deleteContact(contact.id);
    res.redirect(`/accounts/${contact.account_id}/plan`);
  } catch (err) {
    next(err);
  }
});

// ---------- Hypotheses ----------

webRouter.post('/accounts/:id/hypotheses', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const use_case = (req.body?.use_case || '').trim();
    const target_persona_id = (req.body?.target_persona_id || '').trim();
    const narrative_hook = (req.body?.narrative_hook || '').trim();
    if (!use_case || !target_persona_id || !narrative_hook) {
      return res.redirect(`/accounts/${req.params.id}/plan`);
    }
    const evidence_signal_ids = []
      .concat(req.body?.evidence_signal_ids || [])
      .filter((v) => typeof v === 'string' && UUID_RE.test(v));
    // Three-beat narrative (Nasralla): current_state / future_state / bridge.
    // All three beats are optional individually; we only persist the object
    // if at least one beat has content so the hypothesis card knows whether
    // to render the narrative block.
    const narrative = pickNarrative(req.body);
    await createHypothesis({
      account_id: req.params.id,
      use_case,
      target_persona_id,
      narrative_hook,
      narrative,
      evidence_signal_ids,
      confidence: parseInt(req.body?.confidence, 10) || 3,
      status: req.body?.status || 'theory',
      created_by_user_id: req.session.userId,
    });
    res.redirect(`/accounts/${req.params.id}/plan`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/hypotheses/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const h = await getHypothesisById(req.params.id);
    if (!h) return res.redirect('/accounts');
    const patch = {};
    for (const k of ['use_case', 'target_persona_id', 'narrative_hook', 'status']) {
      if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    if (req.body?.confidence !== undefined) {
      const n = parseInt(req.body.confidence, 10);
      if (n >= 1 && n <= 5) patch.confidence = n;
    }
    const narrative = pickNarrative(req.body);
    if (narrative !== undefined) patch.narrative = narrative;
    await updateHypothesis(h.id, patch);
    res.redirect(`/accounts/${h.account_id}/plan`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/hypotheses/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const h = await getHypothesisById(req.params.id);
    if (!h) return res.redirect('/accounts');
    await deleteHypothesis(h.id);
    res.redirect(`/accounts/${h.account_id}/plan`);
  } catch (err) {
    next(err);
  }
});

// ---------- Plays ----------

// Compose a new play. Inserts with the AE's instinct immediately, then
// synchronously calls buildPlay (≤15s) so the expansion lands before the
// redirect. If Claude fails, the play persists with ai_expansion=null and
// the view surfaces a "Rebuild expansion" button.
webRouter.post('/accounts/:id/plays', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const accountId = req.params.id;
    const instinct = (req.body?.instinct || '').trim();
    if (!instinct) return res.redirect(`/accounts/${accountId}/plan`);

    const hypothesis_id = req.body?.hypothesis_id && UUID_RE.test(req.body.hypothesis_id)
      ? req.body.hypothesis_id
      : null;
    const triggered_by_signal_id = req.body?.triggered_by_signal_id && UUID_RE.test(req.body.triggered_by_signal_id)
      ? req.body.triggered_by_signal_id
      : null;
    const event_id = req.body?.event_id && UUID_RE.test(req.body.event_id)
      ? req.body.event_id
      : null;
    const contact_path = []
      .concat(req.body?.contact_path || [])
      .filter((v) => typeof v === 'string' && UUID_RE.test(v));
    // Personal-invite picks. Only contacts that are ALSO on the
    // contact_path can be invited — the invite is always carried by
    // someone the play already threads through. We re-validate that
    // below after fetching the account's contacts.
    const personal_invite_contact_ids_raw = []
      .concat(req.body?.personal_invite_contact_ids || [])
      .filter((v) => typeof v === 'string' && UUID_RE.test(v));

    // Create first with no expansion, then fill in — keeps the DB row
    // durable even if the Claude call throws.
    const play = await createPlay({
      account_id: accountId,
      hypothesis_id,
      triggered_by_signal_id,
      event_id,
      author_user_id: req.session.userId,
      instinct,
      contact_path,
      personal_invite_contact_ids: personal_invite_contact_ids_raw,
      status: 'drafting',
    });

    try {
      const [account, hypothesis, signal, allContacts, priorPlays, eventCtx] = await Promise.all([
        (async () => (await getAccountBundle(accountId))?.account)(),
        hypothesis_id ? getHypothesisById(hypothesis_id) : null,
        triggered_by_signal_id ? getSignalById(triggered_by_signal_id) : null,
        listContactsForAccount(accountId),
        listPlaysForAccount(accountId),
        event_id ? getEventById(event_id) : null,
      ]);
      const byId = new Map(allContacts.map((c) => [c.id, c]));
      const contact_path_resolved = contact_path.map((id) => byId.get(id)).filter(Boolean);
      const personal_invites_resolved = personal_invite_contact_ids_raw
        .map((id) => byId.get(id)).filter(Boolean);
      const { expansion } = await buildPlay({
        account,
        instinct,
        hypothesis,
        contact_path_resolved,
        triggering_signal: signal,
        event: eventCtx,
        personal_invites: personal_invites_resolved,
        prior_plays: priorPlays
          .filter((p) => p.id !== play.id)
          .map((p) => ({
            named_play: p.ai_expansion?.named_play || null,
            status: p.status,
          })),
      });
      if (expansion) {
        await updatePlay(play.id, { ai_expansion: expansion, status: 'active' });
      }
    } catch (err) {
      console.error('[plays/create] expansion failed:', err.message);
      // Leave as drafting; the UI will show "Rebuild".
    }

    // If a signal triggered the play, mark it 'playing' so /brief reflects.
    if (triggered_by_signal_id) {
      await setSignalPlaying(triggered_by_signal_id).catch(() => {});
    }

    res.redirect(`/accounts/${accountId}/plan#play-${play.id}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/plays/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const play = await getPlayById(req.params.id);
    if (!play) return res.redirect('/accounts');
    const patch = {};
    for (const k of ['instinct', 'status', 'next_action']) {
      if (req.body?.[k] !== undefined) patch[k] = req.body[k] || null;
    }
    if (req.body?.next_action_due !== undefined) {
      patch.next_action_due = req.body.next_action_due || null;
    }
    if (req.body?.hypothesis_id !== undefined) {
      const v = req.body.hypothesis_id;
      patch.hypothesis_id = v && UUID_RE.test(v) ? v : null;
    }
    if (req.body?.event_id !== undefined) {
      const v = req.body.event_id;
      patch.event_id = v && UUID_RE.test(v) ? v : null;
    }
    await updatePlay(play.id, patch);
    res.redirect(`/accounts/${play.account_id}/plan#play-${play.id}`);
  } catch (err) {
    next(err);
  }
});

// Re-run buildPlay on an existing play — useful when Claude failed on
// first compose, or when the AE edited the instinct and wants a fresh
// expansion.
webRouter.post('/plays/:id/rebuild', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const play = await getPlayById(req.params.id);
    if (!play) return res.redirect('/accounts');
    const accountId = play.account_id;
    const [account, hypothesis, signal, allContacts, priorPlays] = await Promise.all([
      (async () => (await getAccountBundle(accountId))?.account)(),
      play.hypothesis_id ? getHypothesisById(play.hypothesis_id) : null,
      play.triggered_by_signal_id ? getSignalById(play.triggered_by_signal_id) : null,
      listContactsForAccount(accountId),
      listPlaysForAccount(accountId),
    ]);
    const byId = new Map(allContacts.map((c) => [c.id, c]));
    const contact_path_resolved = (play.contact_path || [])
      .map((id) => byId.get(id))
      .filter(Boolean);
    const { expansion } = await buildPlay({
      account,
      instinct: play.instinct,
      hypothesis,
      contact_path_resolved,
      triggering_signal: signal,
      prior_plays: priorPlays
        .filter((p) => p.id !== play.id)
        .map((p) => ({ named_play: p.ai_expansion?.named_play || null, status: p.status })),
    });
    if (expansion) {
      await updatePlay(play.id, {
        ai_expansion: expansion,
        status: play.status === 'drafting' ? 'active' : play.status,
      });
    }
    res.redirect(`/accounts/${accountId}/plan#play-${play.id}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/plays/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const play = await getPlayById(req.params.id);
    if (!play) return res.redirect('/accounts');
    await deletePlay(play.id);
    res.redirect(`/accounts/${play.account_id}/plan`);
  } catch (err) {
    next(err);
  }
});

// ---------- Events / one-offs (Gartner, CVI dinner, launch campaigns) ----------
//
// Events are coordinating artifacts for plays that span many accounts
// — the Gartner CSO Summit, a CVI dinner, a themed outreach wave.
// Each account still gets its own account_plays row; event_id groups
// them. /events is the index, /events/:id is the roll-up.

webRouter.get('/events', requireAuth, async (req, res, next) => {
  try {
    const events = await listEvents({ includeCompleted: req.query.all === '1' });
    res.render('events', {
      title: 'Events',
      events,
      showAll: req.query.all === '1',
    });
  } catch (err) {
    next(err);
  }
});

webRouter.get('/events/new', requireAuth, (_req, res) => {
  res.render('event_new', { title: 'New event' });
});

webRouter.get('/events/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/events');
    const [event, plays, attendees] = await Promise.all([
      getEventById(req.params.id),
      listPlaysForEvent(req.params.id),
      listAttendeesForEvent(req.params.id),
    ]);
    if (!event) return res.redirect('/events');
    res.render('event_detail', {
      title: event.name,
      event,
      plays,
      attendees,
      openAttendeeId: typeof req.query.open === 'string' && UUID_RE.test(req.query.open)
        ? req.query.open : null,
    });
  } catch (err) {
    next(err);
  }
});

// Parse a textarea of links (one per line, comma-separated also OK) into
// a deduped array. Keep it permissive — the AE may paste URLs with
// trailing commas, parens, or query strings. We only strip whitespace.
function parseReferenceLinks(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const parts = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  // Dedup while preserving order.
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!/^https?:\/\//i.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

webRouter.post('/events', requireAuth, async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.redirect('/events/new');
    const reference_links = parseReferenceLinks(req.body?.reference_links);
    const speaking_note = (req.body?.speaking_note || '').trim() || null;
    const event = await createEvent({
      name,
      kind: ['event', 'campaign', 'one_off'].includes(req.body?.kind) ? req.body.kind : 'event',
      event_date: (req.body?.event_date || '').trim() || null,
      location: (req.body?.location || '').trim() || null,
      description: (req.body?.description || '').trim() || null,
      reference_links,
      status: ['planning', 'active', 'completed', 'cancelled'].includes(req.body?.status)
        ? req.body.status : 'planning',
      created_by_user_id: req.session.userId,
    });
    // If the AE handed over reference links OR a speaking-slot note,
    // kick off research in the background. The route returns fast; the
    // UI will flip from "pending → completed" on the next /events/:id
    // page load once the agent finishes (~30–60s typical).
    if (reference_links.length > 0 || speaking_note) {
      // Flip status to pending IMMEDIATELY so the redirected page shows
      // a spinner. runEventResearch will overwrite it when done.
      await setResearchStatus(event.id, 'pending').catch(() => {});
      runEventResearch(event.id, { speaking_note }).catch((err) => {
        console.error('[events/create] research kickoff failed:', err.message);
      });
    }
    res.redirect(`/events/${event.id}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/events/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/events');
    const event = await getEventById(req.params.id);
    if (!event) return res.redirect('/events');
    const patch = {};
    for (const k of ['name', 'kind', 'event_date', 'location', 'description', 'status']) {
      if (req.body?.[k] !== undefined) {
        const v = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
        patch[k] = v === '' ? null : v;
      }
    }
    if (req.body?.reference_links !== undefined) {
      patch.reference_links = parseReferenceLinks(req.body.reference_links);
    }
    await updateEvent(event.id, patch);
    res.redirect(`/events/${event.id}`);
  } catch (err) {
    next(err);
  }
});

// Manually (re-)research an event. Fires the researcher in the
// background and redirects. Accepts an optional speaking_note so the
// AE can steer the run ("our CEO is on stage at the 2pm session, very
// limited seating") without editing the event body.
webRouter.post('/events/:id/research', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/events');
    const event = await getEventById(req.params.id);
    if (!event) return res.redirect('/events');
    const speaking_note = (req.body?.speaking_note || '').trim() || null;
    await setResearchStatus(event.id, 'pending').catch(() => {});
    runEventResearch(event.id, { speaking_note }).catch((err) => {
      console.error(`[events/${event.id}/research] kickoff failed:`, err.message);
    });
    res.redirect(`/events/${event.id}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/events/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/events');
    await deleteEvent(req.params.id);
    res.redirect('/events');
  } catch (err) {
    next(err);
  }
});

// ---------- Event attendees (targets) ----------
//
// The attendee list is the event's execution surface. The AE pastes or
// manually adds people they're targeting, then works the list one row
// at a time: draft a session invite, draft a meeting request, flip
// status as things progress.

// Parse a pasted attendee list. Accepts tab- or comma-separated lines:
//   Name <TAB> Title <TAB> Company <TAB> LinkedIn <TAB> Email
// Missing trailing columns are fine. Commas inside a cell are NOT
// supported — paste tab-separated (copy from Sheets/Excel) to get full
// fidelity. A leading header row with "Name"/"Title"/etc. is skipped.
function parseAttendeeList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const sep = line.includes('\t') ? '\t' : ',';
    const parts = line.split(sep).map((p) => p.trim());
    // Skip header row.
    if (idx === 0 && /^name$/i.test(parts[0])) continue;
    if (!parts[0]) continue;
    out.push({
      name: parts[0],
      title: parts[1] || null,
      company: parts[2] || null,
      linkedin_url: parts[3] || null,
      email: parts[4] || null,
    });
  }
  return out;
}

webRouter.post('/events/:id/attendees', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/events');
    const event = await getEventById(req.params.id);
    if (!event) return res.redirect('/events');

    const pasted = (req.body?.paste_list || '').trim();
    if (pasted) {
      const rows = parseAttendeeList(pasted);
      await bulkCreateAttendees(event.id, rows, req.session.userId);
    } else {
      const name = (req.body?.name || '').trim();
      if (!name) return res.redirect(`/events/${event.id}`);
      await createAttendee({
        event_id: event.id,
        name,
        title: (req.body?.title || '').trim() || null,
        company: (req.body?.company || '').trim() || null,
        linkedin_url: (req.body?.linkedin_url || '').trim() || null,
        email: (req.body?.email || '').trim() || null,
        notes: (req.body?.notes || '').trim() || null,
        added_by_user_id: req.session.userId,
      });
    }
    res.redirect(`/events/${event.id}#attendees`);
  } catch (err) {
    next(err);
  }
});

// Update an attendee — used for status flips (target → invited → met)
// and manual corrections (fix title, re-link account).
webRouter.post('/events/:eid/attendees/:aid', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.eid) || !UUID_RE.test(req.params.aid)) {
      return res.redirect('/events');
    }
    const patch = {};
    for (const k of ['name', 'title', 'company', 'linkedin_url', 'email', 'notes', 'invite_draft', 'meeting_draft']) {
      if (req.body?.[k] !== undefined) {
        const v = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
        patch[k] = v === '' ? null : v;
      }
    }
    if (req.body?.invite_status && ['target','invited','accepted','declined','met','passed'].includes(req.body.invite_status)) {
      patch.invite_status = req.body.invite_status;
    }
    // If the AE changed the company, re-resolve the account match —
    // cheap and often what they wanted when they edited it.
    if (patch.company !== undefined) {
      patch.account_id = patch.company ? await findAccountIdForCompany(patch.company) : null;
    }
    await updateAttendee(req.params.aid, patch);
    // If the caller passed `open=<id>` (the edit-draft form does), keep
    // the details panel open on redirect — otherwise just anchor to the list.
    const openParam = req.body?.open && UUID_RE.test(req.body.open) ? `?open=${req.body.open}` : '';
    const hash = req.body?.open ? `#a-${req.body.open}` : '#attendees';
    res.redirect(`/events/${req.params.eid}${openParam}${hash}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/events/:eid/attendees/:aid/delete', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.eid) || !UUID_RE.test(req.params.aid)) {
      return res.redirect('/events');
    }
    await deleteAttendee(req.params.aid);
    res.redirect(`/events/${req.params.eid}#attendees`);
  } catch (err) {
    next(err);
  }
});

// Generate a Claude-drafted note for one attendee. kind=invite writes
// the speaker-voice session invite; kind=meeting writes the AE-voice
// meeting request. We persist the draft on the attendee row so
// reopening the panel doesn't re-pay for the API call — the AE can
// regenerate if they want a different take.
webRouter.post('/events/:eid/attendees/:aid/draft', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.eid) || !UUID_RE.test(req.params.aid)) {
      return res.redirect('/events');
    }
    const kind = req.body?.kind;
    if (kind !== 'invite' && kind !== 'meeting') {
      return res.redirect(`/events/${req.params.eid}#attendees`);
    }
    const [event, attendee] = await Promise.all([
      getEventById(req.params.eid),
      getAttendeeById(req.params.aid),
    ]);
    if (!event || !attendee || attendee.event_id !== event.id) {
      return res.redirect(`/events/${req.params.eid}#attendees`);
    }

    const ae = req.session.userId
      ? (await query(
          `SELECT name, email FROM users WHERE id = $1`,
          [req.session.userId]
        )).rows[0] || null
      : null;

    try {
      let text;
      if (kind === 'invite') {
        text = await draftSessionInvite({ event, attendee, ae });
        await updateAttendee(attendee.id, { invite_draft: text });
      } else {
        text = await draftMeetingRequest({ event, attendee, ae });
        await updateAttendee(attendee.id, { meeting_draft: text });
      }
    } catch (err) {
      console.error(`[events/${event.id}/attendees/${attendee.id}/draft] ${kind} failed:`, err.message);
      // Persist the error message visibly in the draft field so the
      // AE sees WHY it failed (e.g. "No personal_invite_session") and
      // can act on it — rather than a silent no-op.
      const msg = `[draft failed] ${err.message}`;
      const patch = kind === 'invite' ? { invite_draft: msg } : { meeting_draft: msg };
      await updateAttendee(attendee.id, patch);
    }
    res.redirect(`/events/${event.id}?open=${attendee.id}#a-${attendee.id}`);
  } catch (err) {
    next(err);
  }
});

// Cross-account plays index — the answer to "where did that Dialpad
// play go?" Defaults to showing everything still on the board
// (drafting + active + paused); ?status=<x> pins it. Account name
// links back to the plan page with a hash-anchor onto the play card.
webRouter.get('/plays', requireAuth, async (req, res, next) => {
  try {
    const status = ['drafting', 'active', 'paused', 'won', 'lost', 'abandoned'].includes(req.query.status)
      ? req.query.status : null;
    const [plays, events] = await Promise.all([
      listPlaysForUser(req.session.userId, { status }),
      listEvents({ includeCompleted: false }),
    ]);
    res.render('plays', {
      title: 'Plays',
      plays,
      events,
      filter: status,
    });
  } catch (err) {
    next(err);
  }
});

// Export the play as .pptx — opens cleanly in Google Slides via
// File → Open → Upload, or drop into a Drive folder. We ship .pptx
// instead of hitting the Slides API so there's no OAuth dance in the
// loop. The deck mirrors the Nasralla output: title, overview with
// path + hypothesis, sequenced moves, a slide per champion artifact,
// stakeholder narratives, risks + positioning.
webRouter.get('/plays/:id/export.pptx', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const play = await getPlayById(req.params.id);
    if (!play) return res.redirect('/accounts');

    const [bundle, hypothesis, contacts] = await Promise.all([
      getAccountBundle(play.account_id),
      play.hypothesis_id ? getHypothesisById(play.hypothesis_id) : null,
      listContactsForAccount(play.account_id),
    ]);
    const account = bundle?.account;
    if (!account) return res.redirect('/accounts');

    const { renderPlayPptx, buildFilename } = await import('../lib/play_pptx.js');
    const buf = await renderPlayPptx({ play, account, hypothesis, contacts });
    const filename = buildFilename(account.account_name, play.ai_expansion?.named_play);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

// Manual full-book scan trigger — dev + end-to-end smoke before the cron
// goes live. Accepts optional ?account=<id> to scope to a single
// account (same path the Pulse "Rescan" button uses).
webRouter.post('/signals/scan', requireAuth, async (req, res, next) => {
  try {
    const account_ids = req.body?.account_id
      ? [req.body.account_id]
      : (req.query?.account_id ? [req.query.account_id] : null);

    const { rows } = await query(
      `INSERT INTO account_signal_jobs (user_id, status) VALUES ($1, 'running') RETURNING id`,
      [req.session.userId]
    );
    const jobId = rows[0].id;

    // Fire-and-forget — don't await. The /brief page renders the
    // active-job banner by polling the latest row.
    runSignalScanCycle({
      user_id: req.session.userId,
      account_ids,
      job_id: jobId,
    }).catch((err) => console.error('[signals/scan] background failed:', err));

    res.redirect(account_ids ? `/accounts/${account_ids[0]}` : '/brief');
  } catch (err) {
    next(err);
  }
});

// Per-account rescan from the Pulse partial. Rate limit: once per 24h
// per account to bound web_search cost. Returns to the account page.
webRouter.post('/accounts/:id/signals/rescan', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const lastAt = await getLastScanForAccount(req.params.id);
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (lastAt && Date.now() - new Date(lastAt).getTime() < ONE_DAY) {
      // Already scanned in the last 24h — skip silently rather than
      // double-charge. The UI can flash a note if we want later.
      return res.redirect(`/accounts/${req.params.id}?rescan=throttled`);
    }

    const { rows } = await query(
      `INSERT INTO account_signal_jobs (user_id, status) VALUES ($1, 'running') RETURNING id`,
      [req.session.userId]
    );
    const jobId = rows[0].id;

    runSignalScanCycle({
      user_id: req.session.userId,
      account_ids: [req.params.id],
      job_id: jobId,
    }).catch((err) => console.error('[accounts/rescan]', err));

    res.redirect(`/accounts/${req.params.id}?rescan=started`);
  } catch (err) {
    next(err);
  }
});

// ---------- Helpers ----------

async function getCounts(userId = null) {
  const [drafts, replies, researched, sent, sigCounts, playCounts] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM approval_queue WHERE status = 'pending';`),
    query(`SELECT COUNT(*)::int AS n FROM reply_queue WHERE status = 'pending';`),
    query(`SELECT COUNT(*)::int AS n FROM prospects WHERE researched_at >= date_trunc('day', NOW());`),
    query(`SELECT COUNT(*)::int AS n FROM sent_messages WHERE sent_at >= date_trunc('week', NOW());`),
    userId ? getSignalCounts(userId) : Promise.resolve({ this_week: 0, defense: 0, offense: 0, unacked_total: 0 }),
    userId ? countActivePlays(userId) : Promise.resolve({ active: 0, due_soon: 0 }),
  ]);
  return {
    pendingDrafts: drafts.rows[0].n,
    pendingReplies: replies.rows[0].n,
    researchedToday: researched.rows[0].n,
    sentThisWeek: sent.rows[0].n,
    signalsThisWeek: sigCounts.this_week,
    signalsDefense: sigCounts.defense,
    signalsOffense: sigCounts.offense,
    signalsUnacked: sigCounts.unacked_total,
    playsActive: playCounts.active,
    playsDueSoon: playCounts.due_soon,
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

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
  const [drafts, replies, researched, sent, sigCounts] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM approval_queue WHERE status = 'pending';`),
    query(`SELECT COUNT(*)::int AS n FROM reply_queue WHERE status = 'pending';`),
    query(`SELECT COUNT(*)::int AS n FROM prospects WHERE researched_at >= date_trunc('day', NOW());`),
    query(`SELECT COUNT(*)::int AS n FROM sent_messages WHERE sent_at >= date_trunc('week', NOW());`),
    userId ? getSignalCounts(userId) : Promise.resolve({ this_week: 0, defense: 0, offense: 0, unacked_total: 0 }),
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

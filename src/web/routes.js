// Server-rendered web UI routes. All require auth except /login.

import { Router } from 'express';
import {
  verifyLogin, requireAuth, createUser, listUsers,
  resetPassword, deleteUser, updateUserRole,
} from '../auth.js';
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
  updateAccountFields,
} from '../db/accounts_registry.js';
import { PERSONAS } from '../lib/personas.js';
import { runChampionCheckCycle } from '../agents/champion_tracker.js';
import { runSignalScanCycle } from '../agents/signal_analyzer.js';
import { scanDeadDeal, buildRevisitPaths } from '../agents/revisit_scanner.js';
import {
  getDeadDealByOpportunityId,
  setScanRunning,
  setScanResult,
  setScanFailed,
  listDeadDealsWithScan,
} from '../db/dead_deals.js';
import {
  createRevisitPaths,
  getPathsForDeal,
  getPathsById,
  selectPath,
  setOutcome,
  getPortfolioStats,
  listInFlightPaths,
  listRecentOutcomes,
  addRevisitNote,
  listRevisitNotes,
  deleteRevisitNote,
} from '../db/revisit_plans.js';
import {
  getDossier,
  upsertDossier,
  addExpansionNote,
  listExpansionNotes,
  getExpansionNote,
  deleteExpansionNote,
  listExpansionPortfolio,
  setScanRunning as setExpansionScanRunning,
  setScanResult as setExpansionScanResult,
  setScanFailed as setExpansionScanFailed,
  setCoachRunning as setDossierCoachRunning,
  setCoachResult as setDossierCoachResult,
  setCoachFailed as setDossierCoachFailed,
  clearCoachResult as clearDossierCoachResult,
  setPlanRunning as setDossierPlanRunning,
  setPlanResult as setDossierPlanResult,
  setPlanFailed as setDossierPlanFailed,
  clearPlanResult as clearDossierPlanResult,
  createExpansionPaths,
  getExpansionPathsById,
  listExpansionPathsForAccount,
  selectExpansionPath,
  setExpansionOutcome,
} from '../db/expansions.js';
import { scanCustomer, buildExpansionPaths } from '../agents/expansion_scanner.js';
import { coachDossier } from '../agents/dossier_coach.js';
import { planDossier } from '../agents/dossier_planner.js';
import { fitUseCase } from '../agents/use_case_fit.js';
import { pullIndustryInsight } from '../agents/industry_insight.js';
import { generateHypotheses } from '../agents/hypothesis_generator.js';
import { lookupFiscalYear } from '../agents/fiscal_lookup.js';
import { scanProspects } from '../agents/prospect_scanner.js';
import { generateAccountPov } from '../agents/account_pov.js';
import {
  getAccountIntel,
  setIntelRunning,
  setIntelResult,
  setIntelFailed,
} from '../db/account_intel.js';
import {
  getSignalById,
  getSignalsForAccount,
  acknowledgeSignal,
  dismissSignal,
  setSignalPlaying,
  restoreSignal,
  getLastScanForAccount,
} from '../db/signals.js';
import { listUnifiedBrief, getUnifiedCounts, listAccountTimeline } from '../db/today.js';
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
  markInvited,
  markFollowupDone,
  snoozeFollowup,
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

// Home = Today. The dashboard used to be a bag of counters for the old
// prospecting pipeline; the thesis is now Strategic-AE signal intelligence
// and /brief (rendered as "Today") is the one screen that matters.
webRouter.get('/', requireAuth, (req, res) => res.redirect('/brief'));

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

webRouter.get('/settings', requireAuth, async (req, res, next) => {
  try {
    const providers = await getProviders();
    const users = await listUsers();
    const currentUser = users.find((u) => u.id === req.session.userId);
    res.render('settings', {
      title: 'Settings',
      providers,
      users,
      currentUser,
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

webRouter.post('/settings/users', requireAuth, async (req, res, next) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const name = (req.body?.name || '').trim();
    const password = (req.body?.password || '').trim();
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    if (!email || !password || password.length < 6) return res.redirect('/settings');
    const user = await createUser({ email, name, password });
    if (role === 'admin') await updateUserRole(user.id, 'admin');
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

webRouter.post('/settings/users/:id/reset-password', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/settings');
    const newPw = (req.body?.password || '').trim();
    if (!newPw || newPw.length < 6) return res.redirect('/settings');
    await resetPassword(req.params.id, newPw);
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

webRouter.post('/settings/users/:id/role', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/settings');
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    await updateUserRole(req.params.id, role);
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

webRouter.post('/settings/users/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/settings');
    if (req.params.id === req.session.userId) return res.redirect('/settings');
    await deleteUser(req.params.id);
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

webRouter.post('/accounts/:id/fields', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const fields = {};
    if (req.body?.fiscal_year_end !== undefined) {
      const v = parseInt(req.body.fiscal_year_end, 10);
      fields.fiscal_year_end = (v >= 1 && v <= 12) ? v : null;
    }
    if (req.body?.budget_start_month !== undefined) {
      const v = parseInt(req.body.budget_start_month, 10);
      fields.budget_start_month = (v >= 1 && v <= 12) ? v : null;
    }
    if (req.body?.buyer_timing !== undefined) {
      fields.buyer_timing = (req.body.buyer_timing || '').trim().slice(0, 2000) || null;
    }
    if (req.body?.sales_perf_topics !== undefined) {
      fields.sales_perf_topics = (req.body.sales_perf_topics || '').trim().slice(0, 4000) || null;
    }
    await updateAccountFields(req.params.id, fields);
    res.redirect(`/accounts/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/accounts/:id/fields/lookup-fiscal-year', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/accounts');
    const bundle = await getAccountBundle(req.params.id);
    if (!bundle) return res.redirect('/accounts');
    const result = await lookupFiscalYear(bundle.account);
    const patch = {};
    if (result.month) patch.fiscal_year_end = result.month;
    if (result.budgetStartMonth) patch.budget_start_month = result.budgetStartMonth;
    if (result.budgetNote && !bundle.account.buyer_timing) {
      patch.buyer_timing = result.budgetNote;
    }
    if (Object.keys(patch).length > 0) {
      await updateAccountFields(req.params.id, patch);
    }
    res.redirect(`/accounts/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Revisit (Closed Lost / Churn) ----------
//
// The /revisit channel asks Claude to web-scan ONE dead deal at a time and
// return triggers that might neutralise the original loss reason. We don't
// run a cron — this is on-demand, AE-driven: pick a row, click Scan, eyeball
// the triggers. Persistence is cheap (last_scan_* columns on dead_deals).

webRouter.get('/revisit', requireAuth, async (req, res, next) => {
  try {
    // Portfolio dashboard — four parallel queries. The page has to be
    // snappy since this is the AE's "where am I moving the needle"
    // landing view; sequential would double the wall time.
    const [stats, inFlight, recentOutcomes, deals] = await Promise.all([
      getPortfolioStats(),
      listInFlightPaths(),
      listRecentOutcomes({ limit: 10 }),
      listDeadDealsWithScan({ limit: 300 }),
    ]);
    res.render('revisit', {
      title: 'Revisit',
      stats,
      inFlight,
      recentOutcomes,
      deals,
    });
  } catch (err) {
    next(err);
  }
});

webRouter.get('/revisit/:opportunity_id', requireAuth, async (req, res, next) => {
  try {
    const deal = await getDeadDealByOpportunityId(req.params.opportunity_id);
    if (!deal) return res.redirect('/revisit');
    const [pathSets, notes] = await Promise.all([
      getPathsForDeal(req.params.opportunity_id),
      listRevisitNotes(req.params.opportunity_id),
    ]);
    res.render('revisit_detail', { title: deal.account_name, deal, pathSets, notes });
  } catch (err) {
    next(err);
  }
});

// Kick off a scan. Fire-and-forget — we flip the row to 'running' before
// returning so the detail page shows a spinner immediately, then update
// to 'completed' or 'failed' from the background promise. Same pattern as
// /events/:id/research and /champions/check-now.
webRouter.post('/revisit/:opportunity_id/scan', requireAuth, async (req, res, next) => {
  try {
    const oppId = req.params.opportunity_id;
    const deal = await getDeadDealByOpportunityId(oppId);
    if (!deal) return res.redirect('/revisit');

    // Don't start a second scan while one is in flight on this deal.
    if (deal.last_scan_status === 'running') {
      return res.redirect(`/revisit/${encodeURIComponent(oppId)}`);
    }

    await setScanRunning(oppId);

    // Pull AE notes now so they're included in the scanner context.
    // These are free-form scraps the AE dropped between scans and they
    // can change what Claude chooses to search for.
    const aeNotes = await listRevisitNotes(oppId);

    // Fire and forget. Errors get persisted to last_scan_error so the
    // detail page can show them.
    Promise.resolve()
      .then(async () => {
        const result = await scanDeadDeal(deal, { aeNotes });
        await setScanResult(oppId, result);
        console.log(`[revisit] scan ${oppId} done — ${result.triggers.length} triggers, ${result.searches} searches, skipped=${result.skipped || 'no'}`);
      })
      .catch(async (err) => {
        console.error(`[revisit] scan ${oppId} failed:`, err);
        try { await setScanFailed(oppId, err.message || String(err)); } catch (_) {}
      });

    res.redirect(`/revisit/${encodeURIComponent(oppId)}`);
  } catch (err) {
    next(err);
  }
});

// Build three re-entry paths for a specific trigger. Synchronous — the AE
// clicks "Build paths" on a trigger card and waits ~10-15s for Claude to
// reason over the deal+trigger context. No web search, just reasoning.
webRouter.post('/revisit/:opportunity_id/paths', requireAuth, async (req, res, next) => {
  try {
    const oppId = req.params.opportunity_id;
    const deal = await getDeadDealByOpportunityId(oppId);
    if (!deal) return res.redirect('/revisit');

    const triggerIdx = parseInt(req.body?.trigger_index, 10);
    const triggers = Array.isArray(deal.last_scan_result) ? deal.last_scan_result : [];
    if (!Number.isFinite(triggerIdx) || triggerIdx < 0 || triggerIdx >= triggers.length) {
      return res.redirect(`/revisit/${encodeURIComponent(oppId)}`);
    }

    const trigger = triggers[triggerIdx];
    const aeNotes = await listRevisitNotes(oppId);
    const result = await buildRevisitPaths(deal, trigger, { aeNotes });

    await createRevisitPaths({
      opportunity_id: oppId,
      trigger_index: triggerIdx,
      trigger_title: trigger.trigger_title || null,
      paths: result.paths,
    });

    console.log(`[revisit] built ${result.paths.length} paths for ${oppId} trigger #${triggerIdx} in ${result.elapsed_ms}ms`);
    res.redirect(`/revisit/${encodeURIComponent(oppId)}#trigger-${triggerIdx}`);
  } catch (err) {
    console.error('[revisit/paths] failed:', err);
    next(err);
  }
});

// AE selects a path — records the choice + timestamp for learning.
webRouter.post('/revisit/paths/:id/select', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/revisit');
    const pathSet = await getPathsById(req.params.id);
    if (!pathSet) return res.redirect('/revisit');
    const idx = parseInt(req.body?.path_index, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx > 2) return res.redirect(`/revisit/${encodeURIComponent(pathSet.opportunity_id)}`);
    await selectPath(pathSet.id, idx);
    res.redirect(`/revisit/${encodeURIComponent(pathSet.opportunity_id)}#paths-${pathSet.id}`);
  } catch (err) {
    next(err);
  }
});

// Soft unification: act on a revisit trigger the same way as a customer
// signal. Creates a tracked account_plays row on the deal's account, seeded
// from the trigger's re_entry_angle / sponsors_to_target. Links back to a
// stub revisit_paths row so the trigger origin survives dossier rescans.
webRouter.post('/revisit/:opportunity_id/triggers/:trigger_index/play', requireAuth, async (req, res, next) => {
  try {
    const oppId = req.params.opportunity_id;
    const deal = await getDeadDealByOpportunityId(oppId);
    if (!deal) return res.redirect('/revisit');

    const triggerIdx = parseInt(req.params.trigger_index, 10);
    const triggers = Array.isArray(deal.last_scan_result) ? deal.last_scan_result : [];
    if (!Number.isFinite(triggerIdx) || triggerIdx < 0 || triggerIdx >= triggers.length) {
      return res.redirect(`/revisit/${encodeURIComponent(oppId)}`);
    }
    const trigger = triggers[triggerIdx];
    const accountId = deal.account_id;

    const pathRow = await createRevisitPaths({
      opportunity_id: oppId,
      trigger_index: triggerIdx,
      trigger_title: trigger.trigger_title || null,
      trigger_snapshot: trigger,
      paths: [],
    });

    // Normalize revisit-trigger shape into the {title, so_what,
    // recommended_move} contract buildPlay expects.
    const sponsorNames = Array.isArray(trigger.sponsors_to_target)
      ? trigger.sponsors_to_target.map((s) => s?.name).filter(Boolean)
      : [];
    const normalized = {
      title: trigger.trigger_title || 'Revisit trigger',
      so_what: trigger.why_this_unlocks || trigger.trigger_summary || null,
      recommended_move:
        (trigger.re_entry_angle && trigger.re_entry_angle.trim())
        || (sponsorNames.length ? `Re-enter via ${sponsorNames.join(', ')}` : null)
        || (trigger.loss_reason_link ? `Counter to loss reason: ${trigger.loss_reason_link}` : null),
      source_url: trigger.source_url || null,
    };

    const seed =
      (normalized.recommended_move && normalized.recommended_move.trim())
      || (normalized.so_what && normalized.so_what.trim())
      || `Act on: ${normalized.title}`;
    const instinct = `Triggered by revisit scan — ${normalized.title}\n\n${seed}`;

    const [bundle, priorPlays] = await Promise.all([
      getAccountBundle(accountId),
      listPlaysForAccount(accountId),
    ]);

    const play = await createPlay({
      account_id: accountId,
      triggered_by_revisit_path_id: pathRow.id,
      author_user_id: req.session.userId,
      instinct,
      status: 'drafting',
    });

    try {
      const { expansion } = await buildPlay({
        account: bundle?.account,
        instinct,
        hypothesis: null,
        contact_path_resolved: [],
        triggering_signal: normalized,
        event: null,
        personal_invites: [],
        prior_plays: priorPlays
          .filter((p) => p.id !== play.id)
          .map((p) => ({ named_play: p.ai_expansion?.named_play || null, status: p.status })),
      });
      if (expansion) {
        await updatePlay(play.id, { ai_expansion: expansion, status: 'active' });
      }
    } catch (err) {
      console.error('[revisit/triggers/play build] expansion failed:', err.message);
    }

    res.redirect(`/accounts/${accountId}/plan#play-${play.id}`);
  } catch (err) {
    console.error('[revisit/triggers/play]', err);
    next(err);
  }
});

// AE records the outcome of a path they executed.
webRouter.post('/revisit/paths/:id/outcome', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/revisit');
    const pathSet = await getPathsById(req.params.id);
    if (!pathSet) return res.redirect('/revisit');
    const outcome = ['won', 'lost', 'no_response', 'in_progress'].includes(req.body?.outcome) ? req.body.outcome : null;
    if (!outcome) return res.redirect(`/revisit/${encodeURIComponent(pathSet.opportunity_id)}`);
    await setOutcome(pathSet.id, { outcome, notes: (req.body?.notes || '').trim() || null });
    res.redirect(`/revisit/${encodeURIComponent(pathSet.opportunity_id)}#paths-${pathSet.id}`);
  } catch (err) {
    next(err);
  }
});

// AE drops a note on the dead deal — timestamped scrap of intel picked up
// between scans. These feed into the scanner + path generator on every
// subsequent run so late-arriving context actually changes the output.
webRouter.post('/revisit/:opportunity_id/notes', requireAuth, async (req, res, next) => {
  try {
    const oppId = req.params.opportunity_id;
    const deal = await getDeadDealByOpportunityId(oppId);
    if (!deal) return res.redirect('/revisit');
    const note = (req.body?.note || '').trim();
    if (!note) return res.redirect(`/revisit/${encodeURIComponent(oppId)}#notes`);
    // Soft cap — a note that's bigger than this is really a document and
    // belongs somewhere else; the prompt budget has limits.
    await addRevisitNote({
      opportunity_id: oppId,
      note: note.slice(0, 4000),
      user_id: req.session.userId,
    });
    res.redirect(`/revisit/${encodeURIComponent(oppId)}#notes`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/revisit/notes/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/revisit');
    // Fetch the opportunity_id so we can redirect back. Cheap enough
    // to do a small SELECT before the DELETE rather than threading it
    // through the hidden form.
    const { rows } = await query(
      `SELECT opportunity_id FROM revisit_notes WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    const oppId = rows[0]?.opportunity_id;
    await deleteRevisitNote(req.params.id);
    if (oppId) return res.redirect(`/revisit/${encodeURIComponent(oppId)}#notes`);
    res.redirect('/revisit');
  } catch (err) {
    next(err);
  }
});

// ---------- Expand (Customer growth) ----------
//
// /expand is /revisit's mirror image for active customers. Instead of asking
// "what would neutralize the loss reason?" it asks "where are we today, where
// do they want us next, and what move proves the deepening narrative?" Phase 1
// is just the dossier + notes — a place to drop everything you know so the
// Phase 2 scanner + path generator have something to reason over.

webRouter.get('/expand', requireAuth, async (req, res, next) => {
  try {
    const customers = await listExpansionPortfolio();
    res.render('expand', { title: 'Expand', customers });
  } catch (err) {
    next(err);
  }
});

webRouter.get('/expand/:account_id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.account_id)) return res.redirect('/expand');
    // The People Map reuses game_plan_contacts so /expand and /accounts/:id/plan
    // stay in sync — one canonical org chart per account.
    const [bundle, dossier, notes, contacts, pathSets] = await Promise.all([
      getAccountBundle(req.params.account_id),
      getDossier(req.params.account_id),
      listExpansionNotes(req.params.account_id),
      listContactsForAccount(req.params.account_id),
      listExpansionPathsForAccount(req.params.account_id),
    ]);
    if (!bundle) return res.redirect('/expand');
    // Only customers get the /expand treatment. Churned accounts belong in
    // /revisit (they land there as dead_deals with account_type_at_close =
    // Customer - Churned). Silent redirect keeps the URL space tidy.
    if (bundle.account.status !== 'customer') {
      return res.redirect(`/accounts/${req.params.account_id}`);
    }
    res.render('expand_detail', {
      title: bundle.account.account_name,
      account: bundle.account,
      dossier,
      notes,
      contacts,
      pathSets,
    });
  } catch (err) {
    next(err);
  }
});

webRouter.post('/expand/:account_id/dossier', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.account_id)) return res.redirect('/expand');
    // 8000-char cap per field — anything larger is a document, not a field,
    // and will blow the eventual scanner's prompt budget.
    const clip = (s) => typeof s === 'string' ? s.slice(0, 8000) : '';
    await upsertDossier(req.params.account_id, {
      footprint: clip(req.body?.footprint),
      destination: clip(req.body?.destination),
      stack_competitive: clip(req.body?.stack_competitive),
      open_questions: clip(req.body?.open_questions),
    });
    res.redirect(`/expand/${req.params.account_id}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/expand/:account_id/notes', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.account_id)) return res.redirect('/expand');
    const note = (req.body?.note || '').trim();
    if (!note) return res.redirect(`/expand/${req.params.account_id}#notes`);
    await addExpansionNote({
      account_id: req.params.account_id,
      note: note.slice(0, 8000),
      user_id: req.session.userId,
    });
    res.redirect(`/expand/${req.params.account_id}#notes`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/expand/notes/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/expand');
    const n = await getExpansionNote(req.params.id);
    await deleteExpansionNote(req.params.id);
    if (n?.account_id) return res.redirect(`/expand/${n.account_id}#notes`);
    res.redirect('/expand');
  } catch (err) {
    next(err);
  }
});

// Kick off an expansion scan on a customer. Same fire-and-forget pattern as
// /revisit — flip status to 'running' before returning so the detail page
// shows a spinner, then update to completed/failed from the background
// promise. Requires a saved dossier; without destination goals to filter
// against, the scanner has no optimization function.
webRouter.post('/expand/:account_id/scan', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.account_id;
    if (!UUID_RE.test(accountId)) return res.redirect('/expand');
    const [bundle, dossier] = await Promise.all([
      getAccountBundle(accountId),
      getDossier(accountId),
    ]);
    if (!bundle || bundle.account.status !== 'customer') {
      return res.redirect('/expand');
    }
    // Need a dossier with at least a destination — otherwise the scanner has
    // nothing to optimize toward and will either surface generic news or
    // (correctly) return an empty array.
    if (!dossier || !dossier.destination) {
      return res.redirect(`/expand/${accountId}`);
    }
    if (dossier.last_scan_status === 'running') {
      return res.redirect(`/expand/${accountId}`);
    }

    await setExpansionScanRunning(accountId);

    const [notes, contacts] = await Promise.all([
      listExpansionNotes(accountId),
      listContactsForAccount(accountId),
    ]);

    Promise.resolve()
      .then(async () => {
        const result = await scanCustomer(bundle.account, { dossier, notes, contacts });
        await setExpansionScanResult(accountId, {
          triggers: result.triggers,
          searches: result.searches,
        });
        console.log(`[expand] scan ${accountId} done — ${result.triggers.length} triggers, ${result.searches} searches, skipped=${result.skipped || 'no'}`);
      })
      .catch(async (err) => {
        console.error(`[expand] scan ${accountId} failed:`, err);
        try {
          await setExpansionScanFailed(accountId, { error: err.message || String(err) });
        } catch (_) { /* best effort */ }
      });

    res.redirect(`/expand/${accountId}`);
  } catch (err) {
    next(err);
  }
});

// Build three expansion paths for one trigger. Synchronous (~10-15s) — the
// AE clicks "Build paths" and waits. No web_search, just reasoning over the
// dossier + trigger + people map.
webRouter.post('/expand/:account_id/paths', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.account_id;
    if (!UUID_RE.test(accountId)) return res.redirect('/expand');
    const [bundle, dossier, notes, contacts] = await Promise.all([
      getAccountBundle(accountId),
      getDossier(accountId),
      listExpansionNotes(accountId),
      listContactsForAccount(accountId),
    ]);
    if (!bundle || bundle.account.status !== 'customer') return res.redirect('/expand');

    const triggers = Array.isArray(dossier?.last_scan_result) ? dossier.last_scan_result : [];
    const triggerIdx = parseInt(req.body?.trigger_index, 10);
    if (!Number.isFinite(triggerIdx) || triggerIdx < 0 || triggerIdx >= triggers.length) {
      return res.redirect(`/expand/${accountId}`);
    }

    const trigger = triggers[triggerIdx];
    const result = await buildExpansionPaths(bundle.account, trigger, { dossier, notes, contacts });

    await createExpansionPaths({
      account_id: accountId,
      trigger_index: triggerIdx,
      trigger_title: trigger.trigger_title || null,
      trigger_snapshot: trigger,
      paths: result.paths,
    });

    console.log(`[expand] built ${result.paths.length} paths for ${accountId} trigger #${triggerIdx} in ${result.elapsed_ms}ms`);
    res.redirect(`/expand/${accountId}#trigger-${triggerIdx}`);
  } catch (err) {
    console.error('[expand/paths] failed:', err);
    next(err);
  }
});

// AE selects a path — records the choice + timestamp for learning.
webRouter.post('/expand/paths/:id/select', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/expand');
    const pathSet = await getExpansionPathsById(req.params.id);
    if (!pathSet) return res.redirect('/expand');
    const idx = parseInt(req.body?.path_index, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx > 2) {
      return res.redirect(`/expand/${pathSet.account_id}`);
    }
    await selectExpansionPath(pathSet.id, idx);
    res.redirect(`/expand/${pathSet.account_id}#paths-${pathSet.id}`);
  } catch (err) {
    next(err);
  }
});

// Soft unification: act on an expansion trigger the same way as a customer
// signal — create a tracked account_plays row, instinct seeded from the
// trigger's champion_talking_point / carry_internally / destination_link,
// buildPlay synchronously, redirect to the account plan. The play links back
// to a stub expansion_paths row (paths=[]) so the trigger origin is durable
// even if the dossier gets rescanned.
webRouter.post('/expand/:account_id/triggers/:trigger_index/play', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.account_id;
    if (!UUID_RE.test(accountId)) return res.redirect('/expand');
    const triggerIdx = parseInt(req.params.trigger_index, 10);
    if (!Number.isFinite(triggerIdx) || triggerIdx < 0) return res.redirect(`/expand/${accountId}`);

    const [bundle, dossier, priorPlays] = await Promise.all([
      getAccountBundle(accountId),
      getDossier(accountId),
      listPlaysForAccount(accountId),
    ]);
    if (!bundle || bundle.account.status !== 'customer') return res.redirect('/expand');

    const triggers = Array.isArray(dossier?.last_scan_result) ? dossier.last_scan_result : [];
    if (triggerIdx >= triggers.length) return res.redirect(`/expand/${accountId}`);
    const trigger = triggers[triggerIdx];

    // Stub expansion_paths with paths=[] — the "Build paths" CTA is still
    // independently clickable to enumerate 3 alternatives later.
    const pathRow = await createExpansionPaths({
      account_id: accountId,
      trigger_index: triggerIdx,
      trigger_title: trigger.trigger_title || null,
      trigger_snapshot: trigger,
      paths: [],
    });

    // Normalize the expansion-trigger shape into the {title, so_what,
    // recommended_move} contract buildPlay expects.
    const carryRole = trigger.carry_internally?.role ? ` (${trigger.carry_internally.role})` : '';
    const normalized = {
      title: trigger.trigger_title || 'Expansion trigger',
      so_what: trigger.why_this_unlocks || trigger.trigger_summary || null,
      recommended_move:
        (trigger.champion_talking_point && trigger.champion_talking_point.trim())
        || (trigger.carry_internally?.who ? `Carry internally through ${trigger.carry_internally.who}${carryRole}` : null)
        || (trigger.destination_link ? `Link to destination: ${trigger.destination_link}` : null),
      source_url: trigger.source_url || null,
    };

    const seed =
      (normalized.recommended_move && normalized.recommended_move.trim())
      || (normalized.so_what && normalized.so_what.trim())
      || `Act on: ${normalized.title}`;
    const instinct = `Triggered by expansion scan — ${normalized.title}\n\n${seed}`;

    const play = await createPlay({
      account_id: accountId,
      triggered_by_expansion_path_id: pathRow.id,
      author_user_id: req.session.userId,
      instinct,
      status: 'drafting',
    });

    try {
      const { expansion } = await buildPlay({
        account: bundle.account,
        instinct,
        hypothesis: null,
        contact_path_resolved: [],
        triggering_signal: normalized,
        event: null,
        personal_invites: [],
        prior_plays: priorPlays
          .filter((p) => p.id !== play.id)
          .map((p) => ({ named_play: p.ai_expansion?.named_play || null, status: p.status })),
      });
      if (expansion) {
        await updatePlay(play.id, { ai_expansion: expansion, status: 'active' });
      }
    } catch (err) {
      console.error('[expand/triggers/play build] expansion failed:', err.message);
    }

    res.redirect(`/accounts/${accountId}/plan#play-${play.id}`);
  } catch (err) {
    console.error('[expand/triggers/play]', err);
    next(err);
  }
});

// Ask Claude what the AE should be filling into the dossier. Fire-and-forget
// so the editor can keep rendering; the GET route reads coach_status +
// coach_result and renders whatever the background job produced.
//
// Works against an empty dossier — we upsert a blank row first if needed so
// the coach has somewhere to write its running/completed state.
webRouter.post('/expand/:account_id/coach', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.account_id;
    if (!UUID_RE.test(accountId)) return res.redirect('/expand');
    const [bundle, contacts] = await Promise.all([
      getAccountBundle(accountId),
      listContactsForAccount(accountId),
    ]);
    if (!bundle || bundle.account.status !== 'customer') {
      return res.redirect('/expand');
    }

    // Ensure a dossier row exists so the UPDATE below actually persists.
    // upsertDossier is idempotent — it only overwrites what was submitted
    // and leaves the existing values otherwise.
    let dossier = await getDossier(accountId);
    if (!dossier) {
      dossier = await upsertDossier(accountId, {
        footprint: null, destination: null, stack_competitive: null, open_questions: null,
      });
    }
    if (dossier.coach_status === 'running') {
      return res.redirect(`/expand/${accountId}#dossier`);
    }

    await setDossierCoachRunning(accountId);

    const notes = await listExpansionNotes(accountId);

    Promise.resolve()
      .then(async () => {
        const result = await coachDossier(bundle.account, { dossier, notes, contacts });
        if (result.skipped || !result.suggestions) {
          await setDossierCoachFailed(accountId, { error: result.skipped || 'no suggestions' });
          return;
        }
        await setDossierCoachResult(accountId, { suggestions: result.suggestions });
        console.log(`[expand] coached dossier for ${accountId} — ${result.searches} searches, ${result.elapsed_ms}ms`);
      })
      .catch(async (err) => {
        console.error(`[expand] coach ${accountId} failed:`, err);
        try {
          await setDossierCoachFailed(accountId, { error: err.message || String(err) });
        } catch (_) { /* best effort */ }
      });

    res.redirect(`/expand/${accountId}#dossier`);
  } catch (err) {
    next(err);
  }
});

// AE dismisses the suggestions block once they've acted on it (or decided
// it's noise). Clears coach_result so the editor goes back to the default
// "Suggest what to fill in" CTA.
webRouter.post('/expand/:account_id/coach/clear', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.account_id;
    if (!UUID_RE.test(accountId)) return res.redirect('/expand');
    await clearDossierCoachResult(accountId);
    res.redirect(`/expand/${accountId}#dossier`);
  } catch (err) {
    next(err);
  }
});

// Generate the strategic plan from the current dossier + notes + people map.
// Fire-and-forget: plan_status flips to 'running' synchronously, the HTTP
// handler returns, the planner runs for ~15-30s, then writes plan_result.
// The view polls by auto-reloading while status==='running'.
webRouter.post('/expand/:account_id/plan', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.account_id;
    if (!UUID_RE.test(accountId)) return res.redirect('/expand');
    const [bundle, contacts] = await Promise.all([
      getAccountBundle(accountId),
      listContactsForAccount(accountId),
    ]);
    if (!bundle || bundle.account.status !== 'customer') {
      return res.redirect('/expand');
    }

    // The planner needs at least SOMETHING in the dossier. Unlike the coach
    // (which synthesizes from zero), the planner is supposed to produce
    // evidence-anchored hypotheses — no dossier, no evidence, no plan.
    const dossier = await getDossier(accountId);
    const hasAnyField = dossier && (
      dossier.footprint || dossier.destination ||
      dossier.stack_competitive || dossier.open_questions
    );
    if (!hasAnyField) {
      return res.redirect(`/expand/${accountId}#dossier`);
    }
    if (dossier.plan_status === 'running') {
      return res.redirect(`/expand/${accountId}#plan`);
    }

    await setDossierPlanRunning(accountId);

    const notes = await listExpansionNotes(accountId);

    Promise.resolve()
      .then(async () => {
        const result = await planDossier(bundle.account, { dossier, notes, contacts });
        if (result.skipped || !result.plan) {
          await setDossierPlanFailed(accountId, { error: result.skipped || 'no plan' });
          return;
        }
        await setDossierPlanResult(accountId, { plan: result.plan });
        console.log(`[expand] planned dossier for ${accountId} — ${result.plan.hypotheses.length} hypotheses, ${result.elapsed_ms}ms`);
      })
      .catch(async (err) => {
        console.error(`[expand] plan ${accountId} failed:`, err);
        try {
          await setDossierPlanFailed(accountId, { error: err.message || String(err) });
        } catch (_) { /* best effort */ }
      });

    res.redirect(`/expand/${accountId}#plan`);
  } catch (err) {
    next(err);
  }
});

// AE dismisses the plan (e.g. dossier just changed materially and the plan is
// stale). Clears plan_result so the section collapses back to the CTA.
webRouter.post('/expand/:account_id/plan/clear', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.account_id;
    if (!UUID_RE.test(accountId)) return res.redirect('/expand');
    await clearDossierPlanResult(accountId);
    res.redirect(`/expand/${accountId}#dossier`);
  } catch (err) {
    next(err);
  }
});

// AE records the outcome of an expansion path they executed.
webRouter.post('/expand/paths/:id/outcome', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/expand');
    const pathSet = await getExpansionPathsById(req.params.id);
    if (!pathSet) return res.redirect('/expand');
    const outcome = ['won', 'lost', 'no_response', 'in_progress'].includes(req.body?.outcome)
      ? req.body.outcome : null;
    if (!outcome) return res.redirect(`/expand/${pathSet.account_id}`);
    await setExpansionOutcome(pathSet.id, {
      outcome,
      notes: (req.body?.notes || '').trim() || null,
    });
    res.redirect(`/expand/${pathSet.account_id}#paths-${pathSet.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Signals (Sprint 1: Pulse + Monday Brief) ----------

// /brief (aka /today) — unified account-grouped view. One card per
// account showing: AI-generated POV + strategy, news signals from the
// last 60 days, and prospects (people AT the company showing intent).
// Sort by newest activity, priority, or oldest. Filter by account status.
// Quiet accounts (no signals, no prospects, no POV) hidden by default.
webRouter.get('/brief', requireAuth, async (req, res, next) => {
  try {
    const allowedSorts = new Set(['newest', 'priority', 'oldest']);
    const sort = allowedSorts.has(req.query?.sort) ? req.query.sort : 'newest';

    const allowedStatuses = new Set(['prospect', 'customer', 'churned']);
    const statusFilter = allowedStatuses.has(req.query?.status) ? req.query.status : null;

    const includeQuiet = req.query?.quiet === '1';

    const [accounts, totalAccountRow, activeJobRow] = await Promise.all([
      listAccountTimeline(req.session.userId, {
        includeQuiet,
        statuses: statusFilter ? [statusFilter] : null,
      }),
      query(
        `SELECT COUNT(*)::int AS total FROM accounts_registry
          WHERE (owner_user_id = $1 OR owner_user_id IS NULL)`,
        [req.session.userId]
      ),
      query(`SELECT * FROM account_signal_jobs ORDER BY started_at DESC LIMIT 1`),
    ]);

    // Priority sort: hot > warm > cool, then by recency. Oldest: flip
    // the recency comparator. Newest is the DB default.
    const priorityRank = { hot: 3, warm: 2, cool: 1 };
    const sorted = [...accounts];
    if (sort === 'priority') {
      sorted.sort((a, b) => {
        const pa = priorityRank[a.pov_result?.priority] || 0;
        const pb = priorityRank[b.pov_result?.priority] || 0;
        if (pa !== pb) return pb - pa;
        return new Date(b.last_activity_at || 0) - new Date(a.last_activity_at || 0);
      });
    } else if (sort === 'oldest') {
      sorted.sort((a, b) =>
        new Date(a.last_activity_at || 0) - new Date(b.last_activity_at || 0)
      );
    }

    const totalAccounts = totalAccountRow.rows[0]?.total || 0;
    const activeJob = activeJobRow.rows[0] || null;
    const runningJob = activeJob && activeJob.status === 'running';
    const purgedParam = req.query?.purged;
    const purgedCount = purgedParam != null && /^\d+$/.test(purgedParam)
      ? parseInt(purgedParam, 10) : null;
    res.render('brief', {
      title: 'Today',
      accounts: sorted,
      totalAccounts,
      sort,
      statusFilter,
      includeQuiet,
      activeJob,
      runningJob,
      purgedCount,
    });
  } catch (err) {
    next(err);
  }
});

// /discover is now aliased to /brief — the account-grouped view
// replaces the old separate Discover page.
webRouter.get('/discover', requireAuth, (req, res) => res.redirect('/brief'));

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

// "Play" handler — branches on the action.
//   build_play     → primary: spawns an account_plays row with the signal as
//                    its trigger, runs buildPlay to expand instinct into a
//                    sequenced play, redirects to /accounts/:aid/plan#play-<id>.
//   draft_outbound → secondary: jumps straight to a message draft in the
//                    approval queue without a play wrapper.
//   internal_intro / meeting_prep → Sprint 3 stubs; just mark playing.
webRouter.post('/signals/:id/play', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.redirect('/brief');
    const action = (req.body?.action || '').trim() || 'build_play';
    const signal = await getSignalById(req.params.id);
    if (!signal) return res.redirect('/brief');

    if (action === 'build_play') {
      // Seed the AE's instinct from the signal's interpretation. Falls back
      // through recommended_move → so_what → title so we always have a
      // non-empty instinct (required by buildPlay).
      const seed =
        (signal.recommended_move && signal.recommended_move.trim()) ||
        (signal.so_what && signal.so_what.trim()) ||
        `Act on: ${signal.title}`;
      const instinct = `Triggered by signal — ${signal.title}\n\n${seed}`;

      const play = await createPlay({
        account_id: signal.account_id,
        triggered_by_signal_id: signal.id,
        author_user_id: req.session.userId,
        instinct,
        status: 'drafting',
      });

      // Fire buildPlay synchronously (same pattern as POST /accounts/:id/plays).
      // If it throws, the play persists as 'drafting' and the plan view shows
      // a "Rebuild expansion" button.
      try {
        const [account, priorPlays] = await Promise.all([
          (async () => (await getAccountBundle(signal.account_id))?.account)(),
          listPlaysForAccount(signal.account_id),
        ]);
        const { expansion } = await buildPlay({
          account,
          instinct,
          hypothesis: null,
          contact_path_resolved: [],
          triggering_signal: signal,
          event: null,
          personal_invites: [],
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
        console.error('[signals/play build_play] expansion failed:', err.message);
      }

      await setSignalPlaying(signal.id).catch(() => {});
      return res.redirect(`/accounts/${signal.account_id}/plan#play-${play.id}`);
    }

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

    const [contacts, hypotheses, plays, events, intel] = await Promise.all([
      listContactsForAccount(accountId),
      listHypothesesForAccount(accountId),
      listPlaysForAccount(accountId),
      listEvents({ includeCompleted: false }),
      getAccountIntel(accountId),
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
      intel,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Game Plan intel (Use Case Identifier + Industry Insight) ----------
//
// Both kick off a background Claude call, flip status to 'running'
// synchronously, redirect back. The view auto-reloads while running and
// renders the result when done. Mirrors the dossier-coach/plan pattern.

webRouter.post('/accounts/:id/intel/use-case', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.id;
    if (!UUID_RE.test(accountId)) return res.redirect('/accounts');
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return res.redirect('/accounts');

    const intel = await getAccountIntel(accountId);
    if (intel.use_case_fit?.status === 'running') {
      return res.redirect(`/accounts/${accountId}/plan#intel`);
    }

    await setIntelRunning(accountId, 'use_case_fit');

    const [contacts, dossier] = await Promise.all([
      listContactsForAccount(accountId),
      getDossier(accountId).catch(() => null),
    ]);

    Promise.resolve()
      .then(async () => {
        const out = await fitUseCase(bundle.account, {
          signals: bundle.signals || [],
          dossier,
          contacts,
        });
        if (out.error || !out.result) {
          await setIntelFailed(accountId, 'use_case_fit', out.error || 'no_result');
          return;
        }
        await setIntelResult(accountId, 'use_case_fit', out.result);
        console.log(`[intel] use-case fit for ${accountId} — ${out.elapsed_ms}ms`);
      })
      .catch(async (err) => {
        console.error(`[intel] use-case ${accountId} failed:`, err);
        try { await setIntelFailed(accountId, 'use_case_fit', err.message || String(err)); } catch (_) {}
      });

    res.redirect(`/accounts/${accountId}/plan#intel`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/accounts/:id/intel/industry', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.id;
    if (!UUID_RE.test(accountId)) return res.redirect('/accounts');
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return res.redirect('/accounts');

    const intel = await getAccountIntel(accountId);
    if (intel.industry_insight?.status === 'running') {
      return res.redirect(`/accounts/${accountId}/plan#intel`);
    }

    await setIntelRunning(accountId, 'industry_insight');

    Promise.resolve()
      .then(async () => {
        const out = await pullIndustryInsight(bundle.account);
        if (out.error || !out.result) {
          await setIntelFailed(accountId, 'industry_insight', out.error || 'no_result');
          return;
        }
        await setIntelResult(accountId, 'industry_insight', out.result);
        console.log(`[intel] industry insight for ${accountId} — ${out.searches} searches, ${out.elapsed_ms}ms`);
      })
      .catch(async (err) => {
        console.error(`[intel] industry ${accountId} failed:`, err);
        try { await setIntelFailed(accountId, 'industry_insight', err.message || String(err)); } catch (_) {}
      });

    res.redirect(`/accounts/${accountId}/plan#intel`);
  } catch (err) {
    next(err);
  }
});

// Prospect scan — web_search for key people at an account with timing +
// intent signals. Fire-and-forget; results stored in account_intel as
// kind='prospect_scan'. Accessible from /discover and account detail.
webRouter.post('/accounts/:id/intel/prospects', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.id;
    if (!UUID_RE.test(accountId)) return res.redirect('/accounts');
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return res.redirect('/accounts');

    const intel = await getAccountIntel(accountId);
    if (intel.prospect_scan?.status === 'running') {
      return res.redirect(req.body?._from === 'discover'
        ? '/discover' : `/accounts/${accountId}#prospects`);
    }

    await setIntelRunning(accountId, 'prospect_scan');

    Promise.resolve()
      .then(async () => {
        const out = await scanProspects(bundle.account);
        if (out.error || !out.result) {
          await setIntelFailed(accountId, 'prospect_scan', out.error || 'no_result');
          return;
        }
        await setIntelResult(accountId, 'prospect_scan', out.result);
        console.log(`[intel] prospect scan for ${accountId} — ${out.result.prospects.length} prospects, ${out.searches} searches, ${out.elapsed_ms}ms`);
      })
      .then(() => regenerateAccountPov(accountId))
      .catch(async (err) => {
        console.error(`[intel] prospect scan ${accountId} failed:`, err);
        try { await setIntelFailed(accountId, 'prospect_scan', err.message || String(err)); } catch (_) {}
      });

    res.redirect(req.body?._from === 'discover' || req.body?._from === 'brief'
      ? '/brief' : `/accounts/${accountId}#prospects`);
  } catch (err) {
    next(err);
  }
});

// Purge stale intel across the entire book — dismisses every active
// signal with a NULL event_date (pre-recency-fix rows) or an event_date
// older than 60 days. Non-destructive: dismissed rows stay in DB on the
// account's archive tab. Use this to clean up historical contamination
// from earlier prompt versions that didn't enforce dating.
webRouter.post('/signals/purge-stale', requireAuth, async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `UPDATE account_signals
          SET status = 'dismissed',
              acknowledged_at = NOW()
        WHERE status IN ('new', 'acknowledged', 'playing')
          AND (event_date IS NULL
               OR event_date < (CURRENT_DATE - INTERVAL '60 days')::date)`
    );
    console.log(`[purge-stale] dismissed ${rowCount} stale signal(s)`);
    res.redirect('/brief?purged=' + rowCount);
  } catch (err) {
    next(err);
  }
});

// Clear the entire prospect scan for an account — deletes the
// account_intel row so the card goes back to "no scan yet" state.
// Use when the whole set is stale and the AE wants to rescan fresh.
webRouter.post('/accounts/:id/intel/prospects/clear', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.id;
    if (!UUID_RE.test(accountId)) return res.redirect('/brief');
    const { rows } = await query(
      `SELECT result FROM account_intel
        WHERE account_id = $1 AND kind = 'prospect_scan' AND status = 'completed'`,
      [accountId]
    );
    if (rows[0] && rows[0].result && Array.isArray(rows[0].result.prospects)) {
      const result = rows[0].result;
      result.prospects.forEach((p) => { p.dismissed = true; });
      await setIntelResult(accountId, 'prospect_scan', result);
    }
    res.redirect('/brief');
  } catch (err) {
    next(err);
  }
});

// Dismiss one prospect by position index within the prospect_scan result
// array. Marks as dismissed (hidden from view) but preserves the data so
// it continues to inform strategy and POV context.
webRouter.post('/accounts/:id/intel/prospects/:idx/dismiss', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.id;
    if (!UUID_RE.test(accountId)) return res.redirect('/brief');
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isInteger(idx) || idx < 0) return res.redirect('/brief');

    const { rows } = await query(
      `SELECT result FROM account_intel
        WHERE account_id = $1 AND kind = 'prospect_scan' AND status = 'completed'`,
      [accountId]
    );
    if (rows[0] && rows[0].result && Array.isArray(rows[0].result.prospects)) {
      const result = rows[0].result;
      if (idx < result.prospects.length) {
        result.prospects[idx].dismissed = true;
      }
      await setIntelResult(accountId, 'prospect_scan', result);
    }
    res.redirect('/brief');
  } catch (err) {
    next(err);
  }
});

// Generate hypotheses — AE picks which signals to feed in (checkboxes on
// the Hypotheses section); the agent drafts 1-3 hypotheses with the
// Nasralla three-beat narrative, and we insert them via createHypothesis
// so they flow through the same CRUD surface as hand-written ones.
webRouter.post('/accounts/:id/hypotheses/generate', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.id;
    if (!UUID_RE.test(accountId)) return res.redirect('/accounts');
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return res.redirect('/accounts');

    const intel = await getAccountIntel(accountId);
    if (intel.hypotheses_gen?.status === 'running') {
      return res.redirect(`/accounts/${accountId}/plan#hypotheses`);
    }

    // Selected signals from the checkbox group. Empty = use all pulse
    // signals on the account (that's what "select based on what was
    // found" defaults to when the AE hasn't explicitly pruned).
    const selectedIds = new Set(
      []
        .concat(req.body?.signal_ids || [])
        .filter((v) => typeof v === 'string' && UUID_RE.test(v))
    );
    const allSignals = Array.isArray(bundle.signals) ? bundle.signals : [];
    const selectedSignals = selectedIds.size > 0
      ? allSignals.filter((s) => selectedIds.has(s.id))
      : allSignals;

    const [contacts, dossier] = await Promise.all([
      listContactsForAccount(accountId),
      getDossier(accountId).catch(() => null),
    ]);

    const userId = req.session.userId;
    await setIntelRunning(accountId, 'hypotheses_gen');

    Promise.resolve()
      .then(async () => {
        const out = await generateHypotheses(bundle.account, {
          selectedSignals,
          dossier,
          contacts,
          personas: PERSONAS,
          useCaseFit: intel.use_case_fit?.status === 'completed' ? intel.use_case_fit.result : null,
        });
        if (out.error || !out.result) {
          await setIntelFailed(accountId, 'hypotheses_gen', out.error || 'no_result');
          return;
        }
        const drafted = Array.isArray(out.result.hypotheses) ? out.result.hypotheses : [];
        let inserted = 0;
        for (const h of drafted) {
          try {
            await createHypothesis({
              account_id: accountId,
              use_case: h.use_case,
              target_persona_id: h.target_persona_id,
              narrative_hook: h.narrative_hook,
              narrative: h.narrative,
              evidence_signal_ids: h.evidence_signal_ids || [],
              confidence: h.confidence,
              status: 'theory',
              created_by_user_id: userId,
            });
            inserted += 1;
          } catch (e) {
            console.error(`[intel] hypothesis insert failed for ${accountId}:`, e.message);
          }
        }
        await setIntelResult(accountId, 'hypotheses_gen', {
          drafted: drafted.length,
          inserted,
          rationale: out.result.rationale || null,
        });
        console.log(`[intel] hypotheses generated for ${accountId} — ${inserted}/${drafted.length}, ${out.elapsed_ms}ms`);
      })
      .catch(async (err) => {
        console.error(`[intel] hypotheses ${accountId} failed:`, err);
        try { await setIntelFailed(accountId, 'hypotheses_gen', err.message || String(err)); } catch (_) {}
      });

    res.redirect(`/accounts/${accountId}/plan#hypotheses`);
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
    if (req.body?.outcome_notes !== undefined) {
      patch.outcome_notes = (req.body.outcome_notes || '').trim() || null;
    }
    const TERMINAL = new Set(['won', 'lost', 'abandoned']);
    if (patch.status && TERMINAL.has(patch.status) && !play.closed_at) {
      patch.closed_at = new Date().toISOString();
    } else if (patch.status && !TERMINAL.has(patch.status) && play.closed_at) {
      patch.closed_at = null;
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

// Explicit "I sent the note" action. Bumps status → invited, stamps
// invited_at, and schedules a follow-up N days out so the attendee
// resurfaces in the list with a "follow up" nudge. Clearer than the
// dropdown, and plants the reminder in the same click.
webRouter.post('/events/:eid/attendees/:aid/mark-invited', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.eid) || !UUID_RE.test(req.params.aid)) {
      return res.redirect('/events');
    }
    const daysRaw = parseInt(req.body?.followup_days, 10);
    const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 30 ? daysRaw : 3;
    await markInvited(req.params.aid, { days, userId: req.session.userId || null });
    res.redirect(`/events/${req.params.eid}?open=${req.params.aid}#a-${req.params.aid}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/events/:eid/attendees/:aid/followup-done', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.eid) || !UUID_RE.test(req.params.aid)) {
      return res.redirect('/events');
    }
    await markFollowupDone(req.params.aid);
    res.redirect(`/events/${req.params.eid}#a-${req.params.aid}`);
  } catch (err) {
    next(err);
  }
});

webRouter.post('/events/:eid/attendees/:aid/snooze-followup', requireAuth, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.eid) || !UUID_RE.test(req.params.aid)) {
      return res.redirect('/events');
    }
    const daysRaw = parseInt(req.body?.days, 10);
    const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 30 ? daysRaw : 3;
    await snoozeFollowup(req.params.aid, { days });
    res.redirect(`/events/${req.params.eid}#a-${req.params.aid}`);
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
    // active-job banner by polling the latest row. When the scan
    // finishes, regenerate POV for each scanned account.
    runSignalScanCycle({
      user_id: req.session.userId,
      account_ids,
      job_id: jobId,
    })
      .then(async () => {
        if (account_ids && account_ids.length > 0) {
          for (const id of account_ids) { await regenerateAccountPov(id); }
        } else {
          // Full-book scan: regen POV for every customer account that
          // was in scope. Do this serially to respect the Haiku rate
          // and keep load predictable.
          const customers = await listAccounts({ status: 'customer' });
          for (const a of customers) { await regenerateAccountPov(a.id); }
        }
      })
      .catch((err) => console.error('[signals/scan] background failed:', err));

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
    })
      .then(() => regenerateAccountPov(req.params.id))
      .catch((err) => console.error('[accounts/rescan]', err));

    res.redirect(`/accounts/${req.params.id}?rescan=started`);
  } catch (err) {
    next(err);
  }
});

// Unified per-account scan — fires both signal scan (news, last 60 days)
// AND prospect scan (people AT this company with recent intent signals)
// in one click. POV regenerates once both finish so the Today card is
// coherent on the next page load. This is the button on each account
// card in /brief.
webRouter.post('/accounts/:id/scan-all', requireAuth, async (req, res, next) => {
  try {
    const accountId = req.params.id;
    if (!UUID_RE.test(accountId)) return res.redirect('/brief');
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return res.redirect('/brief');

    const intel = await getAccountIntel(accountId);
    const prospectRunning = intel.prospect_scan?.status === 'running';

    // --- Signal scan (fire-and-forget, throttled to once/24h) ---
    const lastAt = await getLastScanForAccount(accountId);
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const signalScanThrottled = lastAt && Date.now() - new Date(lastAt).getTime() < ONE_DAY;

    let signalPromise = Promise.resolve();
    if (!signalScanThrottled) {
      const { rows: jobRows } = await query(
        `INSERT INTO account_signal_jobs (user_id, status) VALUES ($1, 'running') RETURNING id`,
        [req.session.userId]
      );
      const jobId = jobRows[0].id;
      signalPromise = runSignalScanCycle({
        user_id: req.session.userId,
        account_ids: [accountId],
        job_id: jobId,
      });
    }

    // --- Prospect scan (fire-and-forget via account_intel) ---
    let prospectPromise = Promise.resolve();
    if (!prospectRunning) {
      await setIntelRunning(accountId, 'prospect_scan');
      prospectPromise = (async () => {
        const out = await scanProspects(bundle.account);
        if (out.error || !out.result) {
          await setIntelFailed(accountId, 'prospect_scan', out.error || 'no_result');
          return;
        }
        await setIntelResult(accountId, 'prospect_scan', out.result);
      })().catch(async (err) => {
        console.error(`[scan-all] prospect scan ${accountId} failed:`, err);
        try { await setIntelFailed(accountId, 'prospect_scan', err.message || String(err)); } catch (_) {}
      });
    }

    // --- POV regen once both finish ---
    Promise.allSettled([signalPromise, prospectPromise])
      .then(() => regenerateAccountPov(accountId))
      .catch((err) => console.error('[scan-all] POV regen failed:', err));

    res.redirect('/brief');
  } catch (err) {
    next(err);
  }
});

// Regenerate the AI point-of-view for one account. Pulls the latest
// signals + prospect scan + metadata and runs the Haiku POV agent.
// Safe to call after any scan completes — if there's nothing material,
// the agent honestly says "no active signals".
async function regenerateAccountPov(accountId) {
  try {
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return;
    const [signals, intel] = await Promise.all([
      getSignalsForAccount(accountId, { limit: 10 }),
      getAccountIntel(accountId),
    ]);
    const prospects = intel.prospect_scan?.status === 'completed'
      ? (intel.prospect_scan.result?.prospects || [])
      : [];
    const useCaseFit = intel.use_case_fit?.status === 'completed' ? intel.use_case_fit.result : null;
    const industryInsight = intel.industry_insight?.status === 'completed' ? intel.industry_insight.result : null;

    await setIntelRunning(accountId, 'account_pov');
    const out = await generateAccountPov({
      account: bundle.account,
      signals,
      prospects,
      useCaseFit,
      industryInsight,
    });
    if (out.error || !out.result) {
      await setIntelFailed(accountId, 'account_pov', out.error || 'no_result');
      return;
    }
    await setIntelResult(accountId, 'account_pov', out.result);
    console.log(`[pov] ${accountId} — ${out.elapsed_ms}ms, priority=${out.result.priority}`);
  } catch (err) {
    console.error(`[pov] ${accountId} failed:`, err);
    try { await setIntelFailed(accountId, 'account_pov', err.message || String(err)); } catch (_) {}
  }
}

// ---------- Helpers ----------

async function getCounts(userId = null) {
  const [drafts, replies, researched, sent, unifiedCounts, playCounts] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM approval_queue WHERE status = 'pending';`),
    query(`SELECT COUNT(*)::int AS n FROM reply_queue WHERE status = 'pending';`),
    query(`SELECT COUNT(*)::int AS n FROM prospects WHERE researched_at >= date_trunc('day', NOW());`),
    query(`SELECT COUNT(*)::int AS n FROM sent_messages WHERE sent_at >= date_trunc('week', NOW());`),
    userId
      ? getUnifiedCounts(userId)
      : Promise.resolve({ this_week: 0, defense: 0, offense: 0, growth: 0, revisit: 0, unacked_total: 0 }),
    userId ? countActivePlays(userId) : Promise.resolve({ active: 0, due_soon: 0 }),
  ]);
  return {
    pendingDrafts: drafts.rows[0].n,
    pendingReplies: replies.rows[0].n,
    researchedToday: researched.rows[0].n,
    sentThisWeek: sent.rows[0].n,
    // signalsThisWeek is now the unified count across all three scanner
    // sources — customer signals + expansion triggers + revisit triggers —
    // so the dashboard card and nav badge reflect total work, not just one
    // lane. Individual lane counts remain available for per-lane chips.
    signalsThisWeek: unifiedCounts.this_week,
    signalsDefense: unifiedCounts.defense,
    signalsOffense: unifiedCounts.offense,
    signalsGrowth: unifiedCounts.growth,
    signalsRevisit: unifiedCounts.revisit,
    signalsUnacked: unifiedCounts.unacked_total,
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

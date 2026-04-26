import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { runResearchCycle } from './agents/researcher.js';
import { runWriterCycle } from './agents/writer.js';
import { runReplyCycle } from './agents/reply_agent.js';
import { runDiscoveryCycle } from './pipeline.js';
import { sendApprovedMessages } from './sender.js';
import { pollPresenceInbox } from './integrations/gmail_imap.js';
import { runRankerCycle } from './lib/presence_ranker.js';
import { runChampionCheckCycle } from './agents/champion_tracker.js';
import { runSignalScanCycle } from './agents/signal_analyzer.js';
import { startServer } from './api/server.js';
import { query, pool } from './db/index.js';

// On boot, apply db/schema.sql. Every statement is idempotent (IF NOT EXISTS /
// ADD COLUMN IF NOT EXISTS / guarded DO blocks), so re-running on every boot
// is safe and means new tables ship automatically on deploy — no manual
// `railway run npm run migrate` step.
(async () => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const schemaPath = path.resolve(path.dirname(__filename), '..', 'db', 'schema.sql');
    const sql = await fs.readFile(schemaPath, 'utf8');
    await pool.query(sql);
    console.log('[boot] schema.sql applied');
  } catch (err) {
    console.error('[boot] schema apply failed:', err.message);
  }
})();

// On boot, fail any discovery job still marked 'running' — it was either
// interrupted by a deploy/restart or it silently crashed. Leaving it
// running would keep the "searching…" banner up forever.
(async () => {
  try {
    const { rowCount } = await query(
      `UPDATE discovery_jobs
          SET status = 'failed',
              error = COALESCE(error, 'interrupted — server restarted during run'),
              finished_at = NOW()
        WHERE status = 'running'`
    );
    if (rowCount > 0) console.log(`[boot] recovered ${rowCount} orphaned discovery job(s)`);
  } catch (err) {
    // table may not exist yet on a fresh DB; ignore
    console.warn('[boot] orphan recovery skipped:', err.message);
  }
})();

// Same orphan recovery for presence_refresh_jobs — a deploy during a manual
// refresh would otherwise freeze the "Refreshing…" banner on the dashboard.
(async () => {
  try {
    const { rowCount } = await query(
      `UPDATE presence_refresh_jobs
          SET status = 'failed',
              error = COALESCE(error, 'interrupted — server restarted during refresh'),
              finished_at = NOW()
        WHERE status = 'running'`
    );
    if (rowCount > 0) console.log(`[boot] recovered ${rowCount} orphaned presence refresh job(s)`);
  } catch (err) {
    console.warn('[boot] presence orphan recovery skipped:', err.message);
  }
})();

// Orphan recovery for champion_check_jobs — same deal as above.
(async () => {
  try {
    const { rowCount } = await query(
      `UPDATE champion_check_jobs
          SET status = 'failed',
              error = COALESCE(error, 'interrupted — server restarted during check'),
              finished_at = NOW()
        WHERE status = 'running'`
    );
    if (rowCount > 0) console.log(`[boot] recovered ${rowCount} orphaned champion check job(s)`);
  } catch (err) {
    console.warn('[boot] champion orphan recovery skipped:', err.message);
  }
})();

// Orphan recovery for account_signal_jobs — the Monday Brief scan.
(async () => {
  try {
    const { rowCount } = await query(
      `UPDATE account_signal_jobs
          SET status = 'failed',
              error = COALESCE(error, 'interrupted — server restarted during scan'),
              finished_at = NOW()
        WHERE status = 'running'`
    );
    if (rowCount > 0) console.log(`[boot] recovered ${rowCount} orphaned signal scan job(s)`);
  } catch (err) {
    console.warn('[boot] signal scan orphan recovery skipped:', err.message);
  }
})();

const tz = process.env.SEND_TIMEZONE || 'America/Chicago';

// Autonomous prospect discovery — 7am Mondays only. Claude searches the web
// for fresh ICP-fit companies, then the pipeline drafts sequences for the
// ones that qualify. Weekly cadence caps the autonomous LLM spend — the
// operator can still trigger a run on demand from /drafts or /prospects/import.
cron.schedule(
  '0 7 * * 1',
  async () => {
    console.log('[scheduler] Starting weekly discovery cycle');
    try {
      await runDiscoveryCycle({ count: 5 });
    } catch (err) {
      console.error('[scheduler] discovery failed:', err);
    }
  },
  { timezone: tz }
);

// Research + score new accounts — runs 4x daily
cron.schedule(
  '0 7,11,15,19 * * 1-5',
  async () => {
    console.log('[scheduler] Starting research cycle');
    try {
      await runResearchCycle();
    } catch (err) {
      console.error('[scheduler] research failed:', err);
    }
  },
  { timezone: tz }
);

// Generate drafts for scored prospects — runs 3x daily
cron.schedule(
  '30 8,12,16 * * 1-5',
  async () => {
    console.log('[scheduler] Starting writer cycle');
    try {
      await runWriterCycle();
    } catch (err) {
      console.error('[scheduler] writer failed:', err);
    }
  },
  { timezone: tz }
);

// Monitor inbox + classify replies — every 30 min during business hours
cron.schedule(
  '*/30 8-18 * * 1-5',
  async () => {
    console.log('[scheduler] Starting reply monitoring cycle');
    try {
      await runReplyCycle();
    } catch (err) {
      console.error('[scheduler] reply monitor failed:', err);
    }
  },
  { timezone: tz }
);

// Send approved messages — runs every 2 hours within send window
cron.schedule(
  '0 9,11,13,15,17 * * 1-5',
  async () => {
    console.log('[scheduler] Sending approved messages');
    try {
      await sendApprovedMessages();
    } catch (err) {
      console.error('[scheduler] sender failed:', err);
    }
  },
  { timezone: tz }
);

// Presence copilot: poll Sales Nav digest inbox + rank + draft.
// Runs every 4h during the workday — catches the morning Sales Nav digest
// within hours of it landing, and the afternoon one too.
cron.schedule(
  '15 7,11,15,19 * * 1-5',
  async () => {
    if (!process.env.GMAIL_IMAP_USER || !process.env.GMAIL_IMAP_PASSWORD) {
      console.log('[scheduler] presence skipped — GMAIL_IMAP_USER/PASSWORD not set');
      return;
    }
    console.log('[scheduler] Starting presence poll + rank');
    try {
      const pollResult = await pollPresenceInbox();
      console.log('[scheduler] presence poll:', pollResult);
      const rankResult = await runRankerCycle();
      console.log('[scheduler] presence rank:', rankResult);
    } catch (err) {
      console.error('[scheduler] presence cycle failed:', err);
    }
  },
  { timezone: tz }
);

// Champion tracker: walk the champions table once a week, web_search each
// one, and record any job changes. Runs Monday at 8am after the discovery
// cycle. Caps per-run volume at 25 champions so a large list doesn't blow
// through LLM budget on one day — successive runs pick up the rest since
// we sort by last_checked_at NULLS FIRST.
cron.schedule(
  '0 8 * * 1',
  async () => {
    console.log('[scheduler] Starting weekly champion check');
    try {
      const { rows } = await query(
        `INSERT INTO champion_check_jobs (status) VALUES ('running') RETURNING id`
      );
      const jobId = rows[0].id;
      await runChampionCheckCycle({ limit: 25, job_id: jobId });
    } catch (err) {
      console.error('[scheduler] champion check failed:', err);
    }
  },
  { timezone: tz }
);

// Daily intel sweep: signal scan all accounts, then regen POV for any
// account where new signals landed. Runs 6am daily so "Today" shows
// what moved overnight. ~$0.10/account for signals + ~$0.01/account
// for POV regen (Haiku). Only accounts with new findings get a POV
// refresh. Set SIGNAL_SCAN_ENABLED=true to activate.
if (process.env.SIGNAL_SCAN_ENABLED === 'true') {
  const { regenerateAccountPov } = await import('./lib/pov_regen.js');
  cron.schedule(
    '0 6 * * *',
    async () => {
      console.log('[scheduler] Starting daily signal scan');
      try {
        const { rows } = await query(
          `INSERT INTO account_signal_jobs (status) VALUES ('running') RETURNING id`
        );
        const jobId = rows[0].id;
        const result = await runSignalScanCycle({ job_id: jobId });
        const changed = result.accountsWithNewSignals || [];
        if (changed.length > 0) {
          console.log(`[scheduler] signal scan done — refreshing POV for ${changed.length} account(s)`);
          for (const id of changed) {
            await regenerateAccountPov(id);
          }
        } else {
          console.log('[scheduler] signal scan done — no new signals, skipping POV regen');
        }
      } catch (err) {
        console.error('[scheduler] signal scan failed:', err);
      }
    },
    { timezone: tz }
  );
  console.log('[scheduler] daily signal scan cron registered (6am)');
} else {
  console.log('[scheduler] signal scan cron DISABLED (set SIGNAL_SCAN_ENABLED=true to enable)');
}

startServer();
console.log(`Ambition SDR Agent running. Scheduler active (${tz}).`);

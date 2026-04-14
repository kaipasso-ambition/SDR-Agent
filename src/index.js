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

const tz = process.env.SEND_TIMEZONE || 'America/Chicago';

// Autonomous prospect discovery — 7am Mon-Fri. Claude searches the web for
// fresh ICP-fit companies, then the pipeline drafts sequences for the ones
// that qualify. Round-robin's ownership across users.
cron.schedule(
  '0 7 * * 1-5',
  async () => {
    console.log('[scheduler] Starting daily discovery cycle');
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

startServer();
console.log(`Ambition SDR Agent running. Scheduler active (${tz}).`);

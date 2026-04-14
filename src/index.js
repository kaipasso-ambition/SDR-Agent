import 'dotenv/config';
import cron from 'node-cron';
import { runResearchCycle } from './agents/researcher.js';
import { runWriterCycle } from './agents/writer.js';
import { runReplyCycle } from './agents/reply_agent.js';
import { runDiscoveryCycle } from './pipeline.js';
import { sendApprovedMessages } from './sender.js';
import { startServer } from './api/server.js';
import { query } from './db/index.js';

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

startServer();
console.log(`Ambition SDR Agent running. Scheduler active (${tz}).`);

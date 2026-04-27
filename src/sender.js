// Sends approved outbound drafts, respecting the daily cap and send window.
// Email touches go through Gmail. LinkedIn touches are NEVER auto-sent —
// the PhantomBuster integration was removed after LinkedIn blocked the
// account; the operator copies the draft and sends it from their own
// LinkedIn session manually.

import 'dotenv/config';
import { query } from './db/index.js';
import { sendMessage } from './integrations/gmail.js';
import { recordSend, upsertSequence, updateSequenceStatus } from './queue/sequence_tracker.js';

const DAILY_LIMIT = Number(process.env.DAILY_EMAIL_LIMIT || 50);

function withinSendWindow(now = new Date()) {
  const start = Number(process.env.SEND_WINDOW_START || 8);
  const end = Number(process.env.SEND_WINDOW_END || 17);
  const hour = now.getHours();
  return hour >= start && hour < end;
}

async function countSentToday() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM sent_messages
     WHERE sent_at >= date_trunc('day', NOW())
       AND channel = 'email';`
  );
  return rows[0]?.n || 0;
}

async function getApprovedDrafts(limit) {
  const { rows } = await query(
    `
    SELECT aq.*, p.contact_email, p.contact_name
    FROM approval_queue aq
    JOIN prospects p ON p.id = aq.prospect_id
    WHERE aq.status = 'approved'
    ORDER BY aq.reviewed_at ASC
    LIMIT $1;
    `,
    [limit]
  );
  return rows;
}

export async function sendApprovedMessages() {
  if (!withinSendWindow()) {
    console.log('[sender] Outside send window — skipping');
    return;
  }

  const sentToday = await countSentToday();
  const remaining = DAILY_LIMIT - sentToday;
  if (remaining <= 0) {
    console.log(`[sender] Daily limit reached (${sentToday}/${DAILY_LIMIT})`);
    return;
  }

  const drafts = await getApprovedDrafts(remaining);
  if (drafts.length === 0) {
    console.log('[sender] No approved drafts to send');
    return;
  }

  for (const row of drafts) {
    try {
      await upsertSequence(row.prospect_id);
      const sequence = row.draft?.sequence || [];
      const nextTouch = sequence[0]; // MVP: send touch 1 on approval; later cycles advance touches.
      if (!nextTouch) continue;

      if (nextTouch.channel !== 'email') {
        console.log(
          `[sender] Skipping ${nextTouch.channel} touch ${nextTouch.touch} for ${row.contact_email} — ` +
          `non-email channels are manual-only. Operator should send from /drafts.`
        );
        continue;
      }

      await sendMessage({
        to: row.contact_email,
        subject: nextTouch.subject,
        body: nextTouch.body,
      });

      await recordSend({
        prospectId: row.prospect_id,
        touch: nextTouch.touch,
        channel: nextTouch.channel,
        subject: nextTouch.subject || '',
        body: nextTouch.body,
      });

      await query(
        `UPDATE approval_queue SET status = 'sent' WHERE id = $1;`,
        [row.id]
      );

      console.log(`[sender] Sent touch ${nextTouch.touch} to ${row.contact_email}`);
    } catch (err) {
      console.error(`[sender] Failed for ${row.id}:`, err.message);
      await updateSequenceStatus(row.prospect_id, 'paused').catch(() => {});
    }
  }
}

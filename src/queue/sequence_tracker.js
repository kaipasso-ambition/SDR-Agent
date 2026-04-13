import { query } from '../db/index.js';

export async function upsertSequence(prospectId) {
  const { rows } = await query(
    `
    INSERT INTO sequences (prospect_id)
    VALUES ($1)
    ON CONFLICT DO NOTHING
    RETURNING *;
    `,
    [prospectId]
  );
  return rows[0];
}

export async function updateSequenceStatus(prospectId, status, nextSendAt = null) {
  const { rows } = await query(
    `
    UPDATE sequences
    SET status = $2,
        next_send_at = COALESCE($3, next_send_at)
    WHERE prospect_id = $1
    RETURNING *;
    `,
    [prospectId, status, nextSendAt]
  );
  return rows[0];
}

export async function recordSend({ prospectId, touch, channel, subject, body }) {
  await query(
    `
    INSERT INTO sent_messages (prospect_id, touch, channel, subject, body)
    VALUES ($1, $2, $3, $4, $5);
    `,
    [prospectId, touch, channel, subject, body]
  );
  await query(
    `
    UPDATE sequences
    SET current_touch = GREATEST(current_touch, $2),
        last_sent_at = NOW()
    WHERE prospect_id = $1;
    `,
    [prospectId, touch]
  );
}

export async function getSequencesDueForSend(now = new Date()) {
  const { rows } = await query(
    `
    SELECT s.*, p.contact_email, p.contact_name
    FROM sequences s
    JOIN prospects p ON p.id = s.prospect_id
    WHERE s.status = 'active'
      AND (s.next_send_at IS NULL OR s.next_send_at <= $1);
    `,
    [now]
  );
  return rows;
}

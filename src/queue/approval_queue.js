import { query } from '../db/index.js';

export async function addToApprovalQueue({ prospect, draft, status = 'pending' }) {
  const sql = `
    INSERT INTO approval_queue (prospect_id, draft, status)
    VALUES ($1, $2, $3)
    RETURNING *;
  `;
  const { rows } = await query(sql, [prospect.id, draft, status]);
  return rows[0];
}

export async function addToReplyQueue({
  prospect_id,
  original_reply,
  classification,
  draft_response,
  referral_draft,
  escalate,
  escalate_reason,
  notes,
}) {
  const sql = `
    INSERT INTO reply_queue (
      prospect_id, original_reply, classification, draft_response,
      referral_draft, escalate, escalate_reason, notes
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;
  `;
  const { rows } = await query(sql, [
    prospect_id,
    original_reply,
    classification,
    draft_response || '',
    referral_draft || '',
    escalate || false,
    escalate_reason || '',
    notes || '',
  ]);
  return rows[0];
}

export async function getPendingDrafts() {
  const { rows } = await query(`
    SELECT
      aq.*,
      p.company, p.contact_name, p.contact_title, p.contact_email,
      p.persona, p.industry, p.seniority, p.fit_score AS prospect_fit_score,
      p.timing_signal, p.timing_signal_source, p.customer_status,
      p.additional_context
    FROM approval_queue aq
    JOIN prospects p ON p.id = aq.prospect_id
    WHERE aq.status = 'pending'
    ORDER BY aq.queued_at ASC;
  `);
  return rows;
}

export async function getPendingReplies() {
  const { rows } = await query(`
    SELECT rq.*, p.company, p.contact_name, p.contact_email
    FROM reply_queue rq
    JOIN prospects p ON p.id = rq.prospect_id
    WHERE rq.status = 'pending'
    ORDER BY rq.queued_at ASC;
  `);
  return rows;
}

export async function setApprovalStatus(id, status) {
  const { rows } = await query(
    `UPDATE approval_queue SET status = $2, reviewed_at = NOW() WHERE id = $1 RETURNING *;`,
    [id, status]
  );
  return rows[0];
}

export async function setReplyStatus(id, status) {
  const { rows } = await query(
    `UPDATE reply_queue SET status = $2, reviewed_at = NOW() WHERE id = $1 RETURNING *;`,
    [id, status]
  );
  return rows[0];
}

export async function updateDraft(id, draft) {
  const { rows } = await query(
    `UPDATE approval_queue SET draft = $2 WHERE id = $1 RETURNING *;`,
    [id, draft]
  );
  return rows[0];
}

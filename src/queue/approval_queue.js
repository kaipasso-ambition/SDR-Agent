import { query } from '../db/index.js';

export async function addToApprovalQueue({ prospect, draft, status = 'pending', campaign_id = null }) {
  const sql = `
    INSERT INTO approval_queue (prospect_id, draft, status, campaign_id)
    VALUES ($1, $2, $3, $4)
    RETURNING *;
  `;
  const { rows } = await query(sql, [prospect.id, draft, status, campaign_id]);
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

export async function getPendingDrafts(userId = null) {
  const { rows } = await query(`
    SELECT
      aq.*,
      p.company, p.contact_name, p.contact_title, p.contact_email,
      p.persona, p.industry, p.seniority, p.fit_score AS prospect_fit_score,
      p.timing_signal, p.timing_signal_source, p.customer_status,
      p.additional_context, p.owner_user_id,
      c.name AS campaign_name,
      (SELECT special_invite FROM campaign_prospects cp
        WHERE cp.campaign_id = aq.campaign_id AND cp.prospect_id = aq.prospect_id) AS campaign_special_invite
    FROM approval_queue aq
    JOIN prospects p ON p.id = aq.prospect_id
    LEFT JOIN campaigns c ON c.id = aq.campaign_id
    WHERE aq.status = 'pending'
      AND ($1::uuid IS NULL OR p.owner_user_id = $1 OR p.owner_user_id IS NULL)
    ORDER BY aq.queued_at ASC;
  `, [userId]);
  return rows;
}

export async function getPendingReplies(userId = null) {
  const { rows } = await query(`
    SELECT rq.*, p.company, p.contact_name, p.contact_email, p.owner_user_id
    FROM reply_queue rq
    JOIN prospects p ON p.id = rq.prospect_id
    WHERE rq.status = 'pending'
      AND ($1::uuid IS NULL OR p.owner_user_id = $1 OR p.owner_user_id IS NULL)
    ORDER BY rq.queued_at ASC;
  `, [userId]);
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

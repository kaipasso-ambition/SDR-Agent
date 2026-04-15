// Game-plan DB layer. Three concerns, one module:
//
// 1. Contacts — the chess board. CRUD + movable (re-role, re-stance, re-parent).
//    upsertContactFromMention() is the auto-place hook that fires from
//    insertSignals() when Claude returns mentioned_contacts on a signal.
//    Contacts land with source='signal_mention' so the UI can flag
//    "review this auto-placed piece" until the AE confirms.
//
// 2. Hypotheses — theory of the case. Lightweight CRUD; evidence_signal_ids
//    is a UUID[] so attaching/detaching a signal is a single UPDATE.
//
// 3. Plays — the move artifact. Composer inserts instinct + contact_path and
//    either fires the play_builder agent inline or leaves ai_expansion NULL
//    for the caller to fill asynchronously.

import { query } from './index.js';

// ---------- Contacts ----------

// List every contact on an account with reports_to resolved to a display
// name — lets the view build the tree without a second round-trip. Returns
// rows ordered by deal_role priority then name so the UI can render the
// buying committee at the top of the list even before tree-building.
export async function listContactsForAccount(accountId) {
  const { rows } = await query(
    `SELECT c.*,
            parent.name AS reports_to_name,
            parent.title AS reports_to_title
       FROM account_contacts c
       LEFT JOIN account_contacts parent
         ON parent.id = c.reports_to_contact_id
      WHERE c.account_id = $1
      ORDER BY
        CASE c.deal_role
          WHEN 'economic_buyer' THEN 1
          WHEN 'champion'       THEN 2
          WHEN 'coach'          THEN 3
          WHEN 'influencer'     THEN 4
          WHEN 'user'           THEN 5
          WHEN 'blocker'        THEN 6
          ELSE 7
        END,
        c.name`,
    [accountId]
  );
  return rows;
}

export async function getContactById(id) {
  const { rows } = await query(
    `SELECT * FROM account_contacts WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Manual contact create from the Plan page. Returns the new row.
export async function createContact({
  account_id,
  name,
  title = null,
  email = null,
  linkedin_url = null,
  deal_role = 'unknown',
  stance = 'neutral',
  reports_to_contact_id = null,
  notes = null,
  created_by_user_id = null,
}) {
  const { rows } = await query(
    `INSERT INTO account_contacts (
       account_id, name, title, email, linkedin_url,
       deal_role, stance, reports_to_contact_id, notes, source, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10)
     RETURNING *`,
    [
      account_id, name, title, email, linkedin_url,
      deal_role, stance, reports_to_contact_id, notes, created_by_user_id,
    ]
  );
  return rows[0];
}

// Movable. Only the fields the user edits — never account_id (would break
// referential assumptions) and never source (audit). Null values overwrite,
// undefined values leave the column alone.
export async function updateContact(id, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  const editable = [
    'name', 'title', 'email', 'linkedin_url',
    'deal_role', 'stance', 'reports_to_contact_id', 'notes',
    'last_touchpoint_at', 'last_touchpoint_type',
  ];
  for (const k of editable) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${++i}`);
      values.push(patch[k]);
    }
  }
  if (fields.length === 0) return getContactById(id);
  fields.push(`updated_at = NOW()`);
  const { rows } = await query(
    `UPDATE account_contacts SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0] || null;
}

export async function deleteContact(id) {
  await query(`DELETE FROM account_contacts WHERE id = $1`, [id]);
}

// Auto-placement from a signal mention. Dedup rule: if a contact with the
// same (account_id, LOWER(name)) already exists, we do NOT overwrite — the
// AE's manual classification always wins over the model's guess. Only when
// the existing row is itself signal-placed and still has deal_role='unknown'
// do we upgrade it with the model's guess.
//
// Returns the contact row (new or existing) so the caller can link to it.
export async function upsertContactFromMention({
  account_id,
  name,
  title = null,
  deal_role_guess = 'unknown',
}) {
  if (!name || !name.trim()) return null;
  const normalized = name.trim();

  // Map the model's persona-style guess onto our deal_role enum — the
  // prompt already constrains it but belt + braces in case the model
  // fabricates a role.
  const ALLOWED = new Set([
    'economic_buyer', 'champion', 'coach', 'influencer', 'blocker', 'user', 'unknown',
  ]);
  const role = ALLOWED.has(deal_role_guess) ? deal_role_guess : 'unknown';

  const existing = await query(
    `SELECT * FROM account_contacts
      WHERE account_id = $1 AND LOWER(name) = LOWER($2)
      LIMIT 1`,
    [account_id, normalized]
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    // Upgrade only if the existing row is itself a signal mention that
    // hasn't been classified yet. Never clobber an AE's manual role.
    if (row.source === 'signal_mention' && row.deal_role === 'unknown' && role !== 'unknown') {
      const { rows } = await query(
        `UPDATE account_contacts
            SET deal_role = $2, title = COALESCE($3, title), updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [row.id, role, title]
      );
      return rows[0];
    }
    return row;
  }

  const { rows } = await query(
    `INSERT INTO account_contacts (
       account_id, name, title, deal_role, stance, source
     ) VALUES ($1, $2, $3, $4, 'neutral', 'signal_mention')
     RETURNING *`,
    [account_id, normalized, title, role]
  );
  return rows[0];
}

// ---------- Hypotheses ----------

export async function listHypothesesForAccount(accountId) {
  const { rows } = await query(
    `SELECT h.*,
            COALESCE(array_length(h.evidence_signal_ids, 1), 0) AS evidence_count
       FROM account_hypotheses h
      WHERE h.account_id = $1
      ORDER BY
        CASE h.status WHEN 'validated' THEN 1 WHEN 'theory' THEN 2 ELSE 3 END,
        h.confidence DESC,
        h.created_at DESC`,
    [accountId]
  );
  return rows;
}

export async function getHypothesisById(id) {
  const { rows } = await query(
    `SELECT * FROM account_hypotheses WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function createHypothesis({
  account_id,
  use_case,
  target_persona_id,
  narrative_hook,
  narrative = null,   // {current_state, future_state, bridge} — the Nasralla three-beat
  evidence_signal_ids = [],
  confidence = 3,
  status = 'theory',
  created_by_user_id = null,
}) {
  const { rows } = await query(
    `INSERT INTO account_hypotheses (
       account_id, use_case, target_persona_id, narrative_hook, narrative,
       evidence_signal_ids, confidence, status, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9)
     RETURNING *`,
    [
      account_id, use_case, target_persona_id, narrative_hook,
      narrative ? JSON.stringify(narrative) : null,
      evidence_signal_ids, confidence, status, created_by_user_id,
    ]
  );
  return rows[0];
}

export async function updateHypothesis(id, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  const editable = [
    'use_case', 'target_persona_id', 'narrative_hook',
    'evidence_signal_ids', 'confidence', 'status',
  ];
  for (const k of editable) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${++i}${k === 'evidence_signal_ids' ? '::uuid[]' : ''}`);
      values.push(patch[k]);
    }
  }
  if (patch.narrative !== undefined) {
    fields.push(`narrative = $${++i}`);
    values.push(patch.narrative ? JSON.stringify(patch.narrative) : null);
  }
  if (fields.length === 0) return getHypothesisById(id);
  fields.push(`updated_at = NOW()`);
  const { rows } = await query(
    `UPDATE account_hypotheses SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0] || null;
}

export async function deleteHypothesis(id) {
  await query(`DELETE FROM account_hypotheses WHERE id = $1`, [id]);
}

// ---------- Plays ----------

export async function listPlaysForAccount(accountId) {
  const { rows } = await query(
    `SELECT p.*,
            h.use_case AS hypothesis_use_case,
            h.narrative_hook AS hypothesis_hook,
            s.title AS trigger_signal_title,
            s.risk_class AS trigger_signal_risk_class,
            u.name AS author_name
       FROM account_plays p
       LEFT JOIN account_hypotheses h ON h.id = p.hypothesis_id
       LEFT JOIN account_signals s   ON s.id = p.triggered_by_signal_id
       LEFT JOIN users u             ON u.id = p.author_user_id
      WHERE p.account_id = $1
      ORDER BY
        CASE p.status
          WHEN 'active'   THEN 1
          WHEN 'drafting' THEN 2
          WHEN 'paused'   THEN 3
          WHEN 'won'      THEN 4
          WHEN 'lost'     THEN 5
          ELSE 6
        END,
        p.updated_at DESC`,
    [accountId]
  );
  return rows;
}

export async function getPlayById(id) {
  const { rows } = await query(
    `SELECT p.*,
            a.account_name, a.id AS account_id_resolved, a.domain,
            h.use_case AS hypothesis_use_case,
            h.narrative_hook AS hypothesis_hook,
            s.title AS trigger_signal_title,
            u.name AS author_name
       FROM account_plays p
       JOIN accounts_registry a ON a.id = p.account_id
       LEFT JOIN account_hypotheses h ON h.id = p.hypothesis_id
       LEFT JOIN account_signals s   ON s.id = p.triggered_by_signal_id
       LEFT JOIN users u             ON u.id = p.author_user_id
      WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function createPlay({
  account_id,
  hypothesis_id = null,
  triggered_by_signal_id = null,
  author_user_id = null,
  instinct,
  ai_expansion = null,
  contact_path = [],
  status = 'drafting',
  next_action = null,
  next_action_due = null,
}) {
  const { rows } = await query(
    `INSERT INTO account_plays (
       account_id, hypothesis_id, triggered_by_signal_id, author_user_id,
       instinct, ai_expansion, contact_path, status, next_action, next_action_due
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10)
     RETURNING *`,
    [
      account_id, hypothesis_id, triggered_by_signal_id, author_user_id,
      instinct, ai_expansion ? JSON.stringify(ai_expansion) : null,
      contact_path, status, next_action, next_action_due,
    ]
  );
  return rows[0];
}

export async function updatePlay(id, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  const editable = [
    'hypothesis_id', 'instinct', 'contact_path', 'status',
    'next_action', 'next_action_due',
  ];
  for (const k of editable) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${++i}${k === 'contact_path' ? '::uuid[]' : ''}`);
      values.push(patch[k]);
    }
  }
  if (patch.ai_expansion !== undefined) {
    fields.push(`ai_expansion = $${++i}`);
    values.push(patch.ai_expansion ? JSON.stringify(patch.ai_expansion) : null);
  }
  if (fields.length === 0) return getPlayById(id);
  fields.push(`updated_at = NOW()`);
  const { rows } = await query(
    `UPDATE account_plays SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0] || null;
}

export async function deletePlay(id) {
  await query(`DELETE FROM account_plays WHERE id = $1`, [id]);
}

// Dashboard feed: active plays with a next action due in the next 7 days
// OR overdue. Scoped to user's accounts (owner_user_id = user or NULL).
export async function getPlaysNeedingAction(userId, { limit = 10 } = {}) {
  const { rows } = await query(
    `SELECT p.id, p.instinct, p.next_action, p.next_action_due, p.status,
            p.ai_expansion->>'named_play' AS named_play,
            a.id AS account_id, a.account_name
       FROM account_plays p
       JOIN accounts_registry a ON a.id = p.account_id
      WHERE p.status = 'active'
        AND (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
        AND (p.next_action_due IS NULL OR p.next_action_due <= CURRENT_DATE + INTERVAL '7 days')
      ORDER BY p.next_action_due NULLS LAST, p.updated_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function countActivePlays(userId) {
  const { rows } = await query(
    `SELECT
        COUNT(*) FILTER (WHERE p.status = 'active')::int AS active,
        COUNT(*) FILTER (
          WHERE p.status = 'active'
            AND p.next_action_due IS NOT NULL
            AND p.next_action_due <= CURRENT_DATE + INTERVAL '7 days'
        )::int AS due_soon
       FROM account_plays p
       JOIN accounts_registry a ON a.id = p.account_id
      WHERE (a.owner_user_id = $1 OR a.owner_user_id IS NULL)`,
    [userId]
  );
  return rows[0] || { active: 0, due_soon: 0 };
}

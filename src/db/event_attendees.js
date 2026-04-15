// Event attendees (targets) DB layer. The AE pastes or manually adds
// people who are likely attending an event — the list drives the
// execution surface (draft session invites, draft meeting requests).
// Company matching to accounts_registry is best-effort via LOWER(name)
// substring match; a miss just leaves account_id NULL.

import { query } from './index.js';

// Attendees for one event, joined to any matched account so the view
// can show "on your book as a Customer" vs. net-new.
export async function listAttendeesForEvent(eventId) {
  const { rows } = await query(
    `SELECT a.*,
            r.account_name       AS matched_account_name,
            r.status             AS matched_account_status,
            r.owner_user_id      AS matched_account_owner_id,
            u.name               AS added_by_name,
            ui.name              AS invited_by_name,
            -- Follow-up is overdue when it's been scheduled, not yet done,
            -- and the due time has passed. Computed here so the view stays dumb.
            (a.followup_due_at IS NOT NULL
              AND a.followup_done_at IS NULL
              AND a.followup_due_at <= NOW()) AS followup_overdue
       FROM event_attendees a
       LEFT JOIN accounts_registry r ON r.id = a.account_id
       LEFT JOIN users u             ON u.id = a.added_by_user_id
       LEFT JOIN users ui            ON ui.id = a.invited_by_user_id
      WHERE a.event_id = $1
      ORDER BY
        -- Overdue follow-ups float to the top — that's the AE's
        -- "don't drop the thread" bucket.
        (a.followup_due_at IS NOT NULL
          AND a.followup_done_at IS NULL
          AND a.followup_due_at <= NOW()) DESC,
        CASE a.invite_status
          WHEN 'target'   THEN 1
          WHEN 'invited'  THEN 2
          WHEN 'accepted' THEN 3
          WHEN 'met'      THEN 4
          WHEN 'declined' THEN 5
          WHEN 'passed'   THEN 6
        END,
        a.created_at ASC`,
    [eventId]
  );
  return rows;
}

export async function getAttendeeById(id) {
  const { rows } = await query(
    `SELECT a.*,
            r.account_name AS matched_account_name,
            r.domain       AS matched_account_domain,
            r.industry     AS matched_account_industry,
            r.status       AS matched_account_status
       FROM event_attendees a
       LEFT JOIN accounts_registry r ON r.id = a.account_id
      WHERE a.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Best-effort account match by company name. Lightweight fuzzy match:
// exact LOWER equality first, then a substring match either way so
// "Meridian" resolves to "Meridian Freight Solutions" and vice versa.
// Returns an account_id or null.
export async function findAccountIdForCompany(company) {
  if (!company || !company.trim()) return null;
  const needle = company.trim().toLowerCase();
  const { rows } = await query(
    `SELECT id FROM accounts_registry
      WHERE LOWER(account_name) = $1
      LIMIT 1`,
    [needle]
  );
  if (rows[0]) return rows[0].id;
  const { rows: fuzzy } = await query(
    `SELECT id FROM accounts_registry
      WHERE LOWER(account_name) LIKE '%' || $1 || '%'
         OR $1 LIKE '%' || LOWER(account_name) || '%'
      ORDER BY LENGTH(account_name) ASC
      LIMIT 1`,
    [needle]
  );
  return fuzzy[0]?.id || null;
}

export async function createAttendee({
  event_id,
  name,
  title = null,
  company = null,
  linkedin_url = null,
  email = null,
  account_id = null,
  notes = null,
  source = 'manual',
  added_by_user_id = null,
}) {
  // Auto-match an account if the caller didn't pass one.
  const resolvedAccountId = account_id || (company
    ? await findAccountIdForCompany(company)
    : null);
  const { rows } = await query(
    `INSERT INTO event_attendees (
       event_id, name, title, company, linkedin_url, email,
       account_id, notes, source, added_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      event_id, name, title, company, linkedin_url, email,
      resolvedAccountId, notes, source, added_by_user_id,
    ]
  );
  return rows[0];
}

// Bulk create from a paste-table. Each row must have at least a name.
// Returns the inserted rows. Skips rows missing name silently.
export async function bulkCreateAttendees(eventId, rows, addedByUserId = null) {
  const out = [];
  for (const r of rows) {
    if (!r.name || !r.name.trim()) continue;
    const inserted = await createAttendee({
      event_id: eventId,
      name: r.name.trim(),
      title: r.title?.trim() || null,
      company: r.company?.trim() || null,
      linkedin_url: r.linkedin_url?.trim() || null,
      email: r.email?.trim() || null,
      source: 'paste',
      added_by_user_id: addedByUserId,
    });
    out.push(inserted);
  }
  return out;
}

export async function updateAttendee(id, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  const editable = [
    'name', 'title', 'company', 'linkedin_url', 'email',
    'account_id', 'invite_status', 'invite_draft', 'meeting_draft', 'notes',
  ];
  for (const k of editable) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${++i}`);
      values.push(patch[k]);
    }
  }
  if (fields.length === 0) return getAttendeeById(id);
  fields.push(`updated_at = NOW()`);
  const { rows } = await query(
    `UPDATE event_attendees SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0] || null;
}

export async function deleteAttendee(id) {
  await query(`DELETE FROM event_attendees WHERE id = $1`, [id]);
}

// Mark an attendee as invited AND schedule a follow-up N days out.
// This is the explicit "I sent the note" action — far clearer than
// the status dropdown, and it plants the reminder to circle back so
// the AE doesn't let a warm thread go cold.
export async function markInvited(id, { days = 3, userId = null } = {}) {
  const { rows } = await query(
    `UPDATE event_attendees
        SET invite_status      = 'invited',
            invited_at         = COALESCE(invited_at, NOW()),
            invited_by_user_id = COALESCE(invited_by_user_id, $3),
            followup_due_at    = NOW() + ($2 || ' days')::INTERVAL,
            followup_done_at   = NULL,
            updated_at         = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, String(days), userId]
  );
  return rows[0] || null;
}

export async function markFollowupDone(id) {
  const { rows } = await query(
    `UPDATE event_attendees
        SET followup_done_at = NOW(),
            updated_at       = NOW()
      WHERE id = $1
      RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

// Kick the follow-up N more days into the future. Doesn't clear
// invited_at — the "sent on X" record stays; we're just pushing when
// we want to re-surface this person.
export async function snoozeFollowup(id, { days = 3 } = {}) {
  const { rows } = await query(
    `UPDATE event_attendees
        SET followup_due_at  = GREATEST(COALESCE(followup_due_at, NOW()), NOW())
                                 + ($2 || ' days')::INTERVAL,
            followup_done_at = NULL,
            updated_at       = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, String(days)]
  );
  return rows[0] || null;
}

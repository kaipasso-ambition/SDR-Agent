// Event / one-off DB layer. Events (Gartner, CVI dinner, launch
// campaigns) are the moments where "the play" isn't scoped to a single
// account — it's a coordinating artifact that spans many accounts.
// Each account still gets its own row in account_plays; the event_id
// is what groups them. Individual account-level play CRUD stays in
// game_plan.js.
//
// Contract: when an event is deleted, child plays get event_id NULLed
// (they keep their instinct + expansion, just detach from the event).
// That's the SET NULL on the FK.

import { query } from './index.js';

export async function listEvents({ includeCompleted = true } = {}) {
  const whereStatus = includeCompleted
    ? ''
    : `WHERE e.status IN ('planning','active')`;
  const { rows } = await query(
    `SELECT e.*,
            u.name AS created_by_name,
            (SELECT COUNT(*)::int FROM account_plays p WHERE p.event_id = e.id) AS play_count,
            (SELECT COUNT(*)::int FROM account_plays p
              WHERE p.event_id = e.id AND p.status IN ('drafting','active','paused')) AS open_play_count
       FROM play_events e
       LEFT JOIN users u ON u.id = e.created_by_user_id
      ${whereStatus}
      ORDER BY
        CASE e.status
          WHEN 'active'    THEN 1
          WHEN 'planning'  THEN 2
          WHEN 'completed' THEN 3
          WHEN 'cancelled' THEN 4
          ELSE 5
        END,
        e.event_date ASC NULLS LAST,
        e.created_at DESC`
  );
  return rows;
}

export async function getEventById(id) {
  const { rows } = await query(
    `SELECT e.*, u.name AS created_by_name
       FROM play_events e
       LEFT JOIN users u ON u.id = e.created_by_user_id
      WHERE e.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// All plays attached to an event, with their account joined so the
// /events/:id view can render "Dialpad → named play → status" rows
// without a second round-trip.
export async function listPlaysForEvent(eventId) {
  const { rows } = await query(
    `SELECT p.*,
            a.account_name,
            a.status AS account_status,
            a.industry AS account_industry,
            u.name AS author_name
       FROM account_plays p
       JOIN accounts_registry a ON a.id = p.account_id
       LEFT JOIN users u ON u.id = p.author_user_id
      WHERE p.event_id = $1
      ORDER BY
        CASE p.status
          WHEN 'active'   THEN 1
          WHEN 'drafting' THEN 2
          WHEN 'paused'   THEN 3
          WHEN 'won'      THEN 4
          WHEN 'lost'     THEN 5
          ELSE 6
        END,
        a.account_name ASC`,
    [eventId]
  );
  return rows;
}

export async function createEvent({
  name,
  kind = 'event',
  event_date = null,
  location = null,
  description = null,
  context = null,
  reference_links = [],
  status = 'planning',
  created_by_user_id = null,
}) {
  const { rows } = await query(
    `INSERT INTO play_events (
       name, kind, event_date, location, description, context,
       reference_links, status, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9)
     RETURNING *`,
    [
      name, kind, event_date, location, description,
      context ? JSON.stringify(context) : null,
      reference_links,
      status, created_by_user_id,
    ]
  );
  return rows[0];
}

export async function updateEvent(id, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  const editable = ['name', 'kind', 'event_date', 'location', 'description', 'status'];
  for (const k of editable) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${++i}`);
      values.push(patch[k]);
    }
  }
  if (patch.context !== undefined) {
    fields.push(`context = $${++i}`);
    values.push(patch.context ? JSON.stringify(patch.context) : null);
  }
  if (patch.reference_links !== undefined) {
    fields.push(`reference_links = $${++i}::text[]`);
    values.push(patch.reference_links || []);
  }
  if (patch.personal_invite_session !== undefined) {
    fields.push(`personal_invite_session = $${++i}`);
    values.push(patch.personal_invite_session
      ? JSON.stringify(patch.personal_invite_session)
      : null);
  }
  if (fields.length === 0) return getEventById(id);
  fields.push(`updated_at = NOW()`);
  const { rows } = await query(
    `UPDATE play_events SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0] || null;
}

// Research lifecycle — tiny helpers so the agent doesn't have to
// reach into the DB directly. setResearchStatus flips the badge the
// UI shows; completeResearch writes both the payload and the
// timestamp in one statement so the view never sees a half-updated
// row.
export async function setResearchStatus(id, status, error = null) {
  await query(
    `UPDATE play_events
        SET research_status = $2, research_error = $3, updated_at = NOW()
      WHERE id = $1`,
    [id, status, error]
  );
}

export async function completeResearch(id, context) {
  const { rows } = await query(
    `UPDATE play_events
        SET context = $2,
            research_status = 'completed',
            research_error = NULL,
            researched_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, context ? JSON.stringify(context) : null]
  );
  return rows[0] || null;
}

export async function deleteEvent(id) {
  await query(`DELETE FROM play_events WHERE id = $1`, [id]);
}

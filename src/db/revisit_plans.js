// revisit_plans: stores the three re-entry paths per trigger, the AE's
// selection, and the eventual outcome. Over time the outcome data feeds
// back into the path generator to improve recommendations.

import { query } from './index.js';

export async function createRevisitPaths({ opportunity_id, trigger_index, trigger_title, paths }) {
  const { rows } = await query(
    `INSERT INTO revisit_paths (opportunity_id, trigger_index, trigger_title, paths)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [opportunity_id, trigger_index, trigger_title || null, JSON.stringify(paths)]
  );
  return rows[0];
}

export async function getPathsForDeal(opportunityId) {
  const { rows } = await query(
    `SELECT * FROM revisit_paths
      WHERE opportunity_id = $1
      ORDER BY created_at DESC`,
    [opportunityId]
  );
  return rows;
}

export async function getPathsById(id) {
  const { rows } = await query(
    `SELECT * FROM revisit_paths WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function selectPath(id, pathIndex) {
  await query(
    `UPDATE revisit_paths
        SET selected_path = $2,
            selected_at   = NOW()
      WHERE id = $1`,
    [id, pathIndex]
  );
}

export async function setOutcome(id, { outcome, notes }) {
  await query(
    `UPDATE revisit_paths
        SET outcome       = $2,
            outcome_notes = $3,
            outcome_at    = NOW()
      WHERE id = $1`,
    [id, outcome, notes || null]
  );
}

// ---------- Portfolio view ----------
//
// Everything the /revisit dashboard needs. Three queries, kept separate so
// the route can parallelize them — the dashboard has to be snappy.

/**
 * Roll-up counters for the top of the page. One query returns all the
 * numbers so we're not making 5 round-trips.
 */
export async function getPortfolioStats() {
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (
         WHERE selected_path IS NOT NULL
           AND (outcome IS NULL OR outcome = 'in_progress')
       )::int AS in_flight,
       COUNT(*) FILTER (WHERE outcome = 'won')::int         AS won,
       COUNT(*) FILTER (WHERE outcome = 'lost')::int        AS lost,
       COUNT(*) FILTER (WHERE outcome = 'no_response')::int AS no_response,
       COUNT(*) FILTER (
         WHERE selected_path IS NOT NULL
           AND outcome IS NULL
           AND selected_at < NOW() - INTERVAL '21 days'
       )::int AS stalled,
       COUNT(*) FILTER (
         WHERE selected_path IS NULL
       )::int AS built_not_selected
     FROM revisit_paths`
  );
  return rows[0];
}

/**
 * Every path the AE has a meeting-outcome bet on right now. Includes the
 * selected path's predicted metrics so we can compute "overdue vs. model
 * prediction" in the view without a second query.
 */
export async function listInFlightPaths() {
  const { rows } = await query(
    `SELECT rp.id, rp.opportunity_id, rp.trigger_index, rp.trigger_title,
            rp.paths, rp.selected_path, rp.selected_at,
            rp.outcome, rp.created_at,
            dd.close_date, dd.loss_reason, dd.account_type_at_close,
            dd.owner_name,
            a.account_name, a.domain, a.status AS account_status,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - rp.selected_at)) / 86400)::int AS days_since_selected
       FROM revisit_paths rp
       JOIN dead_deals dd        ON dd.opportunity_id = rp.opportunity_id
       JOIN accounts_registry a  ON a.id = dd.account_id
      WHERE rp.selected_path IS NOT NULL
        AND (rp.outcome IS NULL OR rp.outcome = 'in_progress')
      ORDER BY rp.selected_at DESC NULLS LAST`
  );
  return rows;
}

/**
 * Recent won/lost/no_response — the learning signal. Used both for the
 * hit-rate tile and the "recent outcomes" strip.
 */
export async function listRecentOutcomes({ limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT rp.id, rp.opportunity_id, rp.trigger_title, rp.paths,
            rp.selected_path, rp.outcome, rp.outcome_notes, rp.outcome_at,
            rp.selected_at,
            dd.loss_reason,
            a.account_name, a.domain
       FROM revisit_paths rp
       JOIN dead_deals dd       ON dd.opportunity_id = rp.opportunity_id
       JOIN accounts_registry a ON a.id = dd.account_id
      WHERE rp.outcome IS NOT NULL
        AND rp.outcome <> 'in_progress'
      ORDER BY rp.outcome_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

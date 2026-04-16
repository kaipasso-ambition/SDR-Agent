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

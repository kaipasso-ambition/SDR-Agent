// account_expansion_dossier — one row per active-customer expansion play.
// Phase 1 is just the persistence layer for the dossier + notes; the
// scanner + path generator come in Phase 2, reading both through this module.

import { query } from './index.js';

// ---------- Dossier ----------

export async function getDossier(accountId) {
  const { rows } = await query(
    `SELECT * FROM account_expansion_dossier WHERE account_id = $1 LIMIT 1`,
    [accountId]
  );
  return rows[0] || null;
}

/**
 * Upsert. The edit form posts every field every time, so we overwrite the
 * whole row — no patch semantics to worry about. Empty strings become NULL
 * so absent fields don't show up as blank lines in the prompt context.
 */
export async function upsertDossier(accountId, { footprint, destination, stack_competitive, open_questions }) {
  const clean = (s) => {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    return t.length === 0 ? null : t;
  };
  const { rows } = await query(
    `INSERT INTO account_expansion_dossier
       (account_id, footprint, destination, stack_competitive, open_questions, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (account_id) DO UPDATE SET
       footprint         = EXCLUDED.footprint,
       destination       = EXCLUDED.destination,
       stack_competitive = EXCLUDED.stack_competitive,
       open_questions    = EXCLUDED.open_questions,
       updated_at        = NOW()
     RETURNING *`,
    [accountId, clean(footprint), clean(destination), clean(stack_competitive), clean(open_questions)]
  );
  return rows[0];
}

// ---------- Notes ----------

export async function addExpansionNote({ account_id, note, user_id }) {
  const { rows } = await query(
    `INSERT INTO expansion_notes (account_id, note, created_by_user_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [account_id, note, user_id || null]
  );
  return rows[0];
}

export async function listExpansionNotes(accountId) {
  const { rows } = await query(
    `SELECT n.id, n.note, n.created_at, u.name AS created_by_name
       FROM expansion_notes n
       LEFT JOIN users u ON u.id = n.created_by_user_id
      WHERE n.account_id = $1
      ORDER BY n.created_at DESC`,
    [accountId]
  );
  return rows;
}

export async function getExpansionNote(id) {
  const { rows } = await query(
    `SELECT * FROM expansion_notes WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function deleteExpansionNote(id) {
  await query(`DELETE FROM expansion_notes WHERE id = $1`, [id]);
}

// ---------- Portfolio view ----------
//
// Every active customer with a "where you are vs. where you're going" column
// computed from the dossier. Customers without a dossier show up too — they're
// the ones that need one. Ranked: dossier-with-recent-note first (active
// plays), dossier-without-recent-note next (stale), no-dossier last (untouched).

export async function listExpansionPortfolio() {
  const { rows } = await query(
    `SELECT a.id, a.account_name, a.domain, a.status, a.industry,
            d.footprint IS NOT NULL                       AS has_dossier,
            d.destination IS NOT NULL                     AS has_destination,
            d.updated_at                                  AS dossier_updated_at,
            COALESCE(nc.note_count, 0)::int               AS note_count,
            nc.last_note_at                               AS last_note_at
       FROM accounts_registry a
       LEFT JOIN account_expansion_dossier d ON d.account_id = a.id
       LEFT JOIN (
         SELECT account_id,
                COUNT(*)        AS note_count,
                MAX(created_at) AS last_note_at
           FROM expansion_notes
          GROUP BY account_id
       ) nc ON nc.account_id = a.id
      WHERE a.status = 'customer'
      ORDER BY
        -- Active plays first (dossier + a recent note), stale next, untouched last.
        (CASE WHEN d.account_id IS NOT NULL AND nc.last_note_at IS NOT NULL THEN 0
              WHEN d.account_id IS NOT NULL THEN 1
              ELSE 2 END),
        COALESCE(nc.last_note_at, d.updated_at) DESC NULLS LAST,
        a.account_name ASC`
  );
  return rows;
}

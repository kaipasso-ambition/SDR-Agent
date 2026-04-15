// Champion-tracker DB helpers. Keeps the paste-CSV upsert, the weekly
// job-move checker, and the /champions list view out of the route file.

import { query } from './index.js';

const VALID_SOURCE = new Set(['customer_champion', 'foa', 'churned_customer_contact']);
const VALID_TIER = new Set(['hot', 'warm', 'casual']);

// Normalize/coerce a single CSV row into a champion insert payload.
// Returns { ok, champion, errors }. We don't throw on bad rows — the UI shows
// per-row feedback so the operator can fix + re-paste without losing the rest.
function normalizeChampionRow(row) {
  const errors = [];
  const full_name = (row.full_name || row.name || '').trim();
  if (!full_name) errors.push('missing full_name');

  const linkedin_url = (row.linkedin_url || row.linkedin || '').trim() || null;
  const email = (row.email || '').trim().toLowerCase() || null;
  if (!linkedin_url && !email) errors.push('need at least linkedin_url or email as identity');

  const source = (row.source || 'customer_champion').trim().toLowerCase();
  if (!VALID_SOURCE.has(source)) errors.push(`bad source "${source}"`);

  const tier = (row.tier || '').trim().toLowerCase() || null;
  if (tier && !VALID_TIER.has(tier)) errors.push(`bad tier "${tier}"`);

  return {
    ok: errors.length === 0,
    errors,
    champion: {
      full_name,
      email,
      linkedin_url,
      current_company: (row.current_company || row.company || '').trim() || null,
      current_title: (row.current_title || row.title || '').trim() || null,
      associated_account_domain: (row.associated_account_domain || row.account_domain || '').trim().toLowerCase() || null,
      source,
      tier,
      one_line_context: (row.one_line_context || row.context || row.notes || '').trim() || null,
      last_touch_date: (row.last_touch_date || '').trim() || null,
      do_not_contact: /^(true|yes|y|1)$/i.test((row.do_not_contact || '').trim()),
      relationship_owner_email: (row.relationship_owner || row.owner || row.owner_email || '').trim().toLowerCase() || null,
    },
  };
}

// Upsert a single champion. Dedup key is linkedin_url first, then email.
// Returns { inserted: bool, champion }.
export async function upsertChampion(c) {
  // Resolve the owner email → user_id if provided.
  let owner_user_id = null;
  if (c.relationship_owner_email) {
    const { rows } = await query(
      `SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(name) = $1 LIMIT 1`,
      [c.relationship_owner_email]
    );
    owner_user_id = rows[0]?.id || null;
  }

  // Match by linkedin_url > email. A plain UPSERT won't work because we have
  // two candidate unique indexes and either can match.
  let existing = null;
  if (c.linkedin_url) {
    const { rows } = await query(
      `SELECT id FROM champions WHERE LOWER(linkedin_url) = LOWER($1) LIMIT 1`,
      [c.linkedin_url]
    );
    existing = rows[0] || null;
  }
  if (!existing && c.email) {
    const { rows } = await query(
      `SELECT id FROM champions WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [c.email]
    );
    existing = rows[0] || null;
  }

  if (existing) {
    const { rows } = await query(
      `UPDATE champions SET
         full_name = COALESCE(NULLIF($2, ''), full_name),
         email = COALESCE($3, email),
         linkedin_url = COALESCE($4, linkedin_url),
         current_company = COALESCE($5, current_company),
         current_title = COALESCE($6, current_title),
         associated_account_domain = COALESCE($7, associated_account_domain),
         source = COALESCE($8, source),
         tier = COALESCE($9, tier),
         one_line_context = COALESCE($10, one_line_context),
         last_touch_date = COALESCE(NULLIF($11, '')::date, last_touch_date),
         do_not_contact = $12,
         relationship_owner_user_id = COALESCE($13::uuid, relationship_owner_user_id),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        existing.id, c.full_name, c.email, c.linkedin_url,
        c.current_company, c.current_title, c.associated_account_domain,
        c.source, c.tier, c.one_line_context, c.last_touch_date,
        c.do_not_contact, owner_user_id,
      ]
    );
    return { inserted: false, champion: rows[0] };
  }

  const { rows } = await query(
    `INSERT INTO champions (
       full_name, email, linkedin_url, current_company, current_title,
       associated_account_domain, source, tier, one_line_context,
       last_touch_date, do_not_contact, relationship_owner_user_id
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       NULLIF($10, '')::date, $11, $12
     ) RETURNING *`,
    [
      c.full_name, c.email, c.linkedin_url, c.current_company, c.current_title,
      c.associated_account_domain, c.source, c.tier, c.one_line_context,
      c.last_touch_date, c.do_not_contact, owner_user_id,
    ]
  );
  return { inserted: true, champion: rows[0] };
}

// Paste-a-CSV ingest. Returns per-row results for the UI to render.
export async function ingestChampionCsv(rows) {
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { ok, champion, errors } = normalizeChampionRow(row);
    if (!ok) {
      results.push({ index: i, ok: false, errors, row });
      continue;
    }
    try {
      const { inserted } = await upsertChampion(champion);
      results.push({
        index: i,
        ok: true,
        inserted,
        name: champion.full_name,
        company: champion.current_company,
      });
    } catch (err) {
      results.push({
        index: i,
        ok: false,
        errors: [err.message || 'DB error'],
        row,
      });
    }
  }
  return results;
}

export async function listChampions({ ownerUserId = null } = {}) {
  const { rows } = await query(
    `SELECT c.*,
            u.email AS relationship_owner_email,
            u.name AS relationship_owner_name,
            (SELECT COUNT(*)::int FROM champion_moves m
              WHERE m.champion_id = c.id AND m.status = 'new') AS pending_moves
       FROM champions c
       LEFT JOIN users u ON u.id = c.relationship_owner_user_id
      WHERE ($1::uuid IS NULL OR c.relationship_owner_user_id = $1 OR c.relationship_owner_user_id IS NULL)
      ORDER BY c.status = 'moved' DESC,
               c.last_checked_at NULLS FIRST,
               c.created_at DESC
      LIMIT 500`,
    [ownerUserId]
  );
  return rows;
}

// Queue for the weekly checker: pull champions due for a check.
// "Due" = never checked, or last check > 6 days ago.
export async function getChampionsDueForCheck({ limit = 25 } = {}) {
  const { rows } = await query(
    `SELECT * FROM champions
      WHERE do_not_contact = FALSE
        AND status IN ('tracking', 'moved')
        AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '6 days')
      ORDER BY last_checked_at NULLS FIRST, created_at ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function markChampionChecked(id, fields = {}) {
  const extras = [];
  const values = [id];
  let p = 2;
  for (const key of ['status', 'current_company', 'current_title']) {
    if (fields[key] !== undefined) {
      extras.push(`${key} = $${p++}`);
      values.push(fields[key]);
    }
  }
  const setExtras = extras.length ? ', ' + extras.join(', ') : '';
  await query(
    `UPDATE champions SET last_checked_at = NOW(), updated_at = NOW() ${setExtras} WHERE id = $1`,
    values
  );
}

export async function recordMove({
  champion_id, from_company, to_company, to_title, to_domain,
  source_url, confidence, routing,
}) {
  const { rows } = await query(
    `INSERT INTO champion_moves
       (champion_id, from_company, to_company, to_title, to_domain,
        source_url, confidence, routing)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [champion_id, from_company, to_company, to_title, to_domain,
     source_url, confidence, routing]
  );
  return rows[0];
}

export async function listPendingMoves({ ownerUserId = null } = {}) {
  const { rows } = await query(
    `SELECT m.*, c.full_name, c.email, c.linkedin_url,
            c.source, c.tier, c.one_line_context,
            c.associated_account_domain
       FROM champion_moves m
       JOIN champions c ON c.id = m.champion_id
      WHERE m.status IN ('new', 'drafted')
        AND ($1::uuid IS NULL OR c.relationship_owner_user_id = $1 OR c.relationship_owner_user_id IS NULL)
      ORDER BY m.detected_at DESC
      LIMIT 200`,
    [ownerUserId]
  );
  return rows;
}

export async function countPendingMoves(ownerUserId = null) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM champion_moves m
       JOIN champions c ON c.id = m.champion_id
      WHERE m.status = 'new'
        AND ($1::uuid IS NULL OR c.relationship_owner_user_id = $1 OR c.relationship_owner_user_id IS NULL)`,
    [ownerUserId]
  );
  return rows[0].n;
}

export async function setMoveStatus(id, status, prospect_id = null) {
  await query(
    `UPDATE champion_moves SET status = $2, prospect_id = COALESCE($3::uuid, prospect_id) WHERE id = $1`,
    [id, status, prospect_id]
  );
}

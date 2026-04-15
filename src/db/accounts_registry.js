// Account registry: the Strategic-AE book of business. Separate from
// `prospects` because this table tracks current customers, churned accounts,
// disqualified accounts, and the AE/CSM relationship owner — data the outbound
// funnel doesn't care about, but the champion tracker and (eventually) the
// expansion-play generator do.

import { query } from './index.js';

const VALID_STATUS = new Set(['customer', 'prospect', 'churned', 'disqualified']);
const VALID_OWNER_ROLE = new Set(['ae', 'csm']);

function normalizeAccountRow(row) {
  const errors = [];
  const account_name = (row.account_name || row.name || row.company || '').trim();
  if (!account_name) errors.push('missing account_name');

  const status = (row.status || 'prospect').trim().toLowerCase();
  if (!VALID_STATUS.has(status)) errors.push(`bad status "${status}"`);

  const owner_role = (row.owner_role || '').trim().toLowerCase() || null;
  if (owner_role && !VALID_OWNER_ROLE.has(owner_role)) errors.push(`bad owner_role "${owner_role}"`);

  return {
    ok: errors.length === 0,
    errors,
    account: {
      account_name,
      domain: (row.domain || row.website || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null,
      status,
      owner_email: (row.owner || row.owner_email || '').trim().toLowerCase() || null,
      owner_role,
      industry: (row.industry || '').trim().toLowerCase() || null,
      notes: (row.notes || '').trim() || null,
    },
  };
}

export async function upsertAccount(a) {
  let owner_user_id = null;
  if (a.owner_email) {
    const { rows } = await query(
      `SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(name) = $1 LIMIT 1`,
      [a.owner_email]
    );
    owner_user_id = rows[0]?.id || null;
  }

  // Dedup by lowercased domain when present, otherwise by account_name.
  let existing = null;
  if (a.domain) {
    const { rows } = await query(
      `SELECT id FROM accounts_registry WHERE LOWER(domain) = $1 LIMIT 1`,
      [a.domain]
    );
    existing = rows[0] || null;
  }
  if (!existing) {
    const { rows } = await query(
      `SELECT id FROM accounts_registry WHERE LOWER(account_name) = LOWER($1) LIMIT 1`,
      [a.account_name]
    );
    existing = rows[0] || null;
  }

  if (existing) {
    const { rows } = await query(
      `UPDATE accounts_registry SET
         account_name = $2,
         domain = COALESCE($3, domain),
         status = $4,
         owner_user_id = COALESCE($5::uuid, owner_user_id),
         owner_role = COALESCE($6, owner_role),
         industry = COALESCE($7, industry),
         notes = COALESCE($8, notes),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [existing.id, a.account_name, a.domain, a.status, owner_user_id,
       a.owner_role, a.industry, a.notes]
    );
    return { inserted: false, account: rows[0] };
  }

  const { rows } = await query(
    `INSERT INTO accounts_registry
       (account_name, domain, status, owner_user_id, owner_role, industry, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [a.account_name, a.domain, a.status, owner_user_id,
     a.owner_role, a.industry, a.notes]
  );
  return { inserted: true, account: rows[0] };
}

export async function ingestAccountCsv(rows) {
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { ok, account, errors } = normalizeAccountRow(row);
    if (!ok) {
      results.push({ index: i, ok: false, errors, row });
      continue;
    }
    try {
      const { inserted } = await upsertAccount(account);
      results.push({
        index: i,
        ok: true,
        inserted,
        name: account.account_name,
        status: account.status,
      });
    } catch (err) {
      results.push({ index: i, ok: false, errors: [err.message || 'DB error'], row });
    }
  }
  return results;
}

export async function listAccounts({ status = null } = {}) {
  const { rows } = await query(
    `SELECT a.*, u.email AS owner_email, u.name AS owner_name
       FROM accounts_registry a
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE ($1::text IS NULL OR a.status = $1)
      ORDER BY
        CASE a.status
          WHEN 'customer' THEN 1
          WHEN 'churned' THEN 2
          WHEN 'prospect' THEN 3
          WHEN 'disqualified' THEN 4
          ELSE 5
        END,
        a.account_name ASC
      LIMIT 1000`,
    [status]
  );
  return rows;
}

export async function getAccountByDomain(domain) {
  if (!domain) return null;
  const { rows } = await query(
    `SELECT * FROM accounts_registry WHERE LOWER(domain) = LOWER($1) LIMIT 1`,
    [domain]
  );
  return rows[0] || null;
}

export async function getAccountStatusCounts() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS n FROM accounts_registry GROUP BY status`
  );
  const out = { customer: 0, prospect: 0, churned: 0, disqualified: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

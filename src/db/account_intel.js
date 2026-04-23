// account_intel — small key-value store backing the two Game Plan
// "intel" boxes: Use Case Identifier and Industry Insight. One row per
// (account_id, kind). Status drives the running/completed/failed UX
// (mirrors the dossier coach/plan pattern in src/db/expansion.js).

import { query } from './index.js';

export const INTEL_KINDS = ['use_case_fit', 'industry_insight', 'hypotheses_gen', 'prospect_scan', 'account_pov'];

export async function getAccountIntel(accountId) {
  const { rows } = await query(
    `SELECT kind, status, result, error, started_at, completed_at
       FROM account_intel
      WHERE account_id = $1`,
    [accountId]
  );
  const out = {};
  for (const k of INTEL_KINDS) out[k] = null;
  for (const r of rows) out[r.kind] = r;
  return out;
}

export async function setIntelRunning(accountId, kind) {
  await query(
    `INSERT INTO account_intel (account_id, kind, status, started_at, completed_at, result, error)
     VALUES ($1, $2, 'running', NOW(), NULL, NULL, NULL)
     ON CONFLICT (account_id, kind) DO UPDATE
       SET status = 'running',
           started_at = NOW(),
           completed_at = NULL,
           error = NULL`,
    [accountId, kind]
  );
}

export async function setIntelResult(accountId, kind, result) {
  await query(
    `UPDATE account_intel
        SET status = 'completed',
            result = $3::jsonb,
            completed_at = NOW(),
            error = NULL
      WHERE account_id = $1 AND kind = $2`,
    [accountId, kind, JSON.stringify(result)]
  );
}

export async function setIntelFailed(accountId, kind, errorMsg) {
  await query(
    `UPDATE account_intel
        SET status = 'failed',
            completed_at = NOW(),
            error = $3
      WHERE account_id = $1 AND kind = $2`,
    [accountId, kind, errorMsg]
  );
}

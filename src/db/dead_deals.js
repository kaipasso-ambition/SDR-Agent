// dead_deals: Closed Lost + Customer-Churned opportunity history imported
// from Salesforce. Keyed on opportunity_id so re-importing the same CSV is
// idempotent (update in place, never duplicate).

import { query } from './index.js';

/**
 * Insert or update one dead deal. Dedup on opportunity_id.
 * Returns { inserted: bool, deal: row }.
 */
export async function upsertDeadDeal(d) {
  if (!d.opportunity_id) {
    throw new Error('upsertDeadDeal: opportunity_id is required');
  }
  const { rows } = await query(
    `INSERT INTO dead_deals (
       account_id, opportunity_id, close_date, loss_reason,
       account_type_at_close, owner_name, next_step,
       current_state_pains, business_technical_pains, champion_raw,
       decision_criteria, decision_process, why_taking_call,
       why_now, why_ambition, foa_note
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     )
     ON CONFLICT (opportunity_id) DO UPDATE SET
       account_id               = EXCLUDED.account_id,
       close_date               = EXCLUDED.close_date,
       loss_reason              = EXCLUDED.loss_reason,
       account_type_at_close    = EXCLUDED.account_type_at_close,
       owner_name               = EXCLUDED.owner_name,
       next_step                = EXCLUDED.next_step,
       current_state_pains      = EXCLUDED.current_state_pains,
       business_technical_pains = EXCLUDED.business_technical_pains,
       champion_raw             = EXCLUDED.champion_raw,
       decision_criteria        = EXCLUDED.decision_criteria,
       decision_process         = EXCLUDED.decision_process,
       why_taking_call          = EXCLUDED.why_taking_call,
       why_now                  = EXCLUDED.why_now,
       why_ambition             = EXCLUDED.why_ambition,
       foa_note                 = EXCLUDED.foa_note,
       updated_at               = NOW()
     RETURNING *, (xmax = 0) AS inserted`,
    [
      d.account_id, d.opportunity_id, d.close_date || null, d.loss_reason || null,
      d.account_type_at_close || null, d.owner_name || null, d.next_step || null,
      d.current_state_pains || null, d.business_technical_pains || null, d.champion_raw || null,
      d.decision_criteria || null, d.decision_process || null, d.why_taking_call || null,
      d.why_now || null, d.why_ambition || null, d.foa_note || null,
    ]
  );
  const { inserted, ...deal } = rows[0];
  return { inserted, deal };
}

/**
 * Fetch all dead deals for a given account, newest first.
 */
export async function listDeadDealsForAccount(accountId) {
  const { rows } = await query(
    `SELECT * FROM dead_deals
      WHERE account_id = $1
      ORDER BY close_date DESC NULLS LAST, imported_at DESC`,
    [accountId]
  );
  return rows;
}

/**
 * Top N dead deals globally. Used by the /revisit queue. No signal join here —
 * the queue view does that at render time so this stays cheap.
 */
export async function listDeadDeals({ limit = 100, loss_reason = null } = {}) {
  const where = [];
  const args = [];
  if (loss_reason) {
    args.push(loss_reason);
    where.push(`loss_reason = $${args.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit);
  const { rows } = await query(
    `SELECT dd.*, a.account_name, a.domain, a.status AS account_status, a.industry
       FROM dead_deals dd
       JOIN accounts_registry a ON a.id = dd.account_id
       ${whereSql}
      ORDER BY dd.close_date DESC NULLS LAST
      LIMIT $${args.length}`,
    args
  );
  return rows;
}

export async function countDeadDeals() {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM dead_deals`);
  return rows[0]?.n || 0;
}

// ---------- Revisit scan state ----------
//
// One scan per deal at a time. last_scan_status drives the UI:
//   NULL       — never scanned
//   running    — kicked off, no result yet (banner spins)
//   completed  — last_scan_result holds the trigger array
//   failed     — last_scan_error holds the message
//
// We don't keep history yet. If/when we do, add a dead_deal_scans table; for
// now the inline columns let the list page render last-result counts cheaply.

/**
 * Fetch one dead deal joined with its account (everything the scanner needs
 * to build context). Lookup by opportunity_id, since that's what the URL
 * uses — UUID surrogate keys aren't useful in this section of the app.
 */
export async function getDeadDealByOpportunityId(opportunityId) {
  const { rows } = await query(
    `SELECT dd.*, a.account_name, a.domain, a.status AS account_status,
            a.industry, a.notes
       FROM dead_deals dd
       JOIN accounts_registry a ON a.id = dd.account_id
      WHERE dd.opportunity_id = $1
      LIMIT 1`,
    [opportunityId]
  );
  return rows[0] || null;
}

export async function setScanRunning(opportunityId) {
  await query(
    `UPDATE dead_deals
        SET last_scan_status     = 'running',
            last_scan_started_at = NOW(),
            last_scan_error      = NULL
      WHERE opportunity_id = $1`,
    [opportunityId]
  );
}

/**
 * Persist the final result of a scan. `result` is the object returned by
 * scanDeadDeal — we store the trigger array, the search count, and stamp
 * last_signal_scan_at so the list view can show "scanned X minutes ago".
 */
export async function setScanResult(opportunityId, result) {
  await query(
    `UPDATE dead_deals
        SET last_scan_status   = 'completed',
            last_scan_result   = $2::jsonb,
            last_scan_searches = $3,
            last_scan_error    = NULL,
            last_signal_scan_at = NOW()
      WHERE opportunity_id = $1`,
    [opportunityId, JSON.stringify(result.triggers || []), result.searches || 0]
  );
}

export async function setScanFailed(opportunityId, errorMessage) {
  await query(
    `UPDATE dead_deals
        SET last_scan_status = 'failed',
            last_scan_error  = $2
      WHERE opportunity_id = $1`,
    [opportunityId, (errorMessage || 'unknown').slice(0, 1000)]
  );
}

/**
 * List for the /revisit index — every dead deal + the headline scan state.
 * Cheap query; the trigger array is included so the list can show a count
 * pill without a second round-trip.
 */
export async function listDeadDealsWithScan({ limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT dd.opportunity_id, dd.close_date, dd.loss_reason,
            dd.account_type_at_close, dd.owner_name,
            dd.last_scan_status, dd.last_scan_started_at, dd.last_signal_scan_at,
            dd.last_scan_searches, dd.last_scan_error,
            COALESCE(jsonb_array_length(dd.last_scan_result), 0) AS trigger_count,
            a.account_name, a.domain, a.status AS account_status, a.industry
       FROM dead_deals dd
       JOIN accounts_registry a ON a.id = dd.account_id
      ORDER BY dd.close_date DESC NULLS LAST, dd.imported_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

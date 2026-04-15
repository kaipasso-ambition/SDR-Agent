// account_signals DB layer.
//
// Writes: insertSignals() upserts on (account_id, dedup_key). Reposts of
// the same exec-move / earnings callout next week don't create duplicate
// rows — they bump detected_at and refresh the interpretation fields.
//
// Reads: /brief uses getSignalsForBrief(userId) — top 5 unacked, scoped
// to signals owned by this user OR unowned, ranked by composite
// (risk_weight*10 + severity) then detected_at DESC. The per-account
// Pulse partial uses getSignalsForAccount(id).

import crypto from 'node:crypto';
import { query } from './index.js';

// Composite rank: defense_risk outranks offense_opportunity outranks
// neutral; severity breaks ties within a class; recency breaks severity
// ties. Inlined into SQL so the index (status, risk_class, severity DESC,
// detected_at DESC) can be used.
const RISK_WEIGHT_SQL = `
  (CASE risk_class
     WHEN 'defense_risk' THEN 3
     WHEN 'offense_opportunity' THEN 2
     ELSE 1
   END) * 10 + severity
`;

// Build a stable dedup key when the model didn't supply one. We hash the
// signal_type + a normalized version of the title so "Procore hires new
// CRO" and "procore hires new cro" collapse.
export function buildDedupKey({ signal_type, title, source_url }) {
  const basis = [
    (signal_type || 'unknown').toLowerCase().trim(),
    (title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    (source_url || '').toLowerCase().trim(),
  ].join('|');
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 24);
}

// Insert a batch of signals detected in one scan. Per-row UPSERT keyed on
// (account_id, dedup_key). Returns {inserted, updated, total}. Also bumps
// accounts_registry.last_signal_at so the account list can surface "N
// new this week" later without a join.
export async function insertSignals(signals, jobId = null) {
  let inserted = 0;
  let updated = 0;
  const touchedAccounts = new Set();

  for (const s of signals) {
    if (!s.account_id || !s.risk_class || !s.severity || !s.title) continue;
    const dedupKey = s.dedup_key || buildDedupKey(s);
    const { rows } = await query(
      `INSERT INTO account_signals (
         account_id, job_id, detected_at, source, signal_type, risk_class,
         severity, title, summary, so_what, recommended_move,
         source_url, source_excerpt, dedup_key, raw_model_output
       ) VALUES (
         $1, $2, NOW(), $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13, $14
       )
       ON CONFLICT (account_id, dedup_key) DO UPDATE SET
         detected_at       = NOW(),
         job_id            = EXCLUDED.job_id,
         signal_type       = EXCLUDED.signal_type,
         severity          = GREATEST(account_signals.severity, EXCLUDED.severity),
         summary           = EXCLUDED.summary,
         so_what           = EXCLUDED.so_what,
         recommended_move  = EXCLUDED.recommended_move,
         source_url        = COALESCE(EXCLUDED.source_url, account_signals.source_url),
         source_excerpt    = COALESCE(EXCLUDED.source_excerpt, account_signals.source_excerpt),
         raw_model_output  = EXCLUDED.raw_model_output
       RETURNING (xmax = 0) AS was_inserted, id`,
      [
        s.account_id,
        jobId,
        s.source || 'web_search',
        s.signal_type || null,
        s.risk_class,
        s.severity,
        s.title,
        s.summary || null,
        s.so_what || null,
        s.recommended_move || null,
        s.source_url || null,
        s.source_excerpt || null,
        dedupKey,
        s.raw_model_output ? JSON.stringify(s.raw_model_output) : null,
      ]
    );
    if (rows[0].was_inserted) inserted++;
    else updated++;
    touchedAccounts.add(s.account_id);
  }

  if (touchedAccounts.size > 0) {
    await query(
      `UPDATE accounts_registry SET last_signal_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [[...touchedAccounts]]
    );
  }

  return { inserted, updated, total: inserted + updated };
}

// Top unacked signals for the /brief view, owner-scoped, ONE PER ACCOUNT.
// Diversification rule: the Brief is "what moved across my book" — if
// Boomi has five severity-5 defense-risk signals it shouldn't eat every
// slot. We pick the highest-ranked signal per account via DISTINCT ON,
// then re-sort those picks by rank so the most urgent accounts surface
// first. account_signal_count lets the view render a "+N more on this
// account" link to the Pulse page.
//
// Default limit bumped to 20: if 15 accounts have flags we want to see
// all 15, not truncate to a hard-coded 5.
export async function getSignalsForBrief(userId, { limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT picks.*
       FROM (
         SELECT DISTINCT ON (s.account_id)
                s.*,
                a.account_name, a.domain, a.status AS account_status,
                a.owner_user_id,
                (${RISK_WEIGHT_SQL}) AS rank_score,
                (SELECT COUNT(*)::int FROM account_signals s2
                  WHERE s2.account_id = s.account_id
                    AND s2.status IN ('new', 'acknowledged')) AS account_signal_count
           FROM account_signals s
           JOIN accounts_registry a ON a.id = s.account_id
          WHERE s.status IN ('new', 'acknowledged')
            AND (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
          ORDER BY s.account_id, ${RISK_WEIGHT_SQL} DESC, s.detected_at DESC
       ) picks
      ORDER BY picks.rank_score DESC, picks.detected_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function getSignalsForAccount(
  accountId,
  { limit = 5, includeArchive = false } = {}
) {
  const statusClause = includeArchive
    ? ''
    : `AND status IN ('new', 'acknowledged', 'playing')`;
  const { rows } = await query(
    `SELECT * FROM account_signals
      WHERE account_id = $1 ${statusClause}
      ORDER BY ${RISK_WEIGHT_SQL} DESC, detected_at DESC
      LIMIT $2`,
    [accountId, limit]
  );
  return rows;
}

export async function getSignalArchiveCount(accountId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM account_signals
      WHERE account_id = $1 AND status = 'dismissed'`,
    [accountId]
  );
  return rows[0].n;
}

export async function getSignalById(id) {
  const { rows } = await query(
    `SELECT s.*, a.account_name, a.domain, a.status AS account_status,
            a.owner_user_id, a.industry
       FROM account_signals s
       JOIN accounts_registry a ON a.id = s.account_id
      WHERE s.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function acknowledgeSignal(id) {
  await query(
    `UPDATE account_signals
        SET status = 'acknowledged', acknowledged_at = NOW()
      WHERE id = $1`,
    [id]
  );
}

export async function dismissSignal(id) {
  await query(
    `UPDATE account_signals SET status = 'dismissed' WHERE id = $1`,
    [id]
  );
}

export async function setSignalPlaying(id) {
  await query(
    `UPDATE account_signals SET status = 'playing' WHERE id = $1`,
    [id]
  );
}

// Counts feeding the dashboard card + nav badge. "this_week" is the
// count of unacked signals detected in the last 7 days; defense/offense
// break that by risk class.
export async function getSignalCounts(userId) {
  const { rows } = await query(
    `SELECT
        COUNT(*) FILTER (
          WHERE s.status = 'new'
            AND s.detected_at >= NOW() - INTERVAL '7 days'
        )::int AS this_week,
        COUNT(*) FILTER (
          WHERE s.status = 'new'
            AND s.risk_class = 'defense_risk'
            AND s.detected_at >= NOW() - INTERVAL '7 days'
        )::int AS defense,
        COUNT(*) FILTER (
          WHERE s.status = 'new'
            AND s.risk_class = 'offense_opportunity'
            AND s.detected_at >= NOW() - INTERVAL '7 days'
        )::int AS offense,
        COUNT(*) FILTER (WHERE s.status = 'new')::int AS unacked_total
       FROM account_signals s
       JOIN accounts_registry a ON a.id = s.account_id
      WHERE (a.owner_user_id = $1 OR a.owner_user_id IS NULL)`,
    [userId]
  );
  return rows[0] || { this_week: 0, defense: 0, offense: 0, unacked_total: 0 };
}

// When the Pulse "Rescan" button fires we only want to allow it once per
// 24h per account to keep the web_search cost bounded. Returns the
// timestamp of the most recent job that touched this account, or null.
export async function getLastScanForAccount(accountId) {
  const { rows } = await query(
    `SELECT MAX(detected_at) AS last_at
       FROM account_signals
      WHERE account_id = $1`,
    [accountId]
  );
  return rows[0]?.last_at || null;
}

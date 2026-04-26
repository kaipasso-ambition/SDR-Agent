// Unified `/today` inbox: mixes all three scanner outputs into one ranked feed.
//
// Source 1 — account_signals          (customer_signal scanner, one row per signal)
// Source 2 — account_expansion_dossier.last_scan_result  (expansion scanner, JSONB array)
// Source 3 — dead_deals.last_scan_result                 (revisit scanner, JSONB array)
//
// All three are normalized into one row shape at query time so the view is a
// single map() over a homogeneous list:
//
//   {
//     id,                 // signal UUID, or 'exp:<aid>:<idx>', or 'rev:<opp>:<idx>'
//     kind,               // 'customer_signal' | 'expansion' | 'revisit'
//     account_id, account_name, account_status, account_industry, domain,
//     title, summary, so_what, recommended_move, source_url,
//     severity, risk_class,
//     detected_at,
//     play_action,        // POST target for "Build a play"
//     signal_status,      // status column for customer signals; null for others
//   }
//
// Ranking: composite score so defense outranks offense outranks neutral and
// expansion/revisit slot in between by intent. Ties broken by recency.
//   defense_risk         → 30 + severity
//   offense_opportunity  → 20 + severity
//   expansion trigger    → 20 + severity  (same lane as offense — both growth)
//   revisit trigger      → 15 + severity  (secondary to the current book)
//   neutral              → 10 + severity

import { query } from './index.js';

// Only surface customer signals that are still in the workflow. Dismissed ones
// stay off the unified feed (they're visible on the account's archive tab).
const CUSTOMER_SIGNAL_STATUSES = `('new', 'acknowledged', 'playing')`;

export async function listUnifiedBrief(userId, { limit = 50 } = {}) {
  const { rows } = await query(
    `
    WITH customer_signals AS (
      SELECT
        s.id::text                                     AS id,
        'customer_signal'::text                        AS kind,
        a.id                                           AS account_id,
        a.account_name,
        a.status                                       AS account_status,
        a.industry                                     AS account_industry,
        a.domain                                       AS domain,
        s.title                                        AS title,
        s.summary                                      AS summary,
        s.so_what                                      AS so_what,
        s.recommended_move                             AS recommended_move,
        s.source_url                                   AS source_url,
        s.severity                                     AS severity,
        s.risk_class                                   AS risk_class,
        s.detected_at                                  AS detected_at,
        ('/signals/' || s.id::text || '/play')         AS play_action,
        s.status                                       AS signal_status,
        (CASE s.risk_class
           WHEN 'defense_risk'        THEN 30
           WHEN 'offense_opportunity' THEN 20
           ELSE 10
         END) + s.severity                             AS score
      FROM account_signals s
      JOIN accounts_registry a ON a.id = s.account_id
      WHERE s.status IN ${CUSTOMER_SIGNAL_STATUSES}
        AND (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
    ),
    expansion_trigs AS (
      SELECT
        ('exp:' || d.account_id::text || ':' || (ord.idx - 1)::text) AS id,
        'expansion'::text                                            AS kind,
        a.id                                                         AS account_id,
        a.account_name,
        a.status                                                     AS account_status,
        a.industry                                                   AS account_industry,
        a.domain                                                     AS domain,
        COALESCE(ord.t->>'trigger_title', 'Expansion trigger')       AS title,
        ord.t->>'trigger_summary'                                    AS summary,
        ord.t->>'why_this_unlocks'                                   AS so_what,
        COALESCE(
          NULLIF(ord.t->>'champion_talking_point', ''),
          NULLIF(ord.t->'carry_internally'->>'who', ''),
          NULLIF(ord.t->>'destination_link', '')
        )                                                            AS recommended_move,
        ord.t->>'source_url'                                         AS source_url,
        COALESCE((ord.t->>'severity')::int, 2)                       AS severity,
        NULL::text                                                   AS risk_class,
        COALESCE(d.last_scan_started_at, d.updated_at, NOW())        AS detected_at,
        ('/expand/' || d.account_id::text || '/triggers/' || (ord.idx - 1)::text || '/play') AS play_action,
        NULL::text                                                   AS signal_status,
        20 + COALESCE((ord.t->>'severity')::int, 2)                  AS score
      FROM account_expansion_dossier d
      JOIN accounts_registry a ON a.id = d.account_id
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(d.last_scan_result, '[]'::jsonb)
      ) WITH ORDINALITY AS ord(t, idx)
      WHERE (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
        AND a.status = 'customer'
    ),
    revisit_trigs AS (
      SELECT
        ('rev:' || dd.opportunity_id || ':' || (ord.idx - 1)::text) AS id,
        'revisit'::text                                             AS kind,
        a.id                                                        AS account_id,
        a.account_name,
        a.status                                                    AS account_status,
        a.industry                                                  AS account_industry,
        a.domain                                                    AS domain,
        COALESCE(ord.t->>'trigger_title', 'Revisit trigger')        AS title,
        ord.t->>'trigger_summary'                                   AS summary,
        ord.t->>'why_this_unlocks'                                  AS so_what,
        COALESCE(
          NULLIF(ord.t->>'re_entry_angle', ''),
          NULLIF(ord.t->>'loss_reason_link', '')
        )                                                           AS recommended_move,
        ord.t->>'source_url'                                        AS source_url,
        COALESCE((ord.t->>'severity')::int, 2)                      AS severity,
        NULL::text                                                  AS risk_class,
        COALESCE(dd.last_scan_started_at, dd.imported_at, NOW())    AS detected_at,
        ('/revisit/' || dd.opportunity_id || '/triggers/' || (ord.idx - 1)::text || '/play') AS play_action,
        NULL::text                                                  AS signal_status,
        15 + COALESCE((ord.t->>'severity')::int, 2)                 AS score
      FROM dead_deals dd
      JOIN accounts_registry a ON a.id = dd.account_id
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(dd.last_scan_result, '[]'::jsonb)
      ) WITH ORDINALITY AS ord(t, idx)
      WHERE (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
    )
    SELECT * FROM customer_signals
    UNION ALL
    SELECT * FROM expansion_trigs
    UNION ALL
    SELECT * FROM revisit_trigs
    ORDER BY score DESC, detected_at DESC
    LIMIT $2
    `,
    [userId, limit]
  );
  return rows;
}

// Counts feeding the dashboard card + nav badge. Unified across the three
// sources so the "unread" number on the header reflects total work waiting,
// not just customer signals. `this_week` is rows detected in the last 7 days;
// breakdowns let the UI render "X defense · Y offense · Z growth · W revisit".
// Account-grouped view for the unified /today page: one row per account
// with signal count + latest activity + POV + prospect scan, filtered to
// the last 60 days. Accounts with zero activity and no prospect scan
// drop off unless includeQuiet is set (so the page isn't cluttered with
// 150 empty cards, but the AE can still reveal them on demand).
export async function listAccountTimeline(userId, { includeQuiet = false, statuses = null } = {}) {
  const statusList = Array.isArray(statuses) && statuses.length > 0
    ? statuses
    : ['prospect', 'customer', 'churned'];

  const { rows } = await query(
    `
    WITH recent_signals AS (
      SELECT
        s.account_id,
        COUNT(*)::int                                    AS signal_count,
        COUNT(*) FILTER (WHERE s.risk_class = 'defense_risk')::int        AS defense_count,
        COUNT(*) FILTER (WHERE s.risk_class = 'offense_opportunity')::int AS offense_count,
        MAX(s.event_date::timestamptz)                   AS last_signal_at,
        jsonb_agg(
          jsonb_build_object(
            'id',               s.id,
            'title',            s.title,
            'summary',          s.summary,
            'so_what',          s.so_what,
            'recommended_move', s.recommended_move,
            'source_url',       s.source_url,
            'signal_type',      s.signal_type,
            'risk_class',       s.risk_class,
            'severity',         s.severity,
            'event_date',       s.event_date,
            'detected_at',      s.detected_at,
            'status',           s.status
          )
          ORDER BY s.event_date DESC
        )                                                AS signals
      FROM account_signals s
      WHERE s.status IN ('new', 'acknowledged', 'playing')
        AND s.event_date IS NOT NULL
        AND s.event_date >= (CURRENT_DATE - INTERVAL '60 days')::date
      GROUP BY s.account_id
    )
    SELECT
      a.id                              AS account_id,
      a.account_name,
      a.status                          AS account_status,
      a.industry,
      a.domain,
      a.fiscal_year_end,
      a.budget_start_month,
      a.buyer_timing,
      a.sales_perf_topics,
      a.watched,
      a.notes,
      a.owner_user_id,
      u.name                            AS owner_name,
      COALESCE(rs.signal_count, 0)      AS signal_count,
      COALESCE(rs.defense_count, 0)     AS defense_count,
      COALESCE(rs.offense_count, 0)     AS offense_count,
      rs.last_signal_at,
      COALESCE(rs.signals, '[]'::jsonb) AS signals,
      ps.status                         AS prospect_scan_status,
      ps.result                         AS prospect_scan_result,
      ps.completed_at                   AS prospect_scan_at,
      pov.status                        AS pov_status,
      pov.result                        AS pov_result,
      pov.completed_at                  AS pov_at,
      ucf.status                        AS ucf_status,
      ucf.result                        AS ucf_result,
      ii.status                         AS ii_status,
      ii.result                         AS ii_result,
      GREATEST(
        COALESCE(rs.last_signal_at,    'epoch'::timestamptz),
        COALESCE(ps.completed_at,       'epoch'::timestamptz),
        COALESCE(pov.completed_at,      'epoch'::timestamptz)
      )                                  AS last_activity_at
    FROM accounts_registry a
    LEFT JOIN users u                ON u.id = a.owner_user_id
    LEFT JOIN recent_signals rs      ON rs.account_id = a.id
    LEFT JOIN account_intel ps       ON ps.account_id = a.id AND ps.kind = 'prospect_scan'
    LEFT JOIN account_intel pov      ON pov.account_id = a.id AND pov.kind = 'account_pov'
    LEFT JOIN account_intel ucf      ON ucf.account_id = a.id AND ucf.kind = 'use_case_fit'
    LEFT JOIN account_intel ii       ON ii.account_id  = a.id AND ii.kind  = 'industry_insight'
    WHERE (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
      AND a.status = ANY($2::text[])
      AND ($3::boolean
           OR rs.signal_count > 0
           OR ps.status IS NOT NULL
           OR pov.status IS NOT NULL)
    ORDER BY
      last_activity_at DESC NULLS LAST,
      a.account_name ASC
    `,
    [userId, statusList, includeQuiet]
  );
  return rows;
}

export async function getUnifiedCounts(userId) {
  const { rows } = await query(
    `
    WITH customer_signals AS (
      SELECT
        s.risk_class        AS risk_class,
        s.status            AS status,
        s.detected_at       AS detected_at,
        'customer_signal'   AS kind
      FROM account_signals s
      JOIN accounts_registry a ON a.id = s.account_id
      WHERE (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
        AND s.status IN ${CUSTOMER_SIGNAL_STATUSES}
    ),
    expansion_trigs AS (
      SELECT
        NULL::text          AS risk_class,
        'new'::text         AS status,
        COALESCE(d.last_scan_started_at, d.updated_at, NOW()) AS detected_at,
        'expansion'         AS kind
      FROM account_expansion_dossier d
      JOIN accounts_registry a ON a.id = d.account_id
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(d.last_scan_result, '[]'::jsonb)
      ) AS t
      WHERE (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
        AND a.status = 'customer'
    ),
    revisit_trigs AS (
      SELECT
        NULL::text          AS risk_class,
        'new'::text         AS status,
        COALESCE(dd.last_scan_started_at, dd.imported_at, NOW()) AS detected_at,
        'revisit'           AS kind
      FROM dead_deals dd
      JOIN accounts_registry a ON a.id = dd.account_id
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(dd.last_scan_result, '[]'::jsonb)
      ) AS t
      WHERE (a.owner_user_id = $1 OR a.owner_user_id IS NULL)
    ),
    unified AS (
      SELECT * FROM customer_signals
      UNION ALL
      SELECT * FROM expansion_trigs
      UNION ALL
      SELECT * FROM revisit_trigs
    )
    SELECT
      COUNT(*) FILTER (WHERE detected_at >= NOW() - INTERVAL '7 days')::int AS this_week,
      COUNT(*) FILTER (WHERE kind = 'customer_signal' AND risk_class = 'defense_risk'        AND detected_at >= NOW() - INTERVAL '7 days')::int AS defense,
      COUNT(*) FILTER (WHERE kind = 'customer_signal' AND risk_class = 'offense_opportunity' AND detected_at >= NOW() - INTERVAL '7 days')::int AS offense,
      COUNT(*) FILTER (WHERE kind = 'expansion' AND detected_at >= NOW() - INTERVAL '7 days')::int AS growth,
      COUNT(*) FILTER (WHERE kind = 'revisit'   AND detected_at >= NOW() - INTERVAL '7 days')::int AS revisit,
      COUNT(*) FILTER (WHERE status = 'new')::int AS unacked_total
    FROM unified
    `,
    [userId]
  );
  return rows[0] || { this_week: 0, defense: 0, offense: 0, growth: 0, revisit: 0, unacked_total: 0 };
}

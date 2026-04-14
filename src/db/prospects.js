import { query } from './index.js';

export async function upsertProspect(prospect) {
  const {
    prospect_id,
    company,
    domain = null,
    contact_name = null,
    contact_title = null,
    contact_email = null,
    industry = null,
    persona = null,
    seniority = null,
    fit_score = null,
    timing_signal = null,
    timing_signal_source = null,
    customer_status = 'prospect',
    sales_headcount_estimate = null,
    headcount_confidence = null,
    additional_context = null,
    disqualified = false,
    disqualify_reason = null,
    owner_user_id = null,
  } = prospect;

  const sql = `
    INSERT INTO prospects (
      id, company, domain, contact_name, contact_title, contact_email,
      industry, persona, seniority, fit_score, timing_signal, timing_signal_source,
      customer_status, sales_headcount_estimate, headcount_confidence,
      additional_context, disqualified, disqualify_reason, owner_user_id, researched_at
    )
    VALUES (
      COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12,
      $13, $14, $15,
      $16, $17, $18, $19, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      company = EXCLUDED.company,
      domain = EXCLUDED.domain,
      contact_name = EXCLUDED.contact_name,
      contact_title = EXCLUDED.contact_title,
      contact_email = EXCLUDED.contact_email,
      industry = EXCLUDED.industry,
      persona = EXCLUDED.persona,
      seniority = EXCLUDED.seniority,
      fit_score = EXCLUDED.fit_score,
      timing_signal = EXCLUDED.timing_signal,
      timing_signal_source = EXCLUDED.timing_signal_source,
      customer_status = EXCLUDED.customer_status,
      sales_headcount_estimate = EXCLUDED.sales_headcount_estimate,
      headcount_confidence = EXCLUDED.headcount_confidence,
      additional_context = EXCLUDED.additional_context,
      disqualified = EXCLUDED.disqualified,
      disqualify_reason = EXCLUDED.disqualify_reason,
      owner_user_id = COALESCE(EXCLUDED.owner_user_id, prospects.owner_user_id),
      researched_at = NOW()
    RETURNING *;
  `;

  const values = [
    prospect_id, company, domain, contact_name, contact_title, contact_email,
    industry, persona, seniority, fit_score, timing_signal, timing_signal_source,
    customer_status, sales_headcount_estimate, headcount_confidence,
    additional_context, disqualified, disqualify_reason, owner_user_id,
  ];

  const { rows } = await query(sql, values);
  return rows[0];
}

export async function getScoredProspects({ minScore = 50, notQueued = true } = {}) {
  const sql = notQueued
    ? `
      SELECT p.* FROM prospects p
      LEFT JOIN approval_queue aq ON aq.prospect_id = p.id
      WHERE p.disqualified = FALSE
        AND p.fit_score >= $1
        AND aq.id IS NULL
      ORDER BY p.fit_score DESC
      LIMIT 100;
    `
    : `
      SELECT * FROM prospects
      WHERE disqualified = FALSE AND fit_score >= $1
      ORDER BY fit_score DESC
      LIMIT 100;
    `;
  const { rows } = await query(sql, [minScore]);
  return rows;
}

export async function getProspectById(id) {
  const { rows } = await query('SELECT * FROM prospects WHERE id = $1', [id]);
  return rows[0] || null;
}

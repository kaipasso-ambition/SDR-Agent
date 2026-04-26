// Account registry: the Strategic-AE book of business. Separate from
// `prospects` because this table tracks current customers, churned accounts,
// disqualified accounts, and the AE/CSM relationship owner — data the outbound
// funnel doesn't care about, but the champion tracker and (eventually) the
// expansion-play generator do.

import { query } from './index.js';
import { PERSONAS, matchPersona, coverageState } from '../lib/personas.js';

const VALID_STATUS = new Set(['customer', 'prospect', 'churned', 'disqualified']);
const VALID_OWNER_ROLE = new Set(['ae', 'csm']);

// Canonicalize an incoming domain / website string. Handles every shape a
// HubSpot or Salesforce export tends to produce:
//   "https://www.Acme.com/about" → "acme.com"
//   "ACME.COM/"                 → "acme.com"
//   "http://acme.com"           → "acme.com"
//   "acme"                      → null (not a domain)
// Empty / junk inputs return null so the DB stores NULL, not ''.
export function normalizeDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '');     // strip protocol
  s = s.replace(/^www\./, '');           // strip leading www
  s = s.split('/')[0];                   // drop any path
  s = s.split('?')[0];                   // drop query
  s = s.split(':')[0];                   // drop port
  // Must have a dot to count as a domain — bare "acme" is not.
  if (!/\./.test(s)) return null;
  // Strip obvious junk chars.
  s = s.replace(/[\s,;]+/g, '');
  return s || null;
}

// Map common CRM export statuses ("Customer", "Customer - Won", "Churned -
// Non-Renewal", "Open Opportunity", "Unqualified") onto our four enum values.
// Case-insensitive substring match; first hit wins. Unknown → 'prospect'.
function mapStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'prospect';
  if (/disqualif|unqualif|bad\s*fit|do\s*not\s*contact|dnc/.test(s)) return 'disqualified';
  if (/churn|lost|cancelled|canceled|non[-\s]*renew|closed\s*lost/.test(s)) return 'churned';
  if (/customer|won|closed\s*won|active|live|subscriber|paying/.test(s)) return 'customer';
  if (/prospect|opportunity|open|lead|qualified|pipeline/.test(s)) return 'prospect';
  return 'prospect'; // safest default — a mis-tagged customer is worse than a mis-tagged prospect
}

// Map a CRM owner-role string onto our ae|csm enum. "Account Executive",
// "Senior AE", "Enterprise AE" → ae. "Customer Success Manager", "CSM" → csm.
function mapOwnerRole(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (/csm|customer\s*success|cs\s*manager|success\s*manager/.test(s)) return 'csm';
  if (/\bae\b|account\s*executive|sales\s*rep|ar\b/.test(s)) return 'ae';
  return null;
}

// Smart header mapping. CRM exports use different column names for the same
// thing (HubSpot "Company name" vs SFDC "Account Name" vs our "account_name").
// The CSV parser normalizes headers to snake_case, so we just need to look
// under every known alias for each target field. First non-empty wins.
function pickField(row, aliases) {
  for (const alias of aliases) {
    const v = row[alias];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

const HEADER_ALIASES = {
  account_name: ['account_name', 'name', 'company', 'company_name', 'account'],
  domain:       ['domain', 'website', 'website_url', 'company_domain', 'web_site', 'url', 'site'],
  status:       ['status', 'type', 'account_type', 'lifecycle_stage', 'stage', 'customer_status', 'account_stage'],
  owner:        ['owner', 'owner_email', 'account_owner', 'relationship_owner', 'assigned_to', 'ae', 'csm', 'owner_name'],
  owner_role:   ['owner_role', 'owner_type', 'role', 'team'],
  industry:     ['industry', 'vertical', 'segment'],
  notes:        ['notes', 'note', 'description', 'summary', 'comments'],
};

function normalizeAccountRow(row) {
  const errors = [];
  const account_name = pickField(row, HEADER_ALIASES.account_name);
  if (!account_name) errors.push('missing account_name');

  const rawStatus = pickField(row, HEADER_ALIASES.status);
  const status = mapStatus(rawStatus);
  // If they supplied a status string that didn't map to anything recognizable,
  // warn — but don't block the import (we fell back to 'prospect').
  if (rawStatus && !/customer|churn|prospect|disqual/i.test(rawStatus) &&
      !['customer', 'churned', 'prospect', 'disqualified'].includes(rawStatus.toLowerCase())) {
    errors.push(`status "${rawStatus}" mapped to "${status}" — confirm`);
  }

  const rawOwnerRole = pickField(row, HEADER_ALIASES.owner_role);
  const owner_role = mapOwnerRole(rawOwnerRole);

  return {
    // "ok" means importable; warnings (mapped status) show up too but don't block.
    ok: !account_name ? false : true,
    errors,
    account: {
      account_name,
      domain: normalizeDomain(pickField(row, HEADER_ALIASES.domain)),
      status,
      owner_email: pickField(row, HEADER_ALIASES.owner).toLowerCase() || null,
      owner_role,
      industry: pickField(row, HEADER_ALIASES.industry).toLowerCase() || null,
      notes: pickField(row, HEADER_ALIASES.notes) || null,
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
        // Surface non-blocking warnings (e.g. status "Customer - Renewal Risk"
        // mapped to "customer") so the operator can confirm we got it right.
        warnings: errors.length > 0 ? errors : null,
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

// Win-back view. Churned accounts with the context the AE actually
// uses to decide "is there a play here and who carries it?" — active
// play count, champion-role contacts, prospect coverage at the domain,
// and a ticker for recent offense-opportunity signals (funding, new
// CRO, product launch — the stuff that reopens a churned door).
//
// Correlated subqueries rather than JOIN-then-GROUP-BY because each
// metric comes from a different table and we want counts per account,
// not fan-out. Churned lists are typically <50 accounts, so the cost
// is fine; if the list ever grows past a few hundred we can swap to
// CTEs.
export async function listChurnedWithWinbackContext() {
  const { rows } = await query(
    `SELECT a.*,
            u.name  AS owner_name,
            u.email AS owner_email,
            -- any play still on the board (drafting/active/paused)
            (SELECT COUNT(*)::int FROM account_plays p
              WHERE p.account_id = a.id
                AND p.status IN ('drafting','active','paused')) AS active_play_count,
            (SELECT p.id FROM account_plays p
              WHERE p.account_id = a.id
                AND p.status IN ('drafting','active','paused')
              ORDER BY p.updated_at DESC LIMIT 1) AS latest_play_id,
            (SELECT p.ai_expansion->>'named_play' FROM account_plays p
              WHERE p.account_id = a.id
                AND p.status IN ('drafting','active','paused')
              ORDER BY p.updated_at DESC LIMIT 1) AS latest_play_name,
            (SELECT p.status FROM account_plays p
              WHERE p.account_id = a.id
                AND p.status IN ('drafting','active','paused')
              ORDER BY p.updated_at DESC LIMIT 1) AS latest_play_status,
            -- contacts on the chess board already
            (SELECT COUNT(*)::int FROM account_contacts c
              WHERE c.account_id = a.id
                AND c.deal_role = 'champion') AS champion_count,
            (SELECT COUNT(*)::int FROM account_contacts c
              WHERE c.account_id = a.id) AS contact_count,
            -- prospects researched against this domain (potential new champions)
            (SELECT COUNT(*)::int FROM prospects pr
              WHERE a.domain IS NOT NULL
                AND LOWER(pr.domain) = LOWER(a.domain)) AS prospect_count,
            -- recent offense-opportunity signals are the reason to re-open
            (SELECT COUNT(*)::int FROM account_signals s
              WHERE s.account_id = a.id
                AND s.status IN ('new','acknowledged')) AS open_signal_count,
            (SELECT COUNT(*)::int FROM account_signals s
              WHERE s.account_id = a.id
                AND s.risk_class = 'offense_opportunity'
                AND s.status IN ('new','acknowledged')) AS offense_signal_count,
            (SELECT MAX(s.detected_at) FROM account_signals s
              WHERE s.account_id = a.id) AS last_signal_at
       FROM accounts_registry a
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.status = 'churned'
      ORDER BY
        -- surface accounts with fresh offense signals and no play yet first
        (CASE WHEN (SELECT COUNT(*) FROM account_plays p
                     WHERE p.account_id = a.id
                       AND p.status IN ('drafting','active','paused')) = 0
              THEN 0 ELSE 1 END),
        (SELECT MAX(s.detected_at) FROM account_signals s WHERE s.account_id = a.id) DESC NULLS LAST,
        a.account_name ASC
      LIMIT 500`
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

export async function getAccountById(id) {
  const { rows } = await query(
    `SELECT a.*, u.email AS owner_email_resolved, u.name AS owner_name_resolved
       FROM accounts_registry a
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

// Pull everything an AE would want on the account home page: the registry
// row + related prospects (matched by domain) + recent drafts/sent messages
// for any of those prospects + any champions associated with this account.
export async function getAccountBundle(id, { includeArchive = false } = {}) {
  const account = await getAccountById(id);
  if (!account) return null;

  const domain = account.domain;

  // Prospects matched to this account by domain. Prospects don't FK to the
  // registry — we match on the normalized domain, which is the same key the
  // CSV importer stores.
  const prospects = domain ? (await query(
    `SELECT id, company, domain, contact_name, contact_title, contact_email,
            persona, seniority, fit_score, customer_status,
            timing_signal, disqualified, disqualify_reason, researched_at
       FROM prospects
      WHERE LOWER(domain) = LOWER($1)
      ORDER BY researched_at DESC NULLS LAST
      LIMIT 50`,
    [domain]
  )).rows : [];

  const prospectIds = prospects.map((p) => p.id);

  // Pending + recent drafts for those prospects. Left-join campaign name for
  // display. Keep it short — we just need the ticker.
  const drafts = prospectIds.length > 0 ? (await query(
    `SELECT aq.id, aq.status, aq.queued_at, aq.reviewed_at,
            aq.draft->>'persona' AS persona_from_draft,
            p.company, p.contact_name, c.name AS campaign_name
       FROM approval_queue aq
       JOIN prospects p ON p.id = aq.prospect_id
       LEFT JOIN campaigns c ON c.id = aq.campaign_id
      WHERE aq.prospect_id = ANY($1::uuid[])
      ORDER BY aq.queued_at DESC
      LIMIT 20`,
    [prospectIds]
  )).rows : [];

  const sent = prospectIds.length > 0 ? (await query(
    `SELECT sm.id, sm.touch, sm.channel, sm.subject, sm.sent_at, sm.reply_received,
            p.company, p.contact_name
       FROM sent_messages sm
       JOIN prospects p ON p.id = sm.prospect_id
      WHERE sm.prospect_id = ANY($1::uuid[])
      ORDER BY sm.sent_at DESC
      LIMIT 20`,
    [prospectIds]
  )).rows : [];

  // Champions associated with this account by domain. Kept visible on the
  // detail page because account-level info isn't sensitive — the champion
  // PII concerns are on the /champions list page itself, which is behind a
  // placeholder. On the account page we only show a count by source for now.
  const championCountsRow = domain ? (await query(
    `SELECT source, COUNT(*)::int AS n
       FROM champions
      WHERE LOWER(associated_account_domain) = LOWER($1)
      GROUP BY source`,
    [domain]
  )).rows : [];
  const championCounts = Object.fromEntries(championCountsRow.map((r) => [r.source, r.n]));

  // Stakeholder whitespace map — only rendered for customer accounts, but
  // we compute it for any account that has a domain so the detail-page
  // route can decide without a second round-trip. Cheap: ~1 extra query.
  const coverage = account.status === 'customer' && account.domain
    ? await getAccountCoverage(id)
    : null;

  // Signal Pulse — recent account_signals for this account, risk-first
  // ranked. Imported lazily to avoid a circular import with the signals
  // module (signals.js imports nothing from here, but belt + braces).
  const { getSignalsForAccount, getSignalArchiveCount, getArchivedSignalsForAccount } =
    await import('./signals.js');
  const signals = await getSignalsForAccount(id, { limit: 20 });
  const signalArchiveCount = await getSignalArchiveCount(id);
  // Only hydrate the full archive when the caller asks for it — avoids a
  // needless query on every Pulse render. The account page passes through
  // ?archive=1 to flip this on.
  const archivedSignals = includeArchive
    ? await getArchivedSignalsForAccount(id, { limit: 50 })
    : [];

  return {
    account, prospects, drafts, sent, championCounts, coverage,
    signals, signalArchiveCount, archivedSignals,
  };
}

// Set the AE's editable notes field on an account. Feeds the signal
// analyzer's account block so the scan knows "SDR team uses Ambition,
// want Ascend AE expansion" without the operator re-typing it each run.
export async function updateAccountNotes(id, notes) {
  const { rowCount } = await query(
    `UPDATE accounts_registry
        SET notes = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, notes || null]
  );
  return rowCount > 0;
}

export async function updateAccountFields(id, fields) {
  const allowed = ['fiscal_year_end', 'budget_start_month', 'buyer_timing', 'sales_perf_topics', 'watched', 'deprioritized'];
  const sets = [];
  const vals = [id];
  let i = 1;
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${++i}`);
      vals.push(fields[k] || null);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = NOW()');
  const { rowCount } = await query(
    `UPDATE accounts_registry SET ${sets.join(', ')} WHERE id = $1`,
    vals
  );
  return rowCount > 0;
}

// Nuke the entire accounts book. Used by the "Clear all accounts" button
// when an operator wants to wipe imported test data before loading the real
// roster. Nothing FKs to accounts_registry (prospects match by domain, not
// FK), so a plain DELETE is safe. Returns the number of rows removed so the
// UI can confirm "N accounts cleared".
export async function clearAllAccounts() {
  const { rowCount } = await query(`DELETE FROM accounts_registry`);
  return rowCount || 0;
}

// Build the whitespace coverage map for a single account. For each target
// persona, find every contact on this account (matched by domain → prospects
// table, then title regex → persona), plus the most recent outbound touch +
// any reply. Coverage state is derived from those two timestamps; the UI
// uses it to color the cell and pick the right CTA.
//
// Only meaningful for customer accounts — the caller should gate this. We
// still run it for any status (cheap, and useful for debugging), but don't
// render the map unless account.status === 'customer'.
export async function getAccountCoverage(accountId) {
  const account = await getAccountById(accountId);
  if (!account || !account.domain) {
    return {
      account,
      personas: PERSONAS.map((p) => ({
        ...p, contacts: [], state: 'gap', lastContactedAt: null, lastReplyAt: null,
      })),
      launchReady: false,
    };
  }

  // One round-trip: every prospect on this domain, with their latest
  // outbound touch + reply (if any). LEFT JOINs so prospects with zero
  // sent_messages still surface.
  const { rows } = await query(
    `SELECT p.id, p.contact_name, p.contact_title, p.contact_email,
            p.persona AS scored_persona, p.researched_at,
            (SELECT MAX(sm.sent_at)
               FROM sent_messages sm
              WHERE sm.prospect_id = p.id) AS last_contacted_at,
            (SELECT MAX(sm.reply_received_at)
               FROM sent_messages sm
              WHERE sm.prospect_id = p.id AND sm.reply_received = TRUE) AS last_reply_at
       FROM prospects p
      WHERE LOWER(p.domain) = LOWER($1)
        AND p.disqualified = FALSE
      ORDER BY p.researched_at DESC NULLS LAST`,
    [account.domain]
  );

  // Bucket contacts into personas by title regex.
  const byPersona = Object.fromEntries(PERSONAS.map((p) => [p.id, []]));
  for (const r of rows) {
    const pid = matchPersona(r.contact_title);
    if (pid && byPersona[pid]) byPersona[pid].push(r);
  }

  const personas = PERSONAS.map((p) => {
    const contacts = byPersona[p.id];
    const lastContactedAt = contacts
      .map((c) => c.last_contacted_at)
      .filter(Boolean)
      .reduce((max, d) => (!max || new Date(d) > new Date(max) ? d : max), null);
    const lastReplyAt = contacts
      .map((c) => c.last_reply_at)
      .filter(Boolean)
      .reduce((max, d) => (!max || new Date(d) > new Date(max) ? d : max), null);
    const state = coverageState({
      lastContactedAt,
      lastReplyAt,
      researched: contacts.length > 0,
    });
    return { ...p, contacts, state, lastContactedAt, lastReplyAt };
  });

  // Launch-ready = every persona is either 'covered' or 'researched'. Gaps
  // and stale are the things the 30-day window has to fix.
  const launchReady = personas.every((p) => p.state === 'covered');

  return { account, personas, launchReady };
}

// Batched coverage for the accounts list page — avoids N+1 when rendering
// the launch-readiness rollup. One scan across all customer accounts,
// grouped by domain → persona. Returns a map of accountId → { ready, gaps }.
export async function getCoverageByAccount() {
  // Only customers are in scope for the launch-readiness model. Ignore the
  // others so we don't waste a query.
  const { rows: accounts } = await query(
    `SELECT id, domain FROM accounts_registry WHERE status = 'customer' AND domain IS NOT NULL`
  );
  if (accounts.length === 0) return {};

  const domains = accounts.map((a) => a.domain.toLowerCase());

  // Pull every prospect on any of those domains in one go. Include latest
  // touch + reply for the coverage-state decision.
  const { rows: prospects } = await query(
    `SELECT p.id, p.domain, p.contact_title,
            (SELECT MAX(sm.sent_at) FROM sent_messages sm WHERE sm.prospect_id = p.id) AS last_contacted_at,
            (SELECT MAX(sm.reply_received_at) FROM sent_messages sm
              WHERE sm.prospect_id = p.id AND sm.reply_received = TRUE) AS last_reply_at
       FROM prospects p
      WHERE LOWER(p.domain) = ANY($1::text[])
        AND p.disqualified = FALSE`,
    [domains]
  );

  // Build domain → persona-id → contacts[] lookup.
  const byDomain = {};
  for (const p of prospects) {
    const d = p.domain.toLowerCase();
    const pid = matchPersona(p.contact_title);
    if (!pid) continue;
    byDomain[d] ||= {};
    byDomain[d][pid] ||= [];
    byDomain[d][pid].push(p);
  }

  const out = {};
  for (const a of accounts) {
    const buckets = byDomain[a.domain.toLowerCase()] || {};
    const personaStates = PERSONAS.map((p) => {
      const contacts = buckets[p.id] || [];
      const lastContactedAt = contacts
        .map((c) => c.last_contacted_at).filter(Boolean)
        .reduce((max, d) => (!max || new Date(d) > new Date(max) ? d : max), null);
      const lastReplyAt = contacts
        .map((c) => c.last_reply_at).filter(Boolean)
        .reduce((max, d) => (!max || new Date(d) > new Date(max) ? d : max), null);
      return coverageState({
        lastContactedAt, lastReplyAt, researched: contacts.length > 0,
      });
    });
    out[a.id] = {
      ready: personaStates.every((s) => s === 'covered'),
      gaps: personaStates.filter((s) => s === 'gap' || s === 'stale').length,
      states: personaStates,
    };
  }
  return out;
}

export async function getAccountStatusCounts() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS n FROM accounts_registry GROUP BY status`
  );
  const out = { customer: 0, prospect: 0, churned: 0, disqualified: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

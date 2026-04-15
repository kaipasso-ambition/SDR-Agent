#!/usr/bin/env node
// Import a Salesforce export of Closed Lost + Customer-Churned opportunities
// into the `dead_deals` table (and upsert their accounts into accounts_registry).
//
// Usage:
//   npm run import:dead-deals -- path/to/dead_accounts.csv
//   npm run import:dead-deals -- path/to/dead_accounts.tsv
//   cat file.csv | npm run import:dead-deals -- -    # stdin
//
// Delimiter is auto-detected (tab vs comma) from the header row. The importer
// tolerates trailing empty columns (SF reports often have them) and header
// variance — any of the known aliases per field will match.
//
// Re-running is safe: dedup on Opportunity ID, upsert of accounts_registry on
// domain (else account name).

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertAccount, normalizeDomain } from '../src/db/accounts_registry.js';
import { upsertDeadDeal, countDeadDeals } from '../src/db/dead_deals.js';
import { pool } from '../src/db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- CSV / TSV parser (small, dependency-free) ----------

function parseDelimited(text) {
  // Normalize line endings.
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Auto-detect delimiter by counting tabs vs commas on the first line.
  const firstLine = src.split('\n', 1)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delim = tabs >= commas ? '\t' : ',';

  // State machine that handles quoted fields (commas or newlines inside quotes,
  // doubled-up quotes as an escape).
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
      else field += c;
    }
  }
  // Flush trailing row if the file doesn't end in \n.
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // Drop fully-empty rows.
  return rows.filter(r => r.some(cell => cell && cell.trim() !== ''));
}

// Normalize "Account Name" → "account_name" etc.
function snake(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Map header cell → canonical field name. Unknown headers stay as-is so they're
// visible in diagnostics but ignored by the importer.
const HEADER_MAP = {
  account_name: 'account_name',
  name: 'account_name',
  company: 'account_name',
  next_step: 'next_step',
  account_owner: 'owner_name',
  owner: 'owner_name',
  closed_lost_reason: 'loss_reason',
  loss_reason: 'loss_reason',
  linkedin: 'linkedin',
  linkedin_url: 'linkedin',
  current_state_pains: 'current_state_pains',
  current_state_and_pains: 'current_state_pains',
  what_are_the_business_technical_pains: 'business_technical_pains',
  business_technical_pains: 'business_technical_pains',
  champion: 'champion_raw',
  industry: 'industry',
  decision_criteria: 'decision_criteria',
  decision_process: 'decision_process',
  why_are_they_taking_the_call: 'why_taking_call',
  why_taking_call: 'why_taking_call',
  why_now_critical_event: 'why_now',
  why_now: 'why_now',
  why_ambition: 'why_ambition',
  close_date: 'close_date',
  opportunity_id: 'opportunity_id',
  account_type: 'account_type',
  foa: 'foa_note',
  foa_friend_of_ambition: 'foa_note',
  friend_of_ambition: 'foa_note',
};

function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const rawHeader = rows[0].map(h => snake(h));
  const mapped = rawHeader.map(h => HEADER_MAP[h] || h);
  const unknown = rawHeader.filter((h, i) => mapped[i] === h && h && !HEADER_MAP[h]);
  if (unknown.length) {
    console.log(`[import] unmapped header columns (will be ignored): ${unknown.join(', ')}`);
  }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const obj = {};
    const row = rows[r];
    for (let c = 0; c < mapped.length; c++) {
      const key = mapped[c];
      if (!key) continue;
      const val = (row[c] ?? '').trim();
      if (val) obj[key] = val;
    }
    if (Object.keys(obj).length) out.push(obj);
  }
  return out;
}

// SF close_date format is usually "M/D/YYYY". Accept ISO too.
function parseCloseDate(raw) {
  if (!raw) return null;
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const [, m, d, y] = us;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null; // let the DB store NULL rather than reject the row
}

// Map Account Type from SF onto our accounts_registry.status enum.
//   "Prospect"           → 'prospect'
//   "Customer - Churned" → 'churned'
//   "Customer"           → 'customer'
function mapAccountType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'prospect';
  if (s.includes('churn')) return 'churned';
  if (s.includes('customer')) return 'customer';
  if (s.includes('prospect')) return 'prospect';
  return 'prospect';
}

// ---------- main ----------

async function readInput(arg) {
  if (arg === '-' || !arg) {
    // stdin
    return new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    });
  }
  const full = path.resolve(process.cwd(), arg);
  return fs.readFileSync(full, 'utf8');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npm run import:dead-deals -- <path-to.csv|tsv|->');
    process.exit(2);
  }

  const text = await readInput(arg);
  const grid = parseDelimited(text);
  console.log(`[import] parsed ${grid.length} non-empty rows (including header)`);

  const records = rowsToObjects(grid);
  console.log(`[import] ${records.length} data rows`);

  const beforeCount = await countDeadDeals();

  let dealsInserted = 0, dealsUpdated = 0, accountsTouched = 0, skipped = 0;
  const accountStatus = new Map(); // account_name → 'churned'|'customer'|'prospect' (churn wins)
  const accountIndustry = new Map();
  const accountLinkedIn = new Map();

  // Pass 1: decide the winning status per unique account.
  //   If ANY opp for that account is Customer-Churned, the account is churned.
  for (const r of records) {
    if (!r.account_name) continue;
    const status = mapAccountType(r.account_type);
    const prior = accountStatus.get(r.account_name);
    if (status === 'churned' || !prior) accountStatus.set(r.account_name, status);
    if (r.industry && !accountIndustry.get(r.account_name)) accountIndustry.set(r.account_name, r.industry);
    if (r.linkedin && !accountLinkedIn.get(r.account_name)) accountLinkedIn.set(r.account_name, r.linkedin);
  }

  // Pass 2: upsert accounts, then upsert deals.
  const accountIdByName = new Map();
  for (const [name, status] of accountStatus.entries()) {
    const linkedin = accountLinkedIn.get(name);
    // LinkedIn company URLs aren't real domains — don't try to use them as one.
    // Domain stays null unless we eventually pull it from a different field.
    const domain = null;
    void normalizeDomain; // reserved for a future website-column mapping
    const { account, inserted } = await upsertAccount({
      account_name: name,
      domain,
      status,
      industry: accountIndustry.get(name) || null,
      notes: linkedin ? `LinkedIn: ${linkedin}` : null,
    });
    accountIdByName.set(name, account.id);
    accountsTouched++;
    if (inserted) {
      console.log(`[import]  + account ${name} (${status})`);
    } else {
      console.log(`[import]  = account ${name} (${status})`);
    }
  }

  for (const r of records) {
    if (!r.opportunity_id) {
      skipped++;
      console.log(`[import]  ! skip row — no Opportunity ID (account=${r.account_name || '?'})`);
      continue;
    }
    const account_id = accountIdByName.get(r.account_name);
    if (!account_id) {
      skipped++;
      console.log(`[import]  ! skip row — no account (opp=${r.opportunity_id})`);
      continue;
    }
    const { inserted } = await upsertDeadDeal({
      account_id,
      opportunity_id: r.opportunity_id,
      close_date: parseCloseDate(r.close_date),
      loss_reason: r.loss_reason,
      account_type_at_close: r.account_type,
      owner_name: r.owner_name,
      next_step: r.next_step,
      current_state_pains: r.current_state_pains,
      business_technical_pains: r.business_technical_pains,
      champion_raw: r.champion_raw,
      decision_criteria: r.decision_criteria,
      decision_process: r.decision_process,
      why_taking_call: r.why_taking_call,
      why_now: r.why_now,
      why_ambition: r.why_ambition,
      foa_note: r.foa_note,
    });
    if (inserted) dealsInserted++; else dealsUpdated++;
  }

  const afterCount = await countDeadDeals();
  console.log('[import] DONE');
  console.log(`[import]   accounts touched: ${accountsTouched}`);
  console.log(`[import]   deals inserted:   ${dealsInserted}`);
  console.log(`[import]   deals updated:    ${dealsUpdated}`);
  console.log(`[import]   rows skipped:     ${skipped}`);
  console.log(`[import]   total in DB:      ${beforeCount} → ${afterCount}`);

  await pool.end();
}

main().catch(err => {
  console.error('[import] FAILED:', err);
  process.exit(1);
});

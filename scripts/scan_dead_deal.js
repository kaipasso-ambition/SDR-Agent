#!/usr/bin/env node
// Single-deal revisit-scan test harness.
//
// Runs the REVISIT_SCAN_PROMPT against ONE dead_deals row and prints the
// output for human review. Does NOT write to the DB — we want to eyeball
// quality before wiring insertion.
//
// Usage:
//   node scripts/scan_dead_deal.js <opportunity_id>
//   node scripts/scan_dead_deal.js --account "ConstructConnect"   # picks newest opp
//   node scripts/scan_dead_deal.js --list                          # show importable IDs
//
// Env: reuses the same DATABASE_URL + ANTHROPIC_API_KEY as the app.

import 'dotenv/config';
import { query, pool } from '../src/db/index.js';
import { scanDeadDeal } from '../src/agents/revisit_scanner.js';

async function findDeal({ oppId, accountName }) {
  if (oppId) {
    const { rows } = await query(
      `SELECT dd.*, a.account_name, a.status AS account_status, a.industry, a.notes
         FROM dead_deals dd
         JOIN accounts_registry a ON a.id = dd.account_id
        WHERE dd.opportunity_id = $1`,
      [oppId]
    );
    return rows[0] || null;
  }
  if (accountName) {
    const { rows } = await query(
      `SELECT dd.*, a.account_name, a.status AS account_status, a.industry, a.notes
         FROM dead_deals dd
         JOIN accounts_registry a ON a.id = dd.account_id
        WHERE LOWER(a.account_name) = LOWER($1)
        ORDER BY dd.close_date DESC NULLS LAST
        LIMIT 1`,
      [accountName]
    );
    return rows[0] || null;
  }
  return null;
}

async function listAll() {
  const { rows } = await query(
    `SELECT dd.opportunity_id, a.account_name, dd.loss_reason, dd.close_date, dd.account_type_at_close
       FROM dead_deals dd
       JOIN accounts_registry a ON a.id = dd.account_id
      ORDER BY dd.close_date DESC NULLS LAST`
  );
  console.log(`\n${rows.length} dead deals:\n`);
  for (const r of rows) {
    console.log(
      `  ${r.opportunity_id}  ${r.close_date?.toISOString?.().slice(0,10) || 'no-date'}  ` +
      `${r.account_name.padEnd(30)}  ${(r.loss_reason || '').padEnd(32)}  ${r.account_type_at_close || ''}`
    );
  }
  console.log('\nRun: node scripts/scan_dead_deal.js <opportunity_id>\n');
}

async function scan(deal) {
  console.log('\n[scan] sending to Claude with web_search…');
  const result = await scanDeadDeal(deal);
  const elapsed = Math.round(result.elapsed_ms / 1000);

  console.log(`[scan] done in ${elapsed}s — ${result.searches} web searches`);
  if (result.queries.length) {
    console.log('[scan] queries used:');
    result.queries.forEach(q => console.log(`         - ${q}`));
  }

  if (result.skipped === 'no_web_search') {
    console.log('\n[scan] CIRCUIT BREAKER TRIPPED — zero web searches. Output is training-data only and unreliable. Rejecting.\n');
    console.log('---raw text below---\n');
    console.log(result.raw);
    return;
  }
  if (result.skipped === 'parse_failure') {
    console.log('\n[scan] JSON parse failed. Raw text:\n');
    console.log(result.raw);
    return;
  }
  if (result.skipped === 'not_array') {
    console.log('\n[scan] Model returned non-array JSON. Raw text:\n');
    console.log(result.raw);
    return;
  }

  const triggers = result.triggers;
  if (triggers.length === 0) {
    console.log('\n[scan] NO TRIGGERS returned. Claude found nothing material since close_date.\n');
    console.log('This is a valid answer — not every dead deal has a fresh revisit moment.');
    console.log('\n--- DEBUG: raw model text below (verify whether Claude really returned [] or the parser dropped something) ---\n');
    console.log(result.raw || '(empty response)');
    console.log('\n--- end raw text ---\n');
    return;
  }

  console.log(`\n[scan] ${triggers.length} trigger(s) returned:\n`);
  for (let i = 0; i < triggers.length; i++) {
    const s = triggers[i];
    console.log(`━━━ Trigger ${i + 1} / ${triggers.length} ━━━`);
    console.log(`  type:       ${s.signal_type}   severity: ${s.severity}   loss_reason_link: ${s.loss_reason_link}`);
    console.log(`  title:      ${s.trigger_title}`);
    console.log(`  summary:    ${s.trigger_summary}`);
    console.log(`  why unlocks:${s.why_this_unlocks}`);
    console.log(`  re-entry:   ${s.re_entry_angle}`);
    console.log(`  source:     ${s.source_url}`);
    if (s.source_excerpt) console.log(`  excerpt:    ${s.source_excerpt}`);
    if (s.sponsors_to_target && s.sponsors_to_target.length) {
      console.log(`  sponsors:`);
      for (const sp of s.sponsors_to_target) {
        console.log(`    - ${sp.name} (${sp.title || '?'}) — ${sp.role_guess || '?'} — ${sp.why_this_person || ''}`);
      }
    }
    console.log('');
  }

  console.log('━━━ VALIDATION CHECKLIST ━━━');
  console.log('  For each trigger above, manually verify:');
  console.log('    [ ] source_url resolves to a real page');
  console.log('    [ ] the claim in trigger_title matches the source');
  console.log('    [ ] the trigger is materially connected to why we lost');
  console.log('    [ ] the sponsors are actually at the company right now');
  console.log('    [ ] you would actually send re_entry_angle if a champion asked you to');
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node scripts/scan_dead_deal.js <opportunity_id>');
    console.error('   or: node scripts/scan_dead_deal.js --account "Name"');
    console.error('   or: node scripts/scan_dead_deal.js --list');
    process.exit(2);
  }

  try {
    if (args[0] === '--list') {
      await listAll();
      return;
    }
    let deal;
    if (args[0] === '--account') {
      deal = await findDeal({ accountName: args[1] });
    } else {
      deal = await findDeal({ oppId: args[0] });
    }
    if (!deal) {
      console.error('No dead_deals row matched. Run with --list to see available IDs.');
      process.exit(1);
    }
    console.log(`\nScanning: ${deal.account_name} — ${deal.opportunity_id} — loss: "${deal.loss_reason}" — closed: ${deal.close_date?.toISOString?.().slice(0,10)}`);
    await scan(deal);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n[scan] FAILED:', err);
  pool.end().finally(() => process.exit(1));
});

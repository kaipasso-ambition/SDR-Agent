// Signal analyzer — weekly (or manual) Claude+web_search scan of customer
// accounts. Mirrors src/agents/champion_tracker.js 1:1 in shape:
//   - fire-and-forget worker; progress tracked via account_signal_jobs
//   - per-account try/catch so one failure doesn't kill the cycle
//   - circuit breaker: searchCount === 0 → skip, do not insert
//   - JSON extraction tolerant of both bare JSON and fenced code blocks
//
// Budget: ~3–6 web_searches per account ≈ 30–45s and ~$0.10 each. At 150
// customer accounts / week that's ~75 min and ~$15 — fine for Sprint 1.

import Anthropic from '@anthropic-ai/sdk';
import { SIGNAL_ANALYSIS_PROMPT } from '../prompts/signal_analysis.js';
import { listAccounts, getAccountById } from '../db/accounts_registry.js';
import { insertSignals, buildDedupKey } from '../db/signals.js';
import { query } from '../db/index.js';

const client = new Anthropic();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask Claude for signals on ONE account. Returns { signals, searches } or
// throws. Does not touch the DB — the caller decides whether to insert
// (so the circuit breaker stays readable).
export async function scanOneAccount(account) {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const cutoff = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const userContent = `
Today's date: ${todayIso}
Recency cutoff: ${cutoff} (only return signals whose event_date is ON OR AFTER this date)

Account to scan:
${JSON.stringify({
  account_name: account.account_name,
  domain: account.domain,
  industry: account.industry,
  status: account.status,
  notes: account.notes,
  buyer_timing: account.buyer_timing || null,
  sales_perf_topics: account.sales_perf_topics || null,
  fiscal_year_end: account.fiscal_year_end || null,
  budget_start_month: account.budget_start_month || null,
}, null, 2)}

Return a JSON array of signals per the instructions. Every signal must include "event_date" in YYYY-MM-DD format, on or after ${cutoff}.
`.trim();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: SIGNAL_ANALYSIS_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }, { timeout: 4 * 60 * 1000 });

  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const searchCount = response.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;

  // Circuit breaker — zero searches means Claude short-circuited to
  // training data. Treat as unusable, skip the account, do not insert.
  if (searchCount === 0) {
    return { signals: [], searches: 0, raw: text, skipped: 'no_web_search' };
  }

  // Parse — tolerate fenced code blocks AND a raw array.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const bracket = text.match(/\[[\s\S]*\]/);
  const jsonText = fenced ? fenced[1].trim() : (bracket ? bracket[0] : text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error(`[signal_analyzer] JSON parse failed for ${account.account_name}: ${text.slice(0, 200)}`);
    return { signals: [], searches: searchCount, raw: text, skipped: 'parse_failure' };
  }

  if (!Array.isArray(parsed)) {
    return { signals: [], searches: searchCount, raw: text, skipped: 'not_array' };
  }

  // Normalize signals — enforce required fields, parse event_date, drop
  // anything outside the 60-day window as a server-side guardrail. The
  // model is instructed to drop these itself but doesn't always comply,
  // especially for well-known historical events it pulls from training.
  const now = Date.now();
  const cutoffMs = now - 60 * 24 * 60 * 60 * 1000;
  // Grace period for future dates: announcements can be dated 1-2 days
  // ahead of publication (scheduled press releases). Tolerate up to 7
  // days; anything further out is almost always a hallucination.
  const futureGraceMs = now + 7 * 24 * 60 * 60 * 1000;

  const signals = [];
  let droppedStale = 0;
  for (const s of parsed) {
    if (!s || !s.title || !s.risk_class || !s.severity) continue;

    const eventDate = parseEventDate(s.event_date);
    if (!eventDate) {
      droppedStale++;
      console.log(`[signal_analyzer] drop (no event_date): "${s.title}"`);
      continue;
    }
    const ts = eventDate.getTime();
    if (ts < cutoffMs) {
      droppedStale++;
      console.log(`[signal_analyzer] drop (stale ${s.event_date}): "${s.title}"`);
      continue;
    }
    if (ts > futureGraceMs) {
      droppedStale++;
      console.log(`[signal_analyzer] drop (future ${s.event_date}): "${s.title}"`);
      continue;
    }
    // Source must cite a URL; model occasionally returns just a title.
    if (!s.source_url || typeof s.source_url !== 'string' || !/^https?:\/\//i.test(s.source_url)) {
      droppedStale++;
      console.log(`[signal_analyzer] drop (no source_url): "${s.title}"`);
      continue;
    }

    signals.push({
      ...s,
      event_date: eventDate.toISOString().slice(0, 10),
      account_id: account.id,
      dedup_key: s.dedup_key || buildDedupKey(s),
      raw_model_output: s,
    });
  }

  if (droppedStale > 0) {
    console.log(`[signal_analyzer] ${account.account_name}: dropped ${droppedStale} stale/undated/unsourced signal(s)`);
  }

  return { signals, searches: searchCount, raw: text, droppedStale };
}

// Accept YYYY-MM-DD or ISO timestamp; reject everything else. Returning
// a real Date (or null) so the caller can compare against the cutoff.
function parseEventDate(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Main entry point — scan a set of customer accounts, insert the signals,
// update the job row. Called by the cron (all customer accounts) AND by
// the manual `POST /signals/scan` route (can scope by account_ids).
export async function runSignalScanCycle({
  user_id = null,
  account_ids = null,
  job_id = null,
  limit = 200,
} = {}) {
  const updateJob = async (fields) => {
    if (!job_id) return;
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => fields[k]);
    await query(
      `UPDATE account_signal_jobs SET ${sets} WHERE id = $1`,
      [job_id, ...values]
    );
  };

  // Build account pool. If account_ids is passed, use those; else every
  // customer account. Sprint 1 is customer-only per plan.
  let accounts;
  if (account_ids && account_ids.length > 0) {
    accounts = [];
    for (const id of account_ids) {
      const a = await getAccountById(id);
      if (a) accounts.push(a);
    }
  } else {
    accounts = await listAccounts({ status: 'customer' });
    accounts = accounts.slice(0, limit);
  }

  console.log(`[signal_analyzer] START job=${job_id} scanning ${accounts.length} account(s)`);

  let scanned = 0;
  let detected = 0;
  let skippedDedup = 0;
  let errors = 0;

  for (const account of accounts) {
    try {
      const { signals, searches, skipped } = await scanOneAccount(account);
      scanned++;

      if (skipped) {
        console.log(`[signal_analyzer] skip ${account.account_name} (${skipped}, searches=${searches})`);
      } else if (signals.length === 0) {
        console.log(`[signal_analyzer] none ${account.account_name} (searches=${searches})`);
      } else {
        const { inserted, updated } = await insertSignals(signals, job_id);
        detected += inserted;
        skippedDedup += updated;
        console.log(`[signal_analyzer] ${account.account_name}: +${inserted} new, ${updated} dedup (searches=${searches})`);
      }

      await updateJob({
        accounts_scanned: scanned,
        signals_detected: detected,
        signals_skipped_dedup: skippedDedup,
      });
    } catch (err) {
      errors++;
      console.error(`[signal_analyzer] ${account.account_name} failed:`, err.message);
      await updateJob({ errors });
    }

    // Gentle pacing to keep web_search rate inside Anthropic's per-minute
    // bucket and avoid blowing through daily budget in one burst.
    await sleep(2000);
  }

  await updateJob({
    status: errors > 0 && scanned === 0 ? 'failed' : 'completed',
    accounts_scanned: scanned,
    signals_detected: detected,
    signals_skipped_dedup: skippedDedup,
    errors,
    finished_at: new Date(),
  });

  console.log(`[signal_analyzer] DONE scanned=${scanned} new=${detected} dedup=${skippedDedup} errors=${errors}`);
  return { scanned, detected, skippedDedup, errors };
}

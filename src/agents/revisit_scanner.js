// Revisit scanner — runs the REVISIT_SCAN_PROMPT against ONE dead deal and
// returns parsed triggers + metadata. Both the CLI script and the /revisit
// route call this; keep all model + parsing logic here.
//
// Does NOT touch the DB — caller decides whether to persist. That keeps the
// dry-run CLI and the persisting route on the same code path with no
// branching.

import Anthropic from '@anthropic-ai/sdk';
import { REVISIT_SCAN_PROMPT } from '../prompts/revisit_scan.js';

const client = new Anthropic();

// web_search injects <cite index="...">...</cite> wrappers around quoted spans.
// Source URL is the citation that matters; the inline tags are noise. Strip
// recursively from every string in the result.
const CITE_TAG_RE = /<\/?cite[^>]*>/g;
export function stripCiteTags(value) {
  if (typeof value === 'string') return value.replace(CITE_TAG_RE, '').trim();
  if (Array.isArray(value)) return value.map(stripCiteTags);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripCiteTags(v);
    return out;
  }
  return value;
}

// Shape the deal context for Claude. Pulls LinkedIn out of the
// accounts_registry.notes prefix the importer wrote.
function buildContext(deal) {
  return {
    account_name: deal.account_name,
    account_status: deal.account_status,
    industry: deal.industry,
    opportunity_id: deal.opportunity_id,
    close_date: deal.close_date,
    loss_reason: deal.loss_reason,
    account_type_at_close: deal.account_type_at_close,
    linkedin: deal.notes && deal.notes.startsWith('LinkedIn: ') ? deal.notes.slice(10) : null,
    owner_name: deal.owner_name,
    original_context: {
      current_state_pains: deal.current_state_pains,
      business_technical_pains: deal.business_technical_pains,
      champion_raw: deal.champion_raw,
      decision_criteria: deal.decision_criteria,
      decision_process: deal.decision_process,
      why_taking_call: deal.why_taking_call,
      why_now: deal.why_now,
      why_ambition: deal.why_ambition,
      foa_note: deal.foa_note,
      next_step: deal.next_step,
    },
  };
}

/**
 * Scan one dead deal. Returns:
 *   { triggers: [...], searches: int, queries: [str], elapsed_ms: int,
 *     skipped: 'no_web_search' | 'parse_failure' | null, raw: str }
 */
export async function scanDeadDeal(deal) {
  const context = buildContext(deal);
  const userContent = `
Account and deal context:
${JSON.stringify(context, null, 2)}

Scan the web for what has CHANGED since close_date that might neutralize the loss_reason. Return the JSON array per the instructions.
`.trim();

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: REVISIT_SCAN_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }, { timeout: 4 * 60 * 1000 });

  const elapsed_ms = Date.now() - t0;
  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const searches = response.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;
  const queries = response.content
    .filter((b) => b.type === 'server_tool_use' && b.name === 'web_search')
    .map((b) => b.input?.query).filter(Boolean);

  if (searches === 0) {
    return { triggers: [], searches, queries, elapsed_ms, skipped: 'no_web_search', raw: text };
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const bracket = text.match(/\[[\s\S]*\]/);
  const jsonText = fenced ? fenced[1].trim() : (bracket ? bracket[0] : text);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { triggers: [], searches, queries, elapsed_ms, skipped: 'parse_failure', raw: text };
  }
  if (!Array.isArray(parsed)) {
    return { triggers: [], searches, queries, elapsed_ms, skipped: 'not_array', raw: text };
  }

  const triggers = stripCiteTags(parsed);
  return { triggers, searches, queries, elapsed_ms, skipped: null, raw: text };
}

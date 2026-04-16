// Revisit scanner — runs the REVISIT_SCAN_PROMPT against ONE dead deal and
// returns parsed triggers + metadata. Both the CLI script and the /revisit
// route call this; keep all model + parsing logic here.
//
// Does NOT touch the DB — caller decides whether to persist. That keeps the
// dry-run CLI and the persisting route on the same code path with no
// branching.

import Anthropic from '@anthropic-ai/sdk';
import { REVISIT_SCAN_PROMPT } from '../prompts/revisit_scan.js';
import { REVISIT_PATHS_PROMPT } from '../prompts/revisit_paths.js';

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
//
// `aeNotes` is the list of timestamped scraps the AE has dropped since the
// deal closed — each one is something they learned later that might matter
// ("new CRO is ex-Outreach", "saw them at Gartner"). We pass them into every
// call so late intel actually shows up in the output.
function buildContext(deal, aeNotes = []) {
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
    ae_notes: Array.isArray(aeNotes) && aeNotes.length > 0
      ? aeNotes.map((n) => ({
          added: n.created_at,
          note: n.note,
        }))
      : null,
  };
}

/**
 * Scan one dead deal. Returns:
 *   { triggers: [...], searches: int, queries: [str], elapsed_ms: int,
 *     skipped: 'no_web_search' | 'parse_failure' | null, raw: str }
 */
export async function scanDeadDeal(deal, { aeNotes = [] } = {}) {
  const context = buildContext(deal, aeNotes);
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

/**
 * Build three re-entry paths for a single trigger on a dead deal. No
 * web_search — this is pure reasoning over the trigger + deal context.
 *
 * Returns: { paths: [...], elapsed_ms: int } or throws on failure.
 */
export async function buildRevisitPaths(deal, trigger, { aeNotes = [] } = {}) {
  const context = buildContext(deal, aeNotes);
  const userContent = `
Account and deal context:
${JSON.stringify(context, null, 2)}

The following trigger was surfaced by a recent web scan:
${JSON.stringify(trigger, null, 2)}

Generate three distinct re-entry paths for this trigger. Return the JSON object per the instructions.
`.trim();

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: REVISIT_PATHS_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  }, { timeout: 2 * 60 * 1000 });

  const elapsed_ms = Date.now() - t0;
  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

  // Parse — try fenced JSON first, then bare object.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);

  const parsed = JSON.parse(jsonText);
  if (!parsed.paths || !Array.isArray(parsed.paths)) {
    throw new Error('Model returned JSON without a paths array');
  }

  return { paths: parsed.paths, elapsed_ms };
}

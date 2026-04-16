// Expansion scanner — runs EXPANSION_SCAN_PROMPT against ONE active customer
// and returns parsed triggers. Mirror of src/agents/revisit_scanner.js but
// scoped to customers and fed the dossier + notes + people map instead of a
// loss record.
//
// Does NOT touch the DB — caller decides whether to persist. Same contract as
// the revisit scanner so the route stays thin.

import Anthropic from '@anthropic-ai/sdk';
import { EXPANSION_SCAN_PROMPT } from '../prompts/expansion_scan.js';
import { EXPANSION_PATHS_PROMPT } from '../prompts/expansion_paths.js';

const client = new Anthropic();

// web_search injects <cite index="...">...</cite> wrappers around quoted
// spans. Strip them everywhere in the parsed output so they don't pollute
// the stored JSON or the UI.
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

// Shape the customer context for Claude. The dossier's four free-text fields
// + chronological notes + people map (with deal_role + stance) are all the
// scanner needs to run destination-driven queries instead of cookie-cutter
// ones. Null out empty strings so the model doesn't waste tokens on blank
// lines.
function buildContext(account, dossier, notes = [], contacts = []) {
  const blank = (s) => (typeof s === 'string' && s.trim().length > 0 ? s.trim() : null);
  return {
    account_name: account.account_name,
    domain: account.domain || null,
    industry: account.industry || null,
    status: account.status,
    dossier: {
      footprint: blank(dossier?.footprint),
      destination: blank(dossier?.destination),
      stack_competitive: blank(dossier?.stack_competitive),
      open_questions: blank(dossier?.open_questions),
      updated_at: dossier?.updated_at || null,
    },
    notes: Array.isArray(notes) && notes.length > 0
      ? notes.map((n) => ({ added: n.created_at, note: n.note }))
      : null,
    people_map: Array.isArray(contacts) && contacts.length > 0
      ? contacts.map((c) => ({
          name: c.name,
          title: c.title || null,
          deal_role: c.deal_role || 'unknown',
          stance: c.stance || 'neutral',
          notes: c.notes || null,
          linkedin_url: c.linkedin_url || null,
        }))
      : null,
  };
}

/**
 * Scan one active customer for expansion triggers. Returns:
 *   { triggers: [...], searches: int, queries: [str], elapsed_ms: int,
 *     skipped: 'no_web_search' | 'parse_failure' | 'not_array' | null,
 *     raw: str }
 */
export async function scanCustomer(account, { dossier, notes = [], contacts = [] } = {}) {
  const context = buildContext(account, dossier, notes, contacts);
  const userContent = `
Customer and dossier context:
${JSON.stringify(context, null, 2)}

Scan the web for what is happening externally that would STRENGTHEN one of the stated destination goals. Every trigger MUST tag which destination_link phrase it advances. Return the JSON array per the instructions.
`.trim();

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: EXPANSION_SCAN_PROMPT,
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

  // Circuit breaker — identical to revisit. If Claude answered from training
  // data instead of searching, the output is worthless; better to skip than
  // to persist fabricated signals.
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
 * Build three expansion paths for a single trigger on a customer. No
 * web_search — pure reasoning over the trigger + dossier + people map.
 *
 * Returns: { paths: [...], elapsed_ms: int } or throws on failure.
 */
export async function buildExpansionPaths(account, trigger, { dossier, notes = [], contacts = [] } = {}) {
  const context = buildContext(account, dossier, notes, contacts);
  const userContent = `
Customer and dossier context:
${JSON.stringify(context, null, 2)}

The following expansion trigger was surfaced by the scanner:
${JSON.stringify(trigger, null, 2)}

Generate three distinct expansion paths for this trigger. Remember: this is an active customer with a people map — if a champion or sponsor exists, at least one path must route through them. Return the JSON object per the instructions.
`.trim();

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: EXPANSION_PATHS_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  }, { timeout: 2 * 60 * 1000 });

  const elapsed_ms = Date.now() - t0;
  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);

  const parsed = JSON.parse(jsonText);
  if (!parsed.paths || !Array.isArray(parsed.paths)) {
    throw new Error('Model returned JSON without a paths array');
  }

  return { paths: parsed.paths, elapsed_ms };
}

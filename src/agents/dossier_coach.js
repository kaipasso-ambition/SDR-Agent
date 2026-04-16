// Dossier coach agent — runs DOSSIER_COACH_PROMPT against an active customer
// and returns specific, web-grounded suggestions per dossier field. Pure
// advisory layer: the caller persists the result but never mutates the
// dossier fields themselves.
//
// Uses web_search like the expansion scanner, but with a lower search ceiling
// (3-6 searches vs 6+) because the goal is to find what the AE should be
// asking, not to exhaustively survey external movement.

import Anthropic from '@anthropic-ai/sdk';
import { DOSSIER_COACH_PROMPT } from '../prompts/dossier_coach.js';
import { stripCiteTags } from './expansion_scanner.js';

const client = new Anthropic();

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
        }))
      : null,
  };
}

/**
 * Coach one customer's dossier. Returns:
 *   { suggestions: {footprint, destination, stack_competitive, open_questions,
 *                  rationale, sources},
 *     searches: int, queries: [str], elapsed_ms: int,
 *     skipped: 'parse_failure' | 'not_object' | null, raw: str }
 *
 * Note: unlike scanCustomer we do NOT circuit-break on searches===0. Coaching
 * can be valuable from the dossier + notes alone when the AE has rich internal
 * context; forcing a web search there would just add latency.
 */
export async function coachDossier(account, { dossier, notes = [], contacts = [] } = {}) {
  const context = buildContext(account, dossier, notes, contacts);
  const userContent = `
Customer and current dossier state:
${JSON.stringify(context, null, 2)}

The AE asked for help figuring out what to fill in. Suggest specific bullets per field — heaviest weight on open_questions, grounded in what you find on the web. Return the JSON object per the instructions.
`.trim();

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: DOSSIER_COACH_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }, { timeout: 3 * 60 * 1000 });

  const elapsed_ms = Date.now() - t0;
  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const searches = response.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;
  const queries = response.content
    .filter((b) => b.type === 'server_tool_use' && b.name === 'web_search')
    .map((b) => b.input?.query).filter(Boolean);

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { suggestions: null, searches, queries, elapsed_ms, skipped: 'parse_failure', raw: text };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { suggestions: null, searches, queries, elapsed_ms, skipped: 'not_object', raw: text };
  }

  // Normalize: ensure each field is an array even if the model omitted one.
  const asArr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim().length > 0) : []);
  const suggestions = stripCiteTags({
    footprint:         asArr(parsed.footprint),
    destination:       asArr(parsed.destination),
    stack_competitive: asArr(parsed.stack_competitive),
    open_questions:    asArr(parsed.open_questions),
    rationale:         typeof parsed.rationale === 'string' ? parsed.rationale : null,
    sources:           Array.isArray(parsed.sources)
                         ? parsed.sources.filter((s) => s && typeof s.url === 'string')
                         : [],
  });

  return { suggestions, searches, queries, elapsed_ms, skipped: null, raw: text };
}

// Dossier planner agent — runs DOSSIER_PLAN_PROMPT against a customer's
// dossier + notes + people map, returns 3-5 ranked expansion hypotheses with
// calibrated odds + impact.
//
// Pure synthesis. No web_search here — the scanner (expansion_scanner.js) is
// the external-research layer, the coach (dossier_coach.js) is the advisory
// layer, this one is the strategic layer that turns internal evidence into a
// plan. Separating concerns keeps each prompt tightly scoped.
//
// Latency: ~15-30s. Called fire-and-forget from the plan route so the HTTP
// handler doesn't block.

import Anthropic from '@anthropic-ai/sdk';
import { DOSSIER_PLAN_PROMPT } from '../prompts/dossier_plan.js';

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
 * Generate the strategic plan. Returns:
 *   { plan: { hypotheses: [...], rationale, ranking_notes },
 *     elapsed_ms: int,
 *     skipped: 'parse_failure' | 'not_object' | 'no_hypotheses' | null,
 *     raw: str }
 */
export async function planDossier(account, { dossier, notes = [], contacts = [] } = {}) {
  const context = buildContext(account, dossier, notes, contacts);
  const userContent = `
Customer + dossier + notes + people map:
${JSON.stringify(context, null, 2)}

Produce 3-5 ranked expansion hypotheses (odds × impact) per the instructions. Return the JSON object.
`.trim();

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: DOSSIER_PLAN_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  }, { timeout: 3 * 60 * 1000 });

  const elapsed_ms = Date.now() - t0;
  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { plan: null, elapsed_ms, skipped: 'parse_failure', raw: text };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { plan: null, elapsed_ms, skipped: 'not_object', raw: text };
  }
  const hypotheses = Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [];
  if (hypotheses.length === 0) {
    return { plan: null, elapsed_ms, skipped: 'no_hypotheses', raw: text };
  }

  // Normalize each hypothesis defensively so the view can render without
  // a dozen optional-chain guards. Keep unknown fields if the model adds any —
  // future-proofing is cheap here.
  const asInt = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const clampPct = (v) => {
    const n = asInt(v);
    if (n == null) return null;
    return Math.max(0, Math.min(100, n));
  };
  const clamp15 = (v) => {
    const n = asInt(v);
    if (n == null) return null;
    return Math.max(1, Math.min(5, n));
  };
  const clamp110 = (v) => {
    const n = asInt(v);
    if (n == null) return null;
    return Math.max(1, Math.min(10, n));
  };
  const asStr = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

  const plan = {
    hypotheses: hypotheses.map((h) => ({
      move_name:        asStr(h.move_name) || '(unnamed move)',
      hypothesis:       asStr(h.hypothesis),
      destination_link: asStr(h.destination_link),
      odds:             clampPct(h.odds),
      odds_reasoning:   asStr(h.odds_reasoning),
      impact: {
        arr_delta_usd:   Number.isFinite(h?.impact?.arr_delta_usd) ? Math.round(h.impact.arr_delta_usd) : null,
        seats_delta:     asStr(h?.impact?.seats_delta),
        strategic_value: asStr(h?.impact?.strategic_value),
        timeframe_days:  asInt(h?.impact?.timeframe_days),
      },
      effort_score: clamp15(h.effort_score),
      confidence:   clamp110(h.confidence),
      key_moves: Array.isArray(h.key_moves)
        ? h.key_moves
            .filter((m) => m && typeof m === 'object')
            .map((m) => ({
              actor: asStr(m.actor) || 'ae',
              what:  asStr(m.what),
              why:   asStr(m.why),
            }))
            .filter((m) => m.what)
        : [],
      champion_needed: h.champion_needed && typeof h.champion_needed === 'object'
        ? {
            from_people_map: Boolean(h.champion_needed.from_people_map),
            who:             asStr(h.champion_needed.who),
            ask:             asStr(h.champion_needed.ask),
          }
        : null,
      key_variable:  asStr(h.key_variable),
      open_question: asStr(h.open_question),
    })),
    rationale:     asStr(parsed.rationale),
    ranking_notes: asStr(parsed.ranking_notes),
  };

  return { plan, elapsed_ms, skipped: null, raw: text };
}

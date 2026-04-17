// hypothesis_generator agent — single Claude call (no web_search) that
// drafts 1-3 evidence-anchored hypotheses from the AE-selected signals +
// dossier + people map. ~10-20s latency. Fire-and-forget from the Game
// Plan "Generate hypotheses" button.

import Anthropic from '@anthropic-ai/sdk';
import { HYPOTHESIS_GENERATOR_PROMPT } from '../prompts/hypothesis_generator.js';

const client = new Anthropic();

const VALID_USE_CASES = new Set([
  'performance_graph', 'ascend_coaching', 'gtm_governance',
  'manager_enablement', 'rep_ramp', 'multi_team_rollup',
]);

function buildContext(account, { selectedSignals = [], dossier = null, contacts = [], personas = [], useCaseFit = null } = {}) {
  const blank = (s) => (typeof s === 'string' && s.trim().length > 0 ? s.trim() : null);
  return {
    account_name: account.account_name,
    industry: account.industry || null,
    status: account.status,
    fiscal_year_end: account.fiscal_year_end || null,
    buyer_timing: blank(account.buyer_timing),
    sales_perf_topics: blank(account.sales_perf_topics),
    selected_signals: selectedSignals.slice(0, 20).map((s) => ({
      id: s.id,
      detected_at: s.detected_at,
      risk_class: s.risk_class || null,
      severity: s.severity || null,
      title: s.title,
      summary: s.summary || null,
      so_what: s.so_what || null,
    })),
    dossier: dossier ? {
      footprint: blank(dossier.footprint),
      destination: blank(dossier.destination),
      stack_competitive: blank(dossier.stack_competitive),
      open_questions: blank(dossier.open_questions),
    } : null,
    people_map: Array.isArray(contacts) && contacts.length > 0
      ? contacts.slice(0, 25).map((c) => ({
          name: c.name,
          title: c.title || null,
          deal_role: c.deal_role || 'unknown',
        }))
      : null,
    valid_target_persona_ids: personas.map((p) => p.id),
    prior_use_case_fit: useCaseFit || null,
  };
}

export async function generateHypotheses(account, ctx = {}) {
  const context = buildContext(account, ctx);
  const validPersonaIds = new Set(context.valid_target_persona_ids);
  const validSignalIds = new Set(context.selected_signals.map((s) => s.id));

  const userContent = `Account context:
${JSON.stringify(context, null, 2)}

Draft 1-3 hypotheses per the instructions. Return the JSON.`;

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: HYPOTHESIS_GENERATOR_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  }, { timeout: 90 * 1000 });

  const elapsed_ms = Date.now() - t0;
  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);

  let parsed;
  try { parsed = JSON.parse(jsonText); } catch {
    return { result: null, elapsed_ms, error: 'parse_failure', raw: text };
  }

  const asStr = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
  const asInt = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const clamp15 = (v) => { const n = asInt(v); if (n == null) return 3; return Math.max(1, Math.min(5, n)); };

  const raw = Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [];
  const normHyps = raw.map((h) => {
    if (!h || typeof h !== 'object') return null;
    const useCase = asStr(h.use_case);
    if (!useCase || !VALID_USE_CASES.has(useCase)) return null;
    const personaId = asStr(h.target_persona_id);
    if (!personaId || !validPersonaIds.has(personaId)) return null;
    const hook = asStr(h.narrative_hook);
    if (!hook) return null;
    const narr = (h.narrative && typeof h.narrative === 'object') ? {
      current_state: asStr(h.narrative.current_state),
      future_state:  asStr(h.narrative.future_state),
      bridge:        asStr(h.narrative.bridge),
    } : null;
    const narrHasContent = narr && (narr.current_state || narr.future_state || narr.bridge);
    const evIds = Array.isArray(h.evidence_signal_ids)
      ? h.evidence_signal_ids.map(asStr).filter((id) => id && validSignalIds.has(id))
      : [];
    return {
      use_case: useCase,
      target_persona_id: personaId,
      narrative_hook: hook,
      narrative: narrHasContent ? narr : null,
      confidence: clamp15(h.confidence),
      evidence_signal_ids: evIds,
    };
  }).filter(Boolean).slice(0, 3);

  return {
    result: {
      hypotheses: normHyps,
      rationale: asStr(parsed.rationale),
    },
    elapsed_ms,
    error: null,
    raw: text,
  };
}

// use_case_fit agent — single Claude call (no web_search) that maps an
// account's signals + dossier + people map onto the Ambition use-case
// menu. ~10-20s latency. Called fire-and-forget from the Game Plan
// "Identify use case" button.

import Anthropic from '@anthropic-ai/sdk';
import { USE_CASE_FIT_PROMPT } from '../prompts/use_case_fit.js';

const client = new Anthropic();

const USE_CASE_LABEL = {
  performance_graph:  'Performance Graph',
  ascend_coaching:    'Ascend coaching',
  gtm_governance:     'GTM Governance',
  manager_enablement: 'Manager enablement',
  rep_ramp:           'Rep ramp',
  multi_team_rollup:  'Multi-team roll-up',
};

function buildContext(account, { signals = [], dossier = null, contacts = [] } = {}) {
  const blank = (s) => (typeof s === 'string' && s.trim().length > 0 ? s.trim() : null);
  return {
    account_name: account.account_name,
    industry: account.industry || null,
    status: account.status,
    notes: account.notes || null,
    signals: Array.isArray(signals) && signals.length > 0
      ? signals.slice(0, 12).map((s) => ({
          detected_at: s.detected_at,
          risk_class: s.risk_class || null,
          severity: s.severity || null,
          title: s.title,
          summary: s.summary || null,
          so_what: s.so_what || null,
        }))
      : null,
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
  };
}

export async function fitUseCase(account, ctx = {}) {
  const context = buildContext(account, ctx);
  const userContent = `Account context:
${JSON.stringify(context, null, 2)}

Pick the best-fit Ambition use case per the instructions. Return the JSON.`;

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: USE_CASE_FIT_PROMPT,
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
  const clamp15 = (v) => { const n = asInt(v); if (n == null) return null; return Math.max(1, Math.min(5, n)); };

  const normPick = (p) => {
    if (!p || typeof p !== 'object') return null;
    const useCase = asStr(p.use_case);
    if (!useCase || !USE_CASE_LABEL[useCase]) return null;
    return {
      use_case: useCase,
      label: USE_CASE_LABEL[useCase],
      why: asStr(p.why),
      evidence: Array.isArray(p.evidence)
        ? p.evidence.map(asStr).filter(Boolean).slice(0, 5)
        : [],
      audience: ['frontline_mgr', 'revops', 'cro_exec'].includes(p.audience) ? p.audience : null,
      confidence: clamp15(p.confidence),
    };
  };

  const result = {
    primary: normPick(parsed.primary),
    secondary: normPick(parsed.secondary),
    rationale: asStr(parsed.rationale),
  };
  return { result, elapsed_ms, error: null, raw: text };
}

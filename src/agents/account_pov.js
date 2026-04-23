// account_pov agent — synthesizes a 2-4 sentence POV + single-action
// strategy for one account from its signals + prospects + metadata. No
// web_search. Runs on Haiku (~$0.001, ~1-2s) so we can regenerate after
// every signal or prospect scan without worrying about budget.

import Anthropic from '@anthropic-ai/sdk';
import { ACCOUNT_POV_PROMPT } from '../prompts/account_pov.js';

const client = new Anthropic();

const VALID_PRIORITIES = new Set(['hot', 'warm', 'cool']);

export async function generateAccountPov({ account, signals, prospects, useCaseFit, industryInsight }) {
  const recentSignals = (signals || []).slice(0, 10).map((s) => ({
    detected_at: s.detected_at,
    signal_type: s.signal_type,
    risk_class: s.risk_class,
    severity: s.severity,
    title: s.title,
    summary: s.summary,
    source_url: s.source_url,
  }));

  const prospectList = (prospects || []).slice(0, 5).map((p) => ({
    name: p.name,
    title: p.title,
    signal: p.signal,
    signal_type: p.signal_type,
    signal_date: p.signal_date,
  }));

  const userContent = `Account:
${JSON.stringify({
  account_name: account.account_name,
  domain: account.domain || null,
  industry: account.industry || null,
  status: account.status,
  notes: account.notes || null,
  fiscal_year_end: account.fiscal_year_end || null,
  budget_start_month: account.budget_start_month || null,
  buyer_timing: account.buyer_timing || null,
  sales_perf_topics: account.sales_perf_topics || null,
}, null, 2)}

Signals (last 60 days, newest first):
${recentSignals.length > 0 ? JSON.stringify(recentSignals, null, 2) : '[]'}

Prospects (people at this company showing intent):
${prospectList.length > 0 ? JSON.stringify(prospectList, null, 2) : '[]'}

${useCaseFit ? `Use-case fit intel:\n${JSON.stringify(useCaseFit, null, 2)}\n` : ''}
${industryInsight ? `Industry insight intel:\n${JSON.stringify(industryInsight, null, 2)}\n` : ''}

Write the POV, strategy, and priority. Return JSON only.`;

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: ACCOUNT_POV_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  }, { timeout: 20_000 });

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

  const pov = typeof parsed.pov === 'string' ? parsed.pov.trim() : null;
  const strategy = typeof parsed.strategy === 'string' ? parsed.strategy.trim() : null;
  const priority = VALID_PRIORITIES.has(parsed.priority) ? parsed.priority : 'cool';

  if (!pov || !strategy) {
    return { result: null, elapsed_ms, error: 'missing_fields', raw: text };
  }

  return {
    result: { pov, strategy, priority, generated_at: new Date().toISOString() },
    elapsed_ms,
    error: null,
    raw: text,
  };
}

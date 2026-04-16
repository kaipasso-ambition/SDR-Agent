// industry_insight agent — Claude + web_search, returns 1-3 Challenger-
// style insights tied to the account's industry, scoped to Sales
// Performance and Coaching. ~30-90s latency. Fire-and-forget from the
// Game Plan "Pull industry insight" button.

import Anthropic from '@anthropic-ai/sdk';
import { INDUSTRY_INSIGHT_PROMPT } from '../prompts/industry_insight.js';

const client = new Anthropic();

function buildContext(account) {
  return {
    account_name: account.account_name,
    industry: account.industry || null,
    domain: account.domain || null,
  };
}

export async function pullIndustryInsight(account) {
  const context = buildContext(account);
  const userContent = `Account context:
${JSON.stringify(context, null, 2)}

Find 1-3 Challenger Insights tied to this industry, scoped to Sales Performance + Coaching, per the instructions. Return the JSON.`;

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: INDUSTRY_INSIGHT_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }, { timeout: 3 * 60 * 1000 });

  const elapsed_ms = Date.now() - t0;
  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const searches = response.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);

  let parsed;
  try { parsed = JSON.parse(jsonText); } catch {
    return { result: null, searches, elapsed_ms, error: 'parse_failure', raw: text };
  }

  const asStr = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
  const insights = Array.isArray(parsed.insights) ? parsed.insights : [];
  const normInsights = insights.map((i) => {
    if (!i || typeof i !== 'object') return null;
    const sourceUrl = asStr(i.source_url);
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;
    return {
      headline: asStr(i.headline),
      what_changed: asStr(i.what_changed),
      why_it_costs_them: asStr(i.why_it_costs_them),
      the_reframe: asStr(i.the_reframe),
      source_url: sourceUrl,
      source_pub: asStr(i.source_pub),
    };
  }).filter((i) => i && i.headline && i.what_changed).slice(0, 3);

  return {
    result: { insights: normInsights, searches },
    searches,
    elapsed_ms,
    error: null,
    raw: text,
  };
}

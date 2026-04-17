// prospect_scanner agent — Claude + web_search, finds key people at an
// account with timing/intent signals. ~30-90s latency. Fire-and-forget
// from the Discover "Scan" button.

import Anthropic from '@anthropic-ai/sdk';
import { PROSPECT_SCANNER_PROMPT } from '../prompts/prospect_scanner.js';

const client = new Anthropic();

const VALID_ROLE_FITS = new Set([
  'economic_buyer', 'technical_evaluator', 'champion', 'end_user', 'advocate',
]);
const VALID_STRENGTHS = new Set(['hot', 'warm', 'cool']);

export async function scanProspects(account) {
  const userContent = `Account to scan:
${JSON.stringify({
  account_name: account.account_name,
  domain: account.domain || null,
  industry: account.industry || null,
  status: account.status,
  notes: account.notes || null,
  buyer_timing: account.buyer_timing || null,
  sales_perf_topics: account.sales_perf_topics || null,
}, null, 2)}

Find key prospects with timing + intent signals. Return the JSON.`;

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: PROSPECT_SCANNER_PROMPT,
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

  const prospects = (Array.isArray(parsed.prospects) ? parsed.prospects : [])
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const name = asStr(p.name);
      const title = asStr(p.title);
      if (!name || !title) return null;
      const sourceUrl = asStr(p.source_url);
      if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;
      return {
        name,
        title,
        role_fit: VALID_ROLE_FITS.has(p.role_fit) ? p.role_fit : 'advocate',
        timing_signal: asStr(p.timing_signal),
        intent_signal: asStr(p.intent_signal),
        source_url: sourceUrl,
        source: asStr(p.source) || 'Web',
      };
    })
    .filter(Boolean)
    .slice(0, 7);

  const result = {
    prospects,
    timing_summary: asStr(parsed.timing_summary),
    opportunity_strength: VALID_STRENGTHS.has(parsed.opportunity_strength)
      ? parsed.opportunity_strength : 'cool',
    opportunity_thesis: asStr(parsed.opportunity_thesis),
    searches,
  };

  return { result, searches, elapsed_ms, error: null, raw: text };
}

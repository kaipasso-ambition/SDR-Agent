// prospect_scanner agent — Claude + web_search, finds 2-3 people AT a
// specific account who have recently said or done something signaling
// buying intent for sales performance / coaching. NOT a directory
// lookup — every person must have a real signal attached. ~30-90s.

import Anthropic from '@anthropic-ai/sdk';
import { PROSPECT_SCANNER_PROMPT } from '../prompts/prospect_scanner.js';

const client = new Anthropic();

const VALID_SIGNAL_TYPES = new Set([
  'linkedin_post', 'press_quote', 'conference', 'job_posting',
  'podcast', 'blog', 'other',
]);
const VALID_STRENGTHS = new Set(['hot', 'warm', 'cool']);

export async function scanProspects(account) {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const cutoff = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const userContent = `Today's date: ${todayIso}
Recency cutoff: ${cutoff} (only return people whose signal is dated ON OR AFTER this date)

Account to scan — ONLY find people who work at THIS company:
${JSON.stringify({
  account_name: account.account_name,
  domain: account.domain || null,
  industry: account.industry || null,
  status: account.status,
  notes: account.notes || null,
  buyer_timing: account.buyer_timing || null,
  sales_perf_topics: account.sales_perf_topics || null,
}, null, 2)}

Find 2-3 people AT ${account.account_name} whose recent signal falls within the window above. Every prospect MUST include signal_date_iso in YYYY-MM-DD format on or after ${cutoff}. Drop any person whose signal is older. Return the JSON.`;

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
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
  const parseIsoDate = (v) => {
    const s = asStr(v);
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return Number.isFinite(d.getTime()) ? d : null;
  };
  const cutoffMs = today.getTime() - 60 * 24 * 60 * 60 * 1000;

  let droppedStale = 0;
  const prospects = (Array.isArray(parsed.prospects) ? parsed.prospects : [])
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const name = asStr(p.name);
      const title = asStr(p.title);
      const signal = asStr(p.signal);
      if (!name || !title || !signal) return null;
      const sourceUrl = asStr(p.source_url);
      if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;

      // Server-side recency guardrail: require signal_date_iso in window.
      const iso = parseIsoDate(p.signal_date_iso);
      if (!iso || iso.getTime() < cutoffMs) {
        droppedStale++;
        return null;
      }

      return {
        name,
        title,
        signal,
        signal_type: VALID_SIGNAL_TYPES.has(p.signal_type) ? p.signal_type : 'other',
        signal_date: asStr(p.signal_date) || iso.toISOString().slice(0, 10),
        signal_date_iso: iso.toISOString().slice(0, 10),
        why_it_matters: asStr(p.why_it_matters),
        source_url: sourceUrl,
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  if (droppedStale > 0) {
    console.log(`[prospect_scanner] ${account.account_name}: dropped ${droppedStale} stale/undated prospect(s)`);
  }

  const result = {
    prospects,
    opportunity_thesis: asStr(parsed.opportunity_thesis),
    opportunity_strength: VALID_STRENGTHS.has(parsed.opportunity_strength)
      ? parsed.opportunity_strength : 'cool',
    searches,
  };

  return { result, searches, elapsed_ms, error: null, raw: text };
}

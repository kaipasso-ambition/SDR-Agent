import Anthropic from '@anthropic-ai/sdk';
import { DISCOVERY_PROMPT } from '../prompts/discovery.js';
import { query } from '../db/index.js';

const client = new Anthropic();

/**
 * Use Claude + web_search to discover net-new ICP candidates with fresh
 * timing signals. Returns { candidates, diagnostics } where diagnostics
 * captures everything useful for debugging (stop_reason, raw text preview,
 * pre-filter and post-filter counts, drop reasons).
 */
export async function discoverCandidates({ count = 5, hint = '' } = {}) {
  // Pull the domains we already have so Claude doesn't duplicate.
  const { rows } = await query(
    `SELECT DISTINCT domain FROM prospects WHERE domain IS NOT NULL`
  );
  const excludeDomains = rows.map((r) => r.domain).join(', ') || 'none yet';

  const system = DISCOVERY_PROMPT
    .replace('{{EXCLUDE_DOMAINS}}', excludeDomains)
    .replace('{{COUNT}}', String(count));

  const userContent = hint
    ? `Find ${count} net-new ICP candidates. Operator hint: ${hint}`
    : `Find ${count} net-new ICP candidates, spread across industries. Lead with recency and signal credibility.`;

  console.log(`[discovery] calling Claude with web_search, count=${count}, excluding ${rows.length} existing domains`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    // Web search + 5 candidate objects + reasoning eats a lot of tokens.
    // Prior 4000 cap was likely truncating mid-JSON.
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: userContent }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }, {
    // Hard cap so a misbehaving web_search chain can't hang a run for 10+ min.
    timeout: 4 * 60 * 1000,
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const searchCount = response.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;

  const diagnostics = {
    stop_reason: response.stop_reason,
    text_length: text.length,
    text_preview: text.slice(0, 1200),
    web_searches_made: searchCount,
    input_tokens: response.usage?.input_tokens,
    output_tokens: response.usage?.output_tokens,
    excluded_domain_count: rows.length,
  };

  console.log(`[discovery] Claude returned: stop_reason=${response.stop_reason}, searches=${searchCount}, text_len=${text.length}, in_tok=${response.usage?.input_tokens}, out_tok=${response.usage?.output_tokens}`);

  if (!text) {
    diagnostics.error = 'Claude returned no text content';
    console.error('[discovery] EMPTY TEXT RESPONSE. Content block types:',
      response.content.map((b) => b.type).join(', '));
    return { candidates: [], diagnostics };
  }

  const jsonText = extractJsonBlock(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    diagnostics.error = `JSON parse failed: ${err.message}`;
    diagnostics.json_attempt = jsonText.slice(0, 800);
    console.error(`[discovery] JSON parse failed. stop_reason=${response.stop_reason}. First 400 chars of attempted JSON: ${jsonText.slice(0, 400)}`);
    // Don't throw — return diagnostics so the UI shows what happened.
    return { candidates: [], diagnostics };
  }

  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  diagnostics.raw_candidate_count = rawCandidates.length;
  diagnostics.raw_candidates = rawCandidates.map((c) => ({
    company: c.company,
    domain: c.domain,
    industry: c.industry,
    signal_type: c.signal_type,
    signal_date: c.signal_date,
    source_url: c.source_url,
    total: c.estimated_total_headcount,
    sales: c.estimated_sales_headcount,
  }));

  console.log(`[discovery] parsed ${rawCandidates.length} raw candidates:`,
    rawCandidates.map((c) => `${c.company} [total=${c.estimated_total_headcount} sales=${c.estimated_sales_headcount}]`).join('; '));

  // Circuit breaker: require Claude to actually search. Prompt asks for
  // 4-8 searches; we accept down to 3 as a floor. Fewer searches than
  // that means candidates are mostly training-data recall with thin
  // verification — drop the run rather than pass bad data downstream.
  const MIN_SEARCHES = Math.min(count, 3);
  if (rawCandidates.length > 0 && searchCount < MIN_SEARCHES) {
    diagnostics.error = `Claude made only ${searchCount} web_search call(s), below the minimum of ${MIN_SEARCHES}. Candidates would be largely memorized, not verified. Run rejected.`;
    console.error(`[discovery] REJECTED run: ${searchCount} searches < ${MIN_SEARCHES} minimum — signals likely not grounded`);
    return { candidates: [], diagnostics };
  }

  // Belt-and-suspenders size filter. Record drops so the UI explains them.
  const drops = [];
  const kept = rawCandidates.filter((c) => {
    const reasons = [];
    if (!c.domain) reasons.push('no domain returned');
    if (!meetsFloor(c.estimated_total_headcount, 250)) reasons.push(`total ${c.estimated_total_headcount} <250`);
    if (!meetsFloor(c.estimated_sales_headcount, 30)) reasons.push(`sales ${c.estimated_sales_headcount} <30`);
    if (reasons.length) {
      drops.push({ company: c.company, reason: reasons.join(', ') });
      return false;
    }
    return true;
  });
  diagnostics.size_filter_drops = drops;

  if (drops.length) {
    console.log('[discovery] size-filter drops:', drops.map((d) => `${d.company} (${d.reason})`).join('; '));
  }

  return { candidates: kept, diagnostics };
}

// Pull the first top-level JSON object out of a response that may have prose
// before/after it or be wrapped in code fences. If Claude put the JSON in a
// fenced block, prefer that — it's less likely to be a partial/truncated one.
function extractJsonBlock(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) return brace[0];
  return text;
}

// Parse strings like "400–600", "1000+", "~500", "50+", "unknown" and return
// true if the lower bound clears the floor. Returns true for unknown/missing
// — we let the researcher make the call rather than drop on ambiguity here.
function meetsFloor(estimate, floor) {
  if (!estimate) return true;
  const s = String(estimate).toLowerCase();
  if (s.includes('unknown')) return true;
  const nums = s.match(/\d[\d,]*/g);
  if (!nums || nums.length === 0) return true;
  const low = parseInt(nums[0].replace(/,/g, ''), 10);
  return !Number.isFinite(low) || low >= floor;
}

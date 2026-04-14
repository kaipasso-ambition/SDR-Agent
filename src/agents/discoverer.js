import Anthropic from '@anthropic-ai/sdk';
import { DISCOVERY_PROMPT } from '../prompts/discovery.js';
import { query } from '../db/index.js';

const client = new Anthropic();

/**
 * Use Claude + web_search to discover net-new ICP candidates with fresh
 * timing signals. Returns [{ company, domain, industry, signal, source_url, ... }].
 * Already-pipelined domains are passed in so Claude doesn't re-surface them.
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: userContent }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const jsonText = extractJsonBlock(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    // Include the raw text in the error so it shows up in Railway logs and
    // the failure banner — otherwise we just get "Unexpected token" which
    // tells us nothing about what Claude actually returned.
    const preview = text.slice(0, 400).replace(/\s+/g, ' ');
    throw new Error(`Discovery JSON parse failed. First 400 chars of Claude's response: ${preview}`);
  }
  return Array.isArray(parsed.candidates) ? parsed.candidates : [];
}

// Pull the first top-level JSON object out of a response that may have prose
// before/after it or be wrapped in code fences.
function extractJsonBlock(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) return brace[0];
  return text;
}

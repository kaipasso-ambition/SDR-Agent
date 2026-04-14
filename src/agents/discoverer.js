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

  const jsonText = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed.candidates) ? parsed.candidates : [];
}

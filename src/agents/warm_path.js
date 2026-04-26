import Anthropic from '@anthropic-ai/sdk';
import { WARM_PATH_PROMPT } from '../prompts/warm_path.js';
import { callWithRetry } from '../lib/api_retry.js';

const client = new Anthropic();

export async function findWarmPath({ account, targetName, targetTitle, targetSignal }) {
  const userContent = `Company: ${account.account_name}
Domain: ${account.domain || 'unknown'}
Industry: ${account.industry || 'unknown'}
AE notes: ${account.notes || 'none'}

TARGET PERSON (too senior for cold outreach):
  Name: ${targetName}
  Title: ${targetTitle}
  Signal: ${targetSignal}

Find 2-3 people who report to or work closely with ${targetName} at ${account.account_name}. For each, write a message angle that connects to ${targetName}'s priorities. Return JSON.`;

  const t0 = Date.now();
  const response = await callWithRetry(client, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: WARM_PATH_PROMPT,
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

  const stepping_stones = (Array.isArray(parsed.stepping_stones) ? parsed.stepping_stones : [])
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const name = asStr(s.name);
      const title = asStr(s.title);
      const relationship = asStr(s.relationship);
      const message_angle = asStr(s.message_angle);
      if (!name || !title || !message_angle) return null;
      return {
        name,
        title,
        relationship,
        message_angle,
        source_url: asStr(s.source_url),
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  return {
    result: {
      stepping_stones,
      approach_summary: asStr(parsed.approach_summary),
    },
    searches,
    elapsed_ms,
    error: null,
    raw: text,
  };
}

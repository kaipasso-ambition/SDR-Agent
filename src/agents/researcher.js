import Anthropic from '@anthropic-ai/sdk';
import { RESEARCH_PROMPT } from '../prompts/research.js';
import { getPendingAccounts } from '../integrations/salesforce.js';
import { getIntentSignals } from '../integrations/commonroom.js';
import { upsertProspect } from '../db/prospects.js';

const client = new Anthropic();

export async function runResearchCycle() {
  const accounts = await getPendingAccounts();
  const signals = await getIntentSignals();

  for (const account of accounts) {
    try {
      const enriched = await enrichProspect(account, signals);
      await upsertProspect(enriched);

      if (enriched.disqualified) {
        console.log(`[researcher] Disqualified: ${account.company} — ${enriched.disqualify_reason}`);
        continue;
      }

      console.log(
        `[researcher] Scored ${account.company}: ${enriched.fit_score} — ${enriched.timing_signal}`
      );
    } catch (err) {
      console.error(`[researcher] Error on ${account.company}:`, err.message);
    }
  }
}

// Enrich a single account using Claude + web search. Exported so the
// on-demand pipeline (triggered from the web UI) can call it one prospect
// at a time without pulling from Salesforce.
export async function enrichProspect(account, allSignals = []) {
  const signal = allSignals.find((s) => s.domain === account.domain) || null;

  const userContent = `
Account data:
${JSON.stringify(account, null, 2)}

CommonRoom signals (optional — may be empty):
${signal ? JSON.stringify(signal, null, 2) : 'No signals found — rely on web_search.'}
  `.trim();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    // Was 2000 — web_search tool use + reasoning + JSON response can blow
    // past that and truncate. 4000 gives enough headroom.
    max_tokens: 4000,
    system: RESEARCH_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const searchCount = response.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;

  console.log(`[researcher] ${account.company}: stop=${response.stop_reason}, searches=${searchCount}, out_tok=${response.usage?.output_tokens}`);

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const preview = text.slice(0, 400).replace(/\s+/g, ' ');
    throw new Error(`Researcher JSON parse failed for ${account.company}. First 400 chars: ${preview}`);
  }

  // Circuit breaker: if zero web_search calls, disqualify with a clear reason
  // rather than passing through hallucinated research.
  if (searchCount === 0) {
    console.warn(`[researcher] ${account.company}: zero web_searches — disqualifying as unverified`);
    parsed.disqualified = true;
    parsed.disqualify_reason = 'researcher did not call web_search — data would be from training memory, not current web';
    parsed.fit_score = Math.min(parsed.fit_score ?? 0, 40);
  }
  return parsed;
}

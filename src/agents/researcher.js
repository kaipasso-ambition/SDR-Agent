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
    max_tokens: 2000,
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

  // Claude sometimes wraps JSON in ```json fences — strip them.
  const jsonText = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  return JSON.parse(jsonText);
}

// fiscal_lookup — lightweight Haiku call to look up a company's fiscal
// year end month. No web_search (FY data is in training for most
// companies). ~1-2s, synchronous, costs ~$0.001.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export async function lookupFiscalYear(account) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `What month does "${account.account_name}"${account.domain ? ` (${account.domain})` : ''}${account.industry ? `, industry: ${account.industry}` : ''} end their fiscal year? Most companies use calendar year (December). If you know this company uses a non-standard fiscal year, return that month. If unsure, return December as the default.

Return ONLY a JSON object: {"month": 1-12, "confidence": "known"|"default"}
No other text.`,
    }],
  }, { timeout: 10_000 });

  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { month: null, confidence: null };

  try {
    const parsed = JSON.parse(match[0]);
    const m = parseInt(parsed.month, 10);
    if (m >= 1 && m <= 12) return { month: m, confidence: parsed.confidence || 'default' };
  } catch {}
  return { month: null, confidence: null };
}

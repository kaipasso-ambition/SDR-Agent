// fiscal_lookup — lightweight Haiku call to look up a company's fiscal
// year end AND budget planning cycle. No web_search (FY + budget
// cadence data is in training for most companies). ~1-2s, synchronous,
// costs ~$0.001.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export async function lookupFiscalYear(account) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `For "${account.account_name}"${account.domain ? ` (${account.domain})` : ''}${account.industry ? `, industry: ${account.industry}` : ''}:

1. What month does their fiscal year end? Most companies use calendar year (December). If you know this company uses a non-standard FY, return that.
2. When does budget planning typically start at this company (or in this industry if company-specific isn't known)? Budget planning usually starts 3-5 months before FY end. Return the month number.
3. Write a one-line budget timing note for a sales rep — when to be in the mix.

Return ONLY a JSON object:
{"fy_end_month": 1-12, "budget_start_month": 1-12, "budget_timing_note": "one line", "confidence": "known"|"inferred"}
No other text.`,
    }],
  }, { timeout: 10_000 });

  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { month: null, budgetStartMonth: null, budgetNote: null, confidence: null };

  try {
    const parsed = JSON.parse(match[0]);
    const fy = parseInt(parsed.fy_end_month, 10);
    const bs = parseInt(parsed.budget_start_month, 10);
    return {
      month: (fy >= 1 && fy <= 12) ? fy : null,
      budgetStartMonth: (bs >= 1 && bs <= 12) ? bs : null,
      budgetNote: (typeof parsed.budget_timing_note === 'string' && parsed.budget_timing_note.trim())
        ? parsed.budget_timing_note.trim() : null,
      confidence: parsed.confidence || 'inferred',
    };
  } catch {}
  return { month: null, budgetStartMonth: null, budgetNote: null, confidence: null };
}

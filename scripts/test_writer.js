// Smoke test: send a fake prospect to Claude using the real OUTREACH_PROMPT
// and print the generated 3-touch sequence. Useful for verifying the API key,
// the prompt, and JSON output without needing Salesforce/Gmail wired up.
//
// Usage: node scripts/test_writer.js

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { OUTREACH_PROMPT } from '../src/prompts/outreach.js';

const FAKE_PROSPECT = {
  prospect_id: 'test-001',
  company: 'Northbound Logistics',
  domain: 'northboundlogistics.com',
  contact_name: 'Sarah Chen',
  contact_title: 'VP of Sales Operations',
  contact_email: 'sarah.chen@northboundlogistics.com',
  industry: 'logistics',
  persona: 'salesops',
  seniority: 'vp_plus',
  customer_status: 'prospect',
  sales_headcount_estimate: '120-150',
  timing_signal: 'Hiring 8 branch managers across the Midwest in the last 30 days',
  timing_signal_source: 'linkedin',
  additional_context:
    'Mid-sized freight broker, 14 branches, recently announced a new TMS rollout. CRO mentioned "manager visibility" as a 2026 priority on the Q4 earnings call.',
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_key_here') {
    console.error(
      'ERROR: ANTHROPIC_API_KEY is not set in .env. Open .env, paste your sk-ant-... key, save, then re-run.'
    );
    process.exit(1);
  }

  const client = new Anthropic();

  console.log('--- Fake prospect ---');
  console.log(JSON.stringify(FAKE_PROSPECT, null, 2));
  console.log('\n--- Calling Claude (this takes ~5-15 seconds)... ---\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: OUTREACH_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Generate a 3-touch outreach sequence for this prospect:\n\n${JSON.stringify(FAKE_PROSPECT, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('Claude returned non-JSON output:');
    console.error(text);
    process.exit(1);
  }

  console.log('--- Generated sequence ---\n');
  for (const touch of parsed.sequence || []) {
    console.log(`### Touch ${touch.touch} (${touch.channel})`);
    if (touch.subject) console.log(`Subject: ${touch.subject}`);
    console.log('');
    console.log(touch.body);
    console.log('\n---\n');
  }

  console.log('Fit score:', parsed.fit_score);
  if (parsed.fit_rationale) {
    console.log('Persona fit:  ', parsed.fit_rationale.persona_fit);
    console.log('Timing signal:', parsed.fit_rationale.timing_signal);
    console.log('Message angle:', parsed.fit_rationale.message_rationale);
  }

  console.log(
    `\nTokens used: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`
  );
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  if (err.status === 401) {
    console.error('-> 401 Unauthorized. Your ANTHROPIC_API_KEY in .env is invalid or revoked.');
  } else if (err.status === 429) {
    console.error('-> 429 Rate limited or out of credit. Check console.anthropic.com/settings/billing.');
  }
  process.exit(1);
});

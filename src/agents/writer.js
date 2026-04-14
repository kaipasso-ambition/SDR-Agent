import Anthropic from '@anthropic-ai/sdk';
import { OUTREACH_PROMPT } from '../prompts/outreach.js';
import { getScoredProspects } from '../db/prospects.js';
import { addToApprovalQueue } from '../queue/approval_queue.js';

const client = new Anthropic();

export async function runWriterCycle() {
  const prospects = await getScoredProspects({ minScore: 50, notQueued: true });

  for (const prospect of prospects) {
    try {
      const draft = await generateSequence(prospect);
      await addToApprovalQueue({
        prospect,
        draft,
        status: 'pending',
        queued_at: new Date().toISOString(),
      });
      console.log(
        `[writer] Drafted sequence for ${prospect.company} — ${prospect.persona}`
      );
    } catch (err) {
      console.error(`[writer] Error for ${prospect.company}:`, err.message);
    }
  }
}

export async function generateSequence(prospect) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: OUTREACH_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Generate a 3-touch outreach sequence for this prospect:\n\n${JSON.stringify(prospect, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return JSON.parse(text);
}

import Anthropic from '@anthropic-ai/sdk';
import { REPLY_HANDLER_PROMPT } from '../prompts/reply_handler.js';
import { getUnprocessedReplies } from '../integrations/gmail.js';
import { updateSequenceStatus } from '../queue/sequence_tracker.js';
import { addToReplyQueue } from '../queue/approval_queue.js';

const client = new Anthropic();

export async function runReplyCycle() {
  const replies = await getUnprocessedReplies();

  for (const reply of replies) {
    try {
      const result = await classifyAndDraft(reply);

      // Auto-handle safe cases
      if (result.classification === 'ooo') {
        await updateSequenceStatus(reply.prospect_id, 'paused', result.follow_up_date);
        console.log(
          `[reply] OOO for ${reply.prospect_id} — rescheduled to ${result.follow_up_date}`
        );
        continue;
      }

      if (result.classification === 'not_interested') {
        await updateSequenceStatus(reply.prospect_id, 'closed');
        console.log(`[reply] Closed sequence for ${reply.prospect_id}`);
        continue;
      }

      // Everything else goes to human approval queue
      await addToReplyQueue({
        prospect_id: reply.prospect_id,
        original_reply: reply.body,
        classification: result.classification,
        draft_response: result.reply_to_original_sender,
        referral_draft: result.referral_outreach,
        escalate: result.sequence_status === 'escalate_to_human',
        escalate_reason: result.escalate_reason,
        notes: result.notes,
        queued_at: new Date().toISOString(),
      });

      console.log(
        `[reply] Queued reply draft for ${reply.prospect_id} — ${result.classification}`
      );
    } catch (err) {
      console.error(`[reply] Error for ${reply.prospect_id}:`, err.message);
    }
  }
}

async function classifyAndDraft(reply) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: REPLY_HANDLER_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Prospect reply to classify and respond to:\n\n${JSON.stringify(reply, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return JSON.parse(text);
}

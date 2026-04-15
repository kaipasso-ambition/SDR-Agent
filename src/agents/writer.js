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

export async function generateSequence(prospect, campaign = null, freshTrigger = null) {
  // freshTrigger is an optional signal context block produced by the
  // "Draft outbound" CTA on /signals/:id/stage. We inject it before the
  // prospect payload so the writer leads Touch 1 with the fresh trigger
  // and the Ambition 2.0 lexicon from the system prompt.
  const freshTriggerBlock = freshTrigger
    ? `FRESH TRIGGER — the AE is reaching out BECAUSE of this specific signal. Touch 1 must reference the trigger in its first or second sentence. Do not quote it verbatim — summarize the observation in one clause, then drop into the GTM-problem framing.

Title: ${freshTrigger.title || ''}
Why this matters (so_what): ${freshTrigger.so_what || ''}
Recommended move the AE is acting on: ${freshTrigger.recommended_move || ''}
Source: ${freshTrigger.source_url || '(none)'}

`
    : '';

  let userContent;
  if (campaign) {
    const includeInvite = !!campaign.special_invite_for_this_prospect;
    userContent = `CAMPAIGN CONTEXT — this sequence is part of a campaign, not a generic cold outreach. Your CTA must serve the campaign goal.

Campaign name: ${campaign.name}
Goal: ${campaign.goal || '(none specified)'}
Description: ${campaign.description || '(none)'}
${campaign.event_date ? `Event date: ${new Date(campaign.event_date).toDateString()}` : ''}
${campaign.event_url ? `Event URL: ${campaign.event_url}` : ''}

WRITING INSTRUCTIONS FOR THIS CAMPAIGN:
- Touch 1 must lead with the campaign CTA (e.g., "will you be at X event?"), not the generic Ambition problem pitch.
- Touch 2 follows up on Touch 1 — add a small new angle or value prop.
- Touch 3 is the final nudge, typically LinkedIn.
- All Ambition voice rules still apply: ≤75 words per touch, industry-native vocabulary, no banned phrases, no fake urgency.
${includeInvite ? `
SPECIAL INVITE — this prospect has been hand-selected for an exclusive offer:
${campaign.special_invite_description}
Weave this invite naturally into Touch 1 or Touch 2. Frame it as selective and genuine — NOT as a mass broadcast. Do NOT use words like "exclusive" or "limited-time" — instead, describe concretely why it's small/selective (e.g., "a small dinner with a handful of sales leaders," "a 30-person session").` : `
NO special invite for this prospect. Do NOT mention the CEO talk, dinner, or any add-on offer. Keep the sequence to the campaign CTA only.`}

PROSPECT:
${JSON.stringify(prospect, null, 2)}`;
  } else {
    userContent = `${freshTriggerBlock}Generate a 3-touch outreach sequence for this prospect:\n\n${JSON.stringify(prospect, null, 2)}`;
  }

  if (campaign && freshTriggerBlock) {
    userContent = freshTriggerBlock + userContent;
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: OUTREACH_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(jsonText);
}

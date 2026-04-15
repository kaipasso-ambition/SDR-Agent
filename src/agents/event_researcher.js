// Event researcher — one-shot Claude+web_search over an AE-supplied
// event (name + reference URLs + optional speaking-slot note) that
// produces the structured context payload the play_builder consumes.
//
// Called fire-and-forget from POST /events (auto) and POST
// /events/:id/research (manual rebuild). Writes the `research_status`
// column so the UI can show "pending → completed/failed" without
// polling the agent directly.

import Anthropic from '@anthropic-ai/sdk';
import { EVENT_RESEARCH_PROMPT } from '../prompts/event_research.js';
import { getEventById, setResearchStatus, completeResearch } from '../db/play_events.js';

const client = new Anthropic();

// One Claude call. Returns the parsed context object or throws.
export async function researchEvent(event, { speaking_note = null } = {}) {
  const payload = {
    event: {
      name: event.name,
      kind: event.kind,
      event_date: event.event_date,
      location: event.location,
      description: event.description || null,
    },
    reference_links: Array.isArray(event.reference_links) ? event.reference_links : [],
    speaking_note: speaking_note || null,
  };

  const response = await client.messages.create(
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: EVENT_RESEARCH_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    },
    { timeout: 5 * 60 * 1000 }
  );

  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const searchCount = response.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;

  if (searchCount === 0) {
    throw new Error('event_researcher returned 0 web_searches — refusing to persist');
  }

  // Permissive JSON extraction — fenced block, first {...}, or raw.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);
  const parsed = JSON.parse(jsonText);
  return { context: parsed, searches: searchCount };
}

// Wrapper that handles the DB lifecycle. Call this from the route.
// The caller can await or fire-and-forget; we always flip research_status
// to completed/failed so the UI knows when to stop showing a spinner.
export async function runEventResearch(eventId, { speaking_note = null } = {}) {
  const event = await getEventById(eventId);
  if (!event) return;

  await setResearchStatus(eventId, 'pending');
  try {
    const { context, searches } = await researchEvent(event, { speaking_note });
    // If the model surfaced an Ambition speaking slot, mirror it onto
    // the dedicated column so the composer's "personal invite" picker
    // has a clean place to read from without digging into context.
    if (context?.ambition_speaking_slot) {
      const slot = context.ambition_speaking_slot;
      // Only promote it if we got at least a speaker or a title — guard
      // against the model hallucinating an empty slot.
      if (slot.speaker || slot.title) {
        const { updateEvent } = await import('../db/play_events.js');
        await updateEvent(eventId, { personal_invite_session: slot });
      }
    }
    await completeResearch(eventId, context);
    console.log(`[event_researcher] ${event.name} → ok (searches=${searches})`);
  } catch (err) {
    console.error(`[event_researcher] ${event.name} failed:`, err.message);
    await setResearchStatus(eventId, 'failed', err.message).catch(() => {});
  }
}

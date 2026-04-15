// Event-outreach writer. Synchronous Claude calls — no web_search —
// that generate short, pasteable drafts for an attendee at an event.
// Two flavors: session_invite (speaker-voice invite to the limited-seat
// session) and meeting_request (AE-voice ask for 20 min at the event).

import Anthropic from '@anthropic-ai/sdk';
import { SESSION_INVITE_PROMPT, MEETING_REQUEST_PROMPT } from '../prompts/event_outreach.js';

const client = new Anthropic();

async function runDraft(systemPrompt, payload) {
  const response = await client.messages.create(
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    },
    { timeout: 60 * 1000 }
  );
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

export async function draftSessionInvite({ event, attendee, ae }) {
  const slot = event?.personal_invite_session || event?.context?.ambition_speaking_slot || null;
  if (!slot || !(slot.speaker || slot.title)) {
    throw new Error('No personal_invite_session on this event — add a speaker/session first.');
  }
  if (!ae || !ae.name) {
    throw new Error('Cannot draft an invite without a signed-in sender — AE identity is required.');
  }
  const payload = {
    event: {
      name: event.name,
      date: event.event_date,
      location: event.location,
      theme: event.context?.theme || null,
    },
    speaker: {
      name: slot.speaker || 'our CEO',
      title: slot.speaker_title || 'our CEO',
      session_title: slot.title || null,
      session_time: slot.session_time || null,
      seat_cap_note: slot.seat_cap_note || 'very limited seating',
    },
    target: {
      name: attendee.name,
      title: attendee.title,
      company: attendee.company,
      matched_account_status: attendee.matched_account_status || null,
      account_context: attendee.account_context || null,
    },
    research_context: event.context
      ? {
          themes_and_tracks: event.context.themes_and_tracks,
          angles_for_ambition: event.context.angles_for_ambition,
        }
      : null,
    ae: { name: ae.name, email: ae.email || null },
  };
  return runDraft(SESSION_INVITE_PROMPT, payload);
}

export async function draftMeetingRequest({ event, attendee, ae }) {
  const payload = {
    event: {
      name: event.name,
      date: event.event_date,
      location: event.location,
      theme: event.context?.theme || null,
    },
    target: {
      name: attendee.name,
      title: attendee.title,
      company: attendee.company,
      matched_account_status: attendee.matched_account_status || null,
      account_context: attendee.account_context || null,
    },
    research_context: event.context
      ? {
          themes_and_tracks: event.context.themes_and_tracks,
          angles_for_ambition: event.context.angles_for_ambition,
        }
      : null,
    ae: ae ? { name: ae.name, email: ae.email } : null,
  };
  return runDraft(MEETING_REQUEST_PROMPT, payload);
}

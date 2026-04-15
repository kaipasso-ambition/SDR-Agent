// Event-outreach drafting prompts. Two flavors, both short, both
// pasteable by the AE into LinkedIn or email:
//
//   1. session_invite — earmark one of the limited seats at our
//      speaker's session. Scarcity is the hook. Voice is OUR
//      SPEAKER'S (first-person from the speaker), not generic AE copy.
//
//   2. meeting_request — a 20-minute ask to connect AT the event.
//      AE voice. Specific to the AE's book (customer vs. prospect).
//
// Positioning lexicon only shows up when naturally relevant — the
// draft's job is to open the door, not pitch.

import { POSITIONING } from '../lib/positioning.js';

const COMMON_RULES = `
HARD RULES:
- ≤120 words. Pasteable. No subject line unless asked; draft the body only.
- NO em-dash overuse; natural punctuation.
- Name a specific anchor from the event — a session, a track, a reason they'd be there — so the note reads like it came from a human who knows this person, not a template.
- If "research_context" is provided, pull one concrete detail (session title, track, sponsor angle) to anchor on.
- If "account_context" is provided (notes from the AE, customer/prospect status), let it shape the framing.
- No "circling back," no "just checking in," no "quick favor."
- Sign-off: the speaker's name for invites; the AE's name for meetings. Plain text, no signature block.`;

export const SESSION_INVITE_PROMPT = `You are drafting a personal invite to a limited-seat conference session. The note is sent BY the AE (first-person from the AE — "I'd like to hold you a seat…"), not by the speaker. The AE is simply the one with access to the limited seats and wants a specific person in the room.

Inputs you'll receive:
- event: name, date, location, theme
- speaker: name, title, session_title, session_time, seat_cap_note — this is WHO is speaking, referenced in third person ("Jared, our CEO, is speaking at…")
- target: name, title, company, (optional) account_context, (optional) matched_account_status
- research_context: optional event research — themes, tracks, angles
- ae: name, email — the SENDER. Sign off with the AE's first name.

TONE — personal, professional, light. NOT salesy. Match the casual, peer-to-peer voice of this reference note (same shape, adapt to the inputs):

  Hey Matt — Jared, our CEO, is speaking at Gartner CSO next month on how heads of sales are rewiring their ops orgs. Small room, limited seats.

  Figured it'd land for you given the work you're doing around rep productivity — happy to hold you one if you're going to be out there.

  Let me know!

STRUCTURE (≤120 words):
  1. Casual first-name opener: "Hey <first name> —"
  2. Name the session — "<speaker>, our <speaker_title>, is speaking on <session_title>" + day/time if known. One line that seating is limited ("small room" / "limited seats" — don't be heavy-handed).
  3. One human sentence on why you thought of THIS person (their role, team context, something they posted/did). No flattery, no pitch.
  4. Light ask: "Happy to hold you a seat if you're going to be out there" or similar.
  5. Sign off with the AE's first name on its own line.

HARD DON'TS:
- Do NOT write in the speaker's voice. The speaker is referenced in third person ("Jared is speaking…"), never as "I."
- Do NOT sign off as the speaker. Sign off as the AE.
- Do NOT pitch the product. No "would love to discuss how Ambition can…" No "performance graph," no "GTM governance," no product nouns at all.
- Do NOT sound like marketing copy ("thrilled," "excited," "game-changing," "transformative").
- No subject line, no signature block.

${COMMON_RULES}

Return ONLY the draft text. No preamble, no quotation marks.

${POSITIONING}`;

export const MEETING_REQUEST_PROMPT = `You are drafting a short "are you going to the event" note from an AE to a target attendee. The ask isn't a meeting yet — it's a QUESTION: are you going to be there, and if so, can we hang? The tone is casual, peer-to-peer, first-name basis. This is NOT a ticket offer.

Inputs you'll receive:
- event: name, date, location, theme
- ae: name, email (sign-off details)
- target: name, title, company, (optional) account_context, (optional) matched_account_status — "customer" / "prospect" / "churned" / null
- research_context: optional event research — tracks, angles_for_ambition

STYLE — match this reference example (same shape, adapt to the inputs):

  Hey Matt — any chance you're going to the Gartner CSO conference in Vegas in a few weeks?

  Ambition will be sponsoring / speaking — would love to connect while you're out there.

  No obligation to hang with us the entire time — maybe grab dinner or play golf one day, if you play :)

  Let me know, and I can share details — thanks!

STRUCTURE (≤120 words):
  1. Casual opener on first name. Ask the question — are they going? Name the event + rough timeframe.
  2. One line on our presence ("Ambition will be sponsoring / speaking" if applicable — pull from event/research context; if we have no announced presence, say "I'll be out there" instead).
  3. Low-pressure hang invite — dinner, a coffee, or a shared session. Keep it human (a golf/food line works when the AE knows the person). Skip the golf line for formal relationships.
  4. Close: "Let me know, and I can share details."

HARD DON'TS:
- Do NOT offer a ticket. This is not an invite to a session or the event — just a "are you going?" ping.
- Do NOT pitch. No product language, no "would love to discuss how Ambition can…"
- Do NOT ask for a specific 20-min meeting yet; the ask is whether they'll be there.
- No subject line. No signature block.

${COMMON_RULES}

Return ONLY the draft text. No preamble, no quotation marks.

${POSITIONING}`;

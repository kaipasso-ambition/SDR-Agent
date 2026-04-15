// Seed the Gartner CSO Summit 2026 event with a reference link and the
// "our CEO is speaking, limited seats" speaking note, then kick off a
// research run so the event page hydrates with sessions, audience
// profile, and the angles we can pull on.
//
// Usage:
//   DATABASE_URL="postgres://..." ANTHROPIC_API_KEY="sk-..." \
//     node scripts/seed_gartner_event.js
//
// Idempotent: if a play_events row already exists with this name we
// update its reference_links + rerun research instead of duplicating.

import 'dotenv/config';
import { pool, query } from '../src/db/index.js';
import { createEvent, updateEvent, setResearchStatus } from '../src/db/play_events.js';
import { runEventResearch } from '../src/agents/event_researcher.js';

const NAME = 'Gartner CSO & Sales Leader Conference 2026';
const KIND = 'event';
const REFERENCE_LINKS = [
  'https://www.gartner.com/en/conferences/na/sales-us/sessions',
];
const SPEAKING_NOTE =
  "Our CEO is speaking at this event. Seating for his session is very limited — we want a way to designate personal invites from him to the right contacts across our book.";

async function main() {
  const existing = await query(
    `SELECT * FROM play_events WHERE name = $1 LIMIT 1`,
    [NAME]
  );

  let event;
  if (existing.rows[0]) {
    event = existing.rows[0];
    console.log(`[seed] found existing event ${event.id} — updating + rerunning research`);
    await updateEvent(event.id, {
      reference_links: REFERENCE_LINKS,
      description: SPEAKING_NOTE,
      status: 'planning',
    });
  } else {
    event = await createEvent({
      name: NAME,
      kind: KIND,
      event_date: null,           // Gartner releases dates late — let research fill in if found
      location: null,
      description: SPEAKING_NOTE, // Doubles as the speaking_note seed for the researcher
      reference_links: REFERENCE_LINKS,
      status: 'planning',
    });
    console.log(`[seed] created event ${event.id}`);
  }

  await setResearchStatus(event.id, 'pending');
  console.log(`[seed] running research for "${NAME}" — this takes 30–90s…`);
  await runEventResearch(event.id, { speaking_note: SPEAKING_NOTE });
  console.log(`[seed] done. Event URL: /events/${event.id}`);

  await pool.end();
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});

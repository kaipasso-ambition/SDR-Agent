// The May 15 Performance Graph launch campaign — the messaging spine that
// every "Draft May 15th intro" click on the accounts page flows through.
//
// Implemented on top of the existing `campaigns` table + generateSequence()
// campaign-context path so we don't fork the outreach engine. This file
// defines the campaign content; find-or-create picks it up on first draft.

import { query } from '../db/index.js';

// Campaign content. Kept in code (not DB) because it's a single launch
// moment + we want edits to move with deploys, not sit behind a form. If
// we run more launches this can migrate to a `launch_campaigns` table.
export const MAY15_LAUNCH = {
  slug: 'may15-performance-graph',
  name: 'May 15 — Performance Graph Launch',
  goal: 'Warm customer intros for the Performance Graph launch + Gartner CSO Summit. Target personas: Frontline Manager (SMB/Commercial/SDR) and RevOps / Ops leaders.',
  description: [
    'LAUNCH: May 15, 2026 — the Performance Graph. A new infrastructure layer that connects Salesforce deal data, Gong conversation data, and coaching methodology frameworks (MEDDPICC, Challenger, Force Management Give-Get) into one unified model of rep + team performance. Designed so frontline managers actually coach against the methodology with live data, instead of stitching three tools and a framework by hand.',
    '',
    'GARTNER CSO SUMMIT — Las Vegas, May 2026. Ambition has a booth. Our CEO is leading a roundtable: "Balancing AI Efficiency & Skill Development — Why Managers Are Your Untapped Advantage." Thesis: revenue teams win by using AI to amplify frontline managers (coaching, performance systems, AI insights), not by replacing them. This is the public thesis behind the Performance Graph launch.',
    '',
    'AUDIENCE FRAMING (hard rules):',
    '- Frontline Manager (SMB/Commercial/SDR segments): the Performance Graph is pitched at you — one coach-ready view across deal, call, and methodology. Do NOT pitch enterprise-tier managers; they are a different motion.',
    '- RevOps / Ops Leader: the Performance Graph ends the pivot-table-and-Slack stitching of Salesforce + Gong + methodology. Adoption-by-managers is the unlock.',
    '',
    'CTA LADDER (strongest → softest):',
    '1. Join the CEO-led Gartner roundtable (attendees only)',
    '2. 15 min at the booth (attendees)',
    '3. Post-event recap ("happy to share the roundtable takeaways")',
    '4. Direct launch intro (for non-attendees)',
    '',
    'DO: reference the Performance Graph by name. Name MEDDPICC/Challenger/Force Management specifically when talking coaching methodology. Reference the Gartner CEO roundtable as the thesis, not as a generic sponsorship.',
    'DON\'T: generic "AI for sales" language. Don\'t over-claim — this is new, the customer is a current user, tone is feedback/input, not pitch.',
  ].join('\n'),
  event_date: '2026-05-15',
  event_url: null,
  // Only set when we have confirmed attendee targets. Keeps the writer
  // from inventing "join us at the booth" CTAs for people who aren't going.
  special_invite_description: 'Small-group dinner with our CEO on the Monday of Gartner CSO Summit — hosted conversation on managers as the untapped advantage with ~15 other revenue leaders attending the conference. Selective because capacity is tight, not because of any mass-invite script.',
  special_invite_capacity: 15,
};

// Find or create the launch campaign, scoped to the owner. Each AE gets
// their own campaign row (the campaigns table is owner-scoped), so their
// drafts land in their own queue — even though the content is identical.
export async function findOrCreateLaunchCampaign(ownerUserId) {
  const existing = await query(
    `SELECT * FROM campaigns
      WHERE name = $1 AND owner_user_id IS NOT DISTINCT FROM $2
      LIMIT 1`,
    [MAY15_LAUNCH.name, ownerUserId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const { rows } = await query(
    `INSERT INTO campaigns
       (name, goal, description, event_date, event_url,
        special_invite_description, special_invite_capacity, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      MAY15_LAUNCH.name,
      MAY15_LAUNCH.goal,
      MAY15_LAUNCH.description,
      MAY15_LAUNCH.event_date,
      MAY15_LAUNCH.event_url,
      MAY15_LAUNCH.special_invite_description,
      MAY15_LAUNCH.special_invite_capacity,
      ownerUserId,
    ]
  );
  return rows[0];
}

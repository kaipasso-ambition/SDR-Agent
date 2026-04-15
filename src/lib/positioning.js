// Ambition 2.0 positioning — single source of truth for lexicon, narrative
// arc, and audience-specific value props. Imported by:
//   - src/prompts/outreach.js (outbound writer)
//   - src/prompts/signal_analysis.js (signal interpreter)
//
// Why this module exists:
// Ambition is evolving from "sales gamification" (foundation) to a GTM
// Governance + Performance Graph platform (present). The risk in any
// generated copy — outbound, signal so_what, recommended moves — is that
// the model reaches for "gamification / contests / leaderboards" as the
// lead. That language was right in 2018. It's wrong now; it sabotages
// renewal and expansion conversations, particularly with CROs and RevOps
// leaders evaluating consolidation.
//
// Rule: factual fields (signal title, signal summary) stay neutral.
// Interpretation fields (so_what, recommended_move, outreach body) USE
// the lexicon below and NEVER lead with the AVOID list.

export const POSITIONING = {
  // Phrases the interpreter should USE when framing so_what and
  // recommended_move. These carry Ambition 2.0's strategic weight.
  use_lexicon: [
    'Performance Graph',
    'GTM Governance',
    'behavioral coaching',
    'automated coaching workflows',
    'executive visibility',
    'strategic command center',
    'consistent excellence',
    'measurable performance',
    'frontline manager layer',
    'unified source of truth',
    'pipeline integrity',
    'coaching at scale',
    'operationalize strategy',
  ],

  // Phrases that are TRUE of Ambition but must NEVER lead a sentence,
  // subject line, or recommended move. They are allowed as secondary
  // context ("built on the foundation of ..."), never as the hook.
  avoid_as_lead: [
    'gamification',
    'contests',
    'leaderboards',
    'scoreboards',
    'TVs on the sales floor',
    'spiffs',
    'motivation software',
  ],

  // The narrative arc — how a strong interpretation should move. Used in
  // few-shot calibration inside the signal-analysis prompt.
  narrative_arc: [
    'Observe a concrete signal (hire, restructure, earnings note, product move).',
    'Name the GTM problem it implies at the manager layer — coaching gap, data fragmentation, consolidation pressure.',
    'Connect that problem to Ambition 2.0 value: Performance Graph unifies the signal; GTM Governance turns it into coaching at scale.',
    'Recommend one next move the AE can take this week that earns the right to the conversation — never a product demo ask up front.',
  ],

  // Audience split — different personas need different lead values. The
  // signal analyzer and outreach writer should both pick the right wedge
  // based on who the signal/message is aimed at.
  audiences: {
    frontline_mgr: {
      leads_with: 'day-to-day coaching + unified activity view',
      cares_about: 'team consistency, coaching cadence, pipeline visibility',
      do: 'speak in the language of manager 1:1s, weekly pipeline reviews, rep ramp.',
      dont: 'talk about board reporting, consolidation strategy, category narratives.',
    },
    revops: {
      leads_with: 'data integrity, system consolidation, the Performance Graph as the GTM data fabric',
      cares_about: 'stack consolidation, clean source for GTM agents, vendor rationalization math',
      do: 'frame Ambition as the hub that replaces 3–5 point tools; use "unified source of truth" language.',
      dont: 'lead with coaching feel-goods — RevOps buys outcomes, not sentiment.',
    },
    cro_exec: {
      leads_with: 'GTM Governance, executive visibility, measurable performance across the org',
      cares_about: 'predictable forecast, manager layer as a multiplier, consolidation ROI',
      do: 'speak to strategic command center, operationalizing strategy, the manager layer as the untapped advantage.',
      dont: 'get into feature comparisons or specific dashboards.',
    },
  },
};

// applyPositioning(personaId) returns a compact, prompt-ready block that
// can be slotted into any Claude system prompt. personaId is optional;
// when omitted the block covers all audiences.
//
// Example:
//   const block = applyPositioning('revops');
//   const system = `${BASE_PROMPT}\n\n${block}`;
export function applyPositioning(personaId = null) {
  const aud = personaId && POSITIONING.audiences[personaId];

  const useLine = POSITIONING.use_lexicon.map((s) => `"${s}"`).join(', ');
  const avoidLine = POSITIONING.avoid_as_lead.map((s) => `"${s}"`).join(', ');
  const arcLines = POSITIONING.narrative_arc.map((s, i) => `  ${i + 1}. ${s}`).join('\n');

  const audienceBlock = aud
    ? `AUDIENCE (${personaId}):
- Leads with: ${aud.leads_with}
- Cares about: ${aud.cares_about}
- DO: ${aud.do}
- DON'T: ${aud.dont}`
    : `AUDIENCE DIFFERENTIATION:
${Object.entries(POSITIONING.audiences)
  .map(
    ([id, a]) =>
      `- ${id}: leads with ${a.leads_with}. DO: ${a.do} DON'T: ${a.dont}`
  )
  .join('\n')}`;

  return `AMBITION 2.0 POSITIONING — HARD CONSTRAINT.

USE this lexicon when framing interpretation (so_what, recommended_move, message body):
${useLine}

NEVER LEAD with these phrases (they are true of the foundation, but wrong as a hook in 2026):
${avoidLine}

Narrative arc for any interpretation:
${arcLines}

${audienceBlock}

Hard rules:
- Factual fields (observed title, observed summary, subject-line hooks tied to a signal) stay neutral — no positioning language there.
- Positioning language lives in interpretation fields only.
- Never open with the AVOID lexicon. If you must reference the foundation, do so as "built on the foundation of ..." — never first.`;
}

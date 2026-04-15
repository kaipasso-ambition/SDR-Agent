// Champion voice — the writing rules for anything a champion will
// forward, paste into Slack, or quote internally. Sibling to
// src/lib/positioning.js; where positioning enforces the vendor spine
// (Performance Graph, GTM Governance) for AE-facing content, this
// module enforces the OPPOSITE for champion-facing content.
//
// Grounded in Nate Nasralla / Fluint: the deal travels inside the
// buyer's org in the champion's voice. If it reads like a vendor
// one-pager, it won't be forwarded. If it asks a question their peers
// can't dismiss, it does the selling without sounding like selling.
//
// applyChampionVoice() returns a prompt-appendable string the
// play_builder and artifact_builder agents use when emitting anything
// the champion will execute.

export const CHAMPION_VOICE = {
  // Hard rules — violations should be treated as failure to follow
  // instruction, not style preference.
  hard_rules: [
    'Write in the CHAMPION\'s first person ("I", "we", "our team") — never in vendor voice.',
    'No Ambition product names. No "Performance Graph." No "GTM Governance." No vendor lexicon. The champion is pasting this into their team\'s Slack or their boss\'s inbox — vendor language gets them screenshotted.',
    'No hedging vendor phrases ("solution", "platform", "synergy", "leverage", "best-in-class", "industry-leading"). Plain operator language only.',
    'Questions over claims. A pointed question the champion can raise in a staff meeting does more than any bullet of feature benefits. Prefer "Has anyone looked at how much of our managers\' week is spent reconciling coaching notes across tools?" to "Ambition unifies coaching notes."',
    'Specific over generic. Name real stakeholders, real meetings, real pain moments. A champion forwards specifics; they delete generalities.',
    'One ask per artifact. The recipient should know exactly what to do next in one sentence.',
  ],

  // Soft preferences — anchor tone, not a checklist.
  tone: [
    'Short. Slack-length unless the artifact type explicitly needs more.',
    'Direct but not blunt. The champion still works with these people tomorrow.',
    'A little dry. A little human. Acknowledge the thing that\'s obviously awkward ("I know this is the third tool conversation this quarter").',
    'No exclamation points. No "excited to share". No "wanted to put this in front of you."',
  ],

  // Artifact-type-specific shape hints the model can use to pick the
  // right length and format.
  artifact_shapes: {
    slack_forward:
      '1-3 short paragraphs, no preamble. Opens with the context the recipient needs ("heads up — saw something in earnings today"). Ends with ONE question or ONE ask. Pasteable as-is into a DM or channel.',
    exec_talking_points:
      '3-5 bullets, each ≤15 words. Framed for the champion to say OUT LOUD in a staff meeting. No prose. No filler.',
    one_pager:
      '≤250 words. Three sections labelled: Today, What would be different, What I\'m asking for. No logos. No product screenshots. Could be pasted into a Google Doc and circulated.',
    question_to_raise:
      'ONE sentence. A question the champion asks in their next staff or 1:1. The question itself must surface the pain — the recipient should feel it without the champion having to argue.',
    meeting_pre_read:
      '≤150 words. Context (what\'s on the agenda), stake (why it matters this quarter), one decision the meeting should produce. Reads like it was written by whoever called the meeting.',
  },

  // Questions we can hand the model to interrogate any draft it produces.
  self_check: [
    'Would the champion actually paste this, or would they rewrite it first? If they\'d rewrite, rewrite it now.',
    'Does it sound like a vendor wrote it? If yes, strip the vendor tells.',
    'Is there a claim that should be a question? Convert it.',
    'Is there a generic phrase that should name a real stakeholder or meeting? Replace it.',
    'Is there more than one ask? Cut to one.',
  ],
};

// Compose a prompt block the agents append when they want the model to
// generate champion-voice content. Kept deliberately separate from
// applyPositioning() — the two modules should never appear in the same
// instruction block because their voice rules are incompatible.
export function applyChampionVoice() {
  const rules = CHAMPION_VOICE.hard_rules.map((r) => `- ${r}`).join('\n');
  const tone = CHAMPION_VOICE.tone.map((t) => `- ${t}`).join('\n');
  const shapes = Object.entries(CHAMPION_VOICE.artifact_shapes)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  const checks = CHAMPION_VOICE.self_check.map((c) => `- ${c}`).join('\n');
  return `
CHAMPION VOICE — apply to every artifact whose for_actor is "champion":

HARD RULES (violations = instruction failure):
${rules}

TONE:
${tone}

ARTIFACT SHAPE HINTS (pick the one matching artifact.type):
${shapes}

SELF-CHECK before returning any champion-voice artifact:
${checks}
`.trim();
}

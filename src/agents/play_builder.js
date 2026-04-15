// Play-builder agent. Synchronous Claude call (no web_search) — takes the
// AE's instinct + context and returns a sequenced play. Called inline from
// the /plays create route; typical latency 6–12s.
//
// Failure mode: if Claude returns malformed JSON, we still persist the play
// with ai_expansion=null so the AE keeps their instinct. The Plan page
// surfaces a "rebuild" button on any play with a missing expansion.

import Anthropic from '@anthropic-ai/sdk';
import { PLAY_BUILDER_PROMPT } from '../prompts/play_builder.js';

const client = new Anthropic();

export async function buildPlay({
  account,
  instinct,
  hypothesis = null,
  contact_path_resolved = [],   // array of {name, title, deal_role, stance}
  triggering_signal = null,     // {title, so_what, recommended_move} or null
  prior_plays = [],             // compact array of {named_play, status}
}) {
  if (!instinct || !instinct.trim()) {
    return { expansion: null, model: null, error: 'empty instinct' };
  }

  const payload = {
    account: {
      name: account?.account_name,
      domain: account?.domain,
      status: account?.status,
      notes: account?.notes || null,
    },
    instinct: instinct.trim(),
    hypothesis: hypothesis
      ? {
          use_case: hypothesis.use_case,
          target_persona: hypothesis.target_persona_id,
          narrative_hook: hypothesis.narrative_hook,
        }
      : null,
    contact_path: contact_path_resolved.map((c) => ({
      name: c.name,
      title: c.title,
      deal_role: c.deal_role,
      stance: c.stance,
    })),
    triggering_signal: triggering_signal
      ? {
          title: triggering_signal.title,
          so_what: triggering_signal.so_what,
          recommended_move: triggering_signal.recommended_move,
        }
      : null,
    prior_plays: prior_plays.slice(0, 5),
  };

  const model = 'claude-sonnet-4-20250514';
  const response = await client.messages.create(
    {
      model,
      max_tokens: 2000,
      system: PLAY_BUILDER_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    },
    { timeout: 90 * 1000 }
  );

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Permissive extraction: fenced block, then first {...} block, else raw.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : brace ? brace[0] : text;

  try {
    const parsed = JSON.parse(jsonText);
    return { expansion: { ...parsed, ai_model_version: model }, model };
  } catch (err) {
    console.error('[play_builder] JSON parse failed:', text.slice(0, 200));
    return { expansion: null, model, error: 'parse failure' };
  }
}

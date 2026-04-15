// Play-builder agent. Synchronous Claude call (no web_search) — takes the
// AE's instinct + context and returns a sequenced play. Called inline from
// the /plays create route; typical latency 6–12s.
//
// Failure mode: if Claude returns malformed JSON, we still persist the play
// with ai_expansion=null so the AE keeps their instinct. The Plan page
// surfaces a "rebuild" button on any play with a missing expansion.

import Anthropic from '@anthropic-ai/sdk';
import { buildPlayBuilderPrompt } from '../prompts/play_builder.js';
import { matchIndustryLexicon } from '../lib/industry_lexicon.js';

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

  // Resolve the champion on the path (first contact with deal_role=champion
  // and a non-cold stance). Prompt uses this to decide ball-carrier for
  // middle moves — champion-led is the default per Nasralla when one exists.
  const champion = contact_path_resolved.find(
    (c) => c.deal_role === 'champion' && c.stance !== 'cold' && c.stance !== 'hostile'
  ) || null;

  // Resolve industry lexicon once so we can both (a) build the prompt and
  // (b) echo it into the payload metadata so the model can refer back.
  const lexicon = matchIndustryLexicon(account?.industry);

  const payload = {
    account: {
      name: account?.account_name,
      domain: account?.domain,
      status: account?.status,
      industry: account?.industry || null,
      industry_lexicon_key: lexicon.key,
      notes: account?.notes || null,
    },
    instinct: instinct.trim(),
    hypothesis: hypothesis
      ? {
          use_case: hypothesis.use_case,
          target_persona: hypothesis.target_persona_id,
          narrative_hook: hypothesis.narrative_hook,
          narrative: hypothesis.narrative || null,
        }
      : null,
    contact_path: contact_path_resolved.map((c) => ({
      name: c.name,
      title: c.title,
      deal_role: c.deal_role,
      stance: c.stance,
    })),
    champion_resolved: champion
      ? { name: champion.name, title: champion.title, stance: champion.stance }
      : null,
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
      max_tokens: 3000,
      system: buildPlayBuilderPrompt({ industry: account?.industry }),
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    },
    { timeout: 120 * 1000 }
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
    return {
      expansion: {
        ...parsed,
        ai_model_version: model,
        industry_lexicon_key: lexicon.key,
      },
      model,
    };
  } catch (err) {
    console.error('[play_builder] JSON parse failed:', text.slice(0, 200));
    return { expansion: null, model, error: 'parse failure' };
  }
}

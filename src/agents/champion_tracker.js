// Champion tracker: for each tracked champion, ask Claude (with web_search)
// whether they still work where we think they work. If not — record the move
// so the UI surfaces it and the reconnect-draft flow can pick it up.
//
// Budget: Claude sonnet with 1-3 web_searches per champion ≈ 10-15s and a
// few cents each. At 200 champions/week that's under $5 + 40 minutes total.
// We gate by last_checked_at so a failed run doesn't double-bill next time.

import Anthropic from '@anthropic-ai/sdk';
import { CHAMPION_CHECK_PROMPT } from '../prompts/champion_check.js';
import {
  getChampionsDueForCheck,
  markChampionChecked,
  recordMove,
} from '../db/champions.js';
import { getAccountByDomain } from '../db/accounts_registry.js';
import { query } from '../db/index.js';

const client = new Anthropic();

async function checkOne(champion) {
  const userContent = `
Champion to verify:
${JSON.stringify({
  full_name: champion.full_name,
  linkedin_url: champion.linkedin_url,
  last_known_company: champion.current_company,
  last_known_title: champion.current_title,
  email: champion.email,
}, null, 2)}
  `.trim();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: CHAMPION_CHECK_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }, { timeout: 3 * 60 * 1000 });

  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const searchCount = response.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const brace = text.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1].trim() : (brace ? brace[0] : text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error(`[champion_tracker] JSON parse failed for ${champion.full_name}: ${text.slice(0, 200)}`);
    return { outcome: 'unknown', searches: searchCount, rationale: 'parse failure' };
  }

  // Circuit breaker: zero web_searches means we're getting stale training data.
  if (searchCount === 0) {
    return { outcome: 'unknown', searches: 0, rationale: 'no web_search calls — treated as unverified' };
  }
  return { ...parsed, searches: searchCount };
}

// Decide what kind of play a detected move triggers.
//   warm_outbound       — new company is not a current customer → reconnect draft
//   internal_customer   — new company is already a live customer → just a heads-up
//   winback             — new company is a churned Ambition account → win-back play
//   skip                — duplicate / DNC / new company missing
async function routeMove(champion, result) {
  if (champion.do_not_contact) return 'skip';
  if (!result.to_domain && !result.current_company) return 'skip';

  const account = result.to_domain ? await getAccountByDomain(result.to_domain) : null;
  if (account?.status === 'customer') return 'internal_customer';
  if (account?.status === 'churned') return 'winback';
  return 'warm_outbound';
}

// Main entry point — run one pass over champions due for a check.
// Exported so both the cron and the manual "check now" route can call it.
export async function runChampionCheckCycle({ limit = 25, job_id = null } = {}) {
  const updateJob = async (fields) => {
    if (!job_id) return;
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => fields[k]);
    await query(
      `UPDATE champion_check_jobs SET ${sets} WHERE id = $1`,
      [job_id, ...values]
    );
  };

  const pool = await getChampionsDueForCheck({ limit });
  console.log(`[champion_tracker] START job=${job_id} checking ${pool.length} champion(s)`);

  let checked = 0;
  let moves = 0;

  for (const champion of pool) {
    try {
      const result = await checkOne(champion);
      checked++;

      if (result.outcome === 'move' && result.current_company
          && result.current_company.toLowerCase() !== (champion.current_company || '').toLowerCase()) {
        const routing = await routeMove(champion, result);
        await recordMove({
          champion_id: champion.id,
          from_company: champion.current_company,
          to_company: result.current_company,
          to_title: result.current_title || null,
          to_domain: result.to_domain || null,
          source_url: result.source_url || null,
          confidence: result.confidence || 'medium',
          routing,
        });
        await markChampionChecked(champion.id, {
          status: 'moved',
          current_company: result.current_company,
          current_title: result.current_title || champion.current_title,
        });
        moves++;
        console.log(`[champion_tracker] MOVE ${champion.full_name}: ${champion.current_company} → ${result.current_company} (${routing})`);
      } else if (result.outcome === 'stay') {
        await markChampionChecked(champion.id, { status: 'tracking' });
      } else {
        // unknown — still update last_checked_at so we don't re-spend tomorrow
        await markChampionChecked(champion.id);
      }
      await updateJob({ checked_count: checked, moves_detected: moves });
    } catch (err) {
      console.error(`[champion_tracker] ${champion.full_name} failed:`, err.message);
    }
  }

  await updateJob({
    status: 'completed',
    checked_count: checked,
    moves_detected: moves,
    finished_at: new Date(),
  });
  console.log(`[champion_tracker] DONE checked=${checked} moves=${moves}`);
  return { checked, moves };
}

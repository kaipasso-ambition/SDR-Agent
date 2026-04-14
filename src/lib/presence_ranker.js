// Presence ranker: score new presence_posts rows, pick the top N to draft.
//
// Cheap, deterministic, no LLM. The daily budget is ~10 comments a human can
// realistically post; we rank the queue so those 10 are spent on the posts
// most likely to turn into recognition and, eventually, inbound.
//
// Scoring axes (0-100, weighted sum):
//   Recency        — fresher posts get more engagement if we comment early
//   Seniority      — VP / CRO / Head of > Manager > IC (when title available)
//   Topical fit    — words related to Ambition's wedge (sales performance,
//                    coaching, quota attainment, pipeline, enablement, RevOps)
//   Post type      — substantive share > job change > news mention > bare comment
//   Snippet length — >120 chars suggests a real post (not "congrats!" tier)
//
// We intentionally do NOT LLM-score here. A 10-cent ranker that's 80% as good
// as a $2 LLM-ranker beats the LLM version at Ambition's scale (hundreds of
// posts/day, we only draft 10).

import { getNewPosts, setRank, setDraft } from '../db/presence.js';
import { draftComment } from '../agents/commenter.js';

const TOPIC_KEYWORDS = [
  // direct Ambition wedge
  'sales performance', 'sales coach', 'coaching', 'quota', 'pipeline',
  'enablement', 'revops', 'revenue operations', 'sales leader',
  'sales management', 'ramp time', 'rep productivity', 'forecast',
  'accountability', 'gamification', 'leaderboard', 'kpi',
  // adjacent but relevant
  'hire', 'hiring', 'onboarding', 'quota attainment', 'closing',
  'discovery call', 'outbound', 'cold call', 'commission',
  'sales ops', 'cro', 'vp sales', 'sdr', 'bdr', 'account executive',
];

const SENIORITY_TERMS = [
  ['cro', 100], ['chief revenue', 100], ['chief commercial', 100],
  ['evp', 92], ['svp', 90], ['senior vice president', 90],
  ['vp ', 85], ['vice president', 85],
  ['head of', 78], ['director', 70], ['senior director', 75],
  ['senior manager', 55], ['manager', 45],
];

function scoreRecency(received_at) {
  const ageHours = (Date.now() - new Date(received_at).getTime()) / 36e5;
  if (ageHours <= 6) return 100;
  if (ageHours <= 24) return 80;
  if (ageHours <= 48) return 55;
  if (ageHours <= 72) return 30;
  return 10;
}

function scoreSeniority(title) {
  if (!title) return 50; // unknown — neutral, don't bury it
  const t = title.toLowerCase();
  for (const [needle, score] of SENIORITY_TERMS) {
    if (t.includes(needle)) return score;
  }
  return 40;
}

function scoreTopical(snippet) {
  if (!snippet) return 35; // no content, can't judge
  const s = snippet.toLowerCase();
  let hits = 0;
  for (const kw of TOPIC_KEYWORDS) {
    if (s.includes(kw)) hits++;
  }
  if (hits >= 3) return 100;
  if (hits === 2) return 80;
  if (hits === 1) return 60;
  return 35;
}

function scorePostType(post_type) {
  switch (post_type) {
    case 'share': return 90;
    case 'job_change': return 70;
    case 'news_mention': return 55;
    case 'comment': return 25;
    default: return 50;
  }
}

function scoreSnippetDepth(snippet) {
  if (!snippet) return 20;
  const len = snippet.length;
  if (len >= 200) return 100;
  if (len >= 120) return 75;
  if (len >= 60) return 50;
  return 25;
}

export function scorePost(post) {
  const rec = scoreRecency(post.received_at);
  const sen = scoreSeniority(post.author_title);
  const top = scoreTopical(post.post_snippet);
  const typ = scorePostType(post.post_type);
  const dep = scoreSnippetDepth(post.post_snippet);

  // Weights sum to 1.0. Recency and topical fit dominate; seniority is the
  // tiebreaker. Snippet depth keeps "congrats!" 1-liners out of the top 10.
  const score = (rec * 0.30) + (top * 0.30) + (sen * 0.15) + (typ * 0.15) + (dep * 0.10);

  const reason =
    `recency=${rec} topical=${top} seniority=${sen} type=${typ} depth=${dep}`;

  return { score: Math.round(score * 10) / 10, reason };
}

/**
 * Score every new post, then draft comments for the top N. Idempotent:
 * setRank is safe to re-run; draftComment only fires on rows still in 'new'.
 */
export async function runRankerCycle({ draftTopN = 10 } = {}) {
  const queue = await getNewPosts({ limit: 200 });
  console.log(`[ranker] scoring ${queue.length} new posts`);

  const scored = [];
  for (const post of queue) {
    const { score, reason } = scorePost(post);
    await setRank(post.id, { score, reason });
    scored.push({ ...post, rank_score: score, rank_reason: reason });
  }
  scored.sort((a, b) => b.rank_score - a.rank_score);

  const top = scored.slice(0, draftTopN);
  console.log(`[ranker] drafting top ${top.length} of ${scored.length}`);

  let drafted = 0, skipped = 0, errored = 0;
  for (const post of top) {
    try {
      const r = await draftComment(post);
      if (r.skip) {
        skipped++;
        console.log(`[ranker] skipped ${post.author_name}: ${r.skip_reason}`);
        continue;
      }
      await setDraft(post.id, { draft_comment: r.comment });
      drafted++;
      console.log(`[ranker] drafted for ${post.author_name} (score=${post.rank_score})`);
    } catch (err) {
      errored++;
      console.error(`[ranker] draft failed for ${post.author_name}:`, err.message);
    }
  }
  console.log(`[ranker] DONE scored=${scored.length} drafted=${drafted} skipped=${skipped} errored=${errored}`);
  return { scored: scored.length, drafted, skipped, errored };
}

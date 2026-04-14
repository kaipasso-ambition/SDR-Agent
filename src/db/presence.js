// Presence copilot: CRUD for presence_posts.
//
// One row per LinkedIn post we've ingested from a Sales Nav email digest.
// Dedup key is post_url (LinkedIn assigns each post a unique URN in the URL).
// We upsert on conflict so re-processing the same digest email is a no-op.

import { query } from './index.js';

export async function upsertPresencePost(post) {
  const {
    author_name,
    author_title = null,
    author_company = null,
    author_linkedin_url = null,
    post_url,
    post_snippet = null,
    post_type = 'share',
    posted_at = null,
    source_email_id = null,
    raw_meta = null,
  } = post;

  if (!author_name || !post_url) {
    throw new Error('presence_posts upsert requires author_name and post_url');
  }

  const sql = `
    INSERT INTO presence_posts (
      author_name, author_title, author_company, author_linkedin_url,
      post_url, post_snippet, post_type, posted_at,
      source_email_id, raw_meta
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    ON CONFLICT (post_url) DO UPDATE SET
      author_title   = COALESCE(EXCLUDED.author_title,   presence_posts.author_title),
      author_company = COALESCE(EXCLUDED.author_company, presence_posts.author_company),
      post_snippet   = COALESCE(EXCLUDED.post_snippet,   presence_posts.post_snippet),
      posted_at      = COALESCE(EXCLUDED.posted_at,      presence_posts.posted_at)
    RETURNING *, (xmax = 0) AS inserted;
  `;

  const values = [
    author_name, author_title, author_company, author_linkedin_url,
    post_url, post_snippet, post_type, posted_at,
    source_email_id, raw_meta ? JSON.stringify(raw_meta) : null,
  ];

  const { rows } = await query(sql, values);
  return rows[0];
}

// Posts waiting to be ranked. Fresh arrivals only (last 72h) so we don't
// re-rank stale posts the operator has already walked past.
export async function getNewPosts({ limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT * FROM presence_posts
      WHERE status = 'new'
        AND received_at > NOW() - INTERVAL '72 hours'
      ORDER BY received_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// Top candidates ready for draft-comment generation. Assumes ranker has
// already populated rank_score on status='new' rows.
export async function getTopRanked({ limit = 10 } = {}) {
  const { rows } = await query(
    `SELECT * FROM presence_posts
      WHERE status = 'new'
        AND rank_score IS NOT NULL
      ORDER BY rank_score DESC NULLS LAST, received_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function setRank(id, { score, reason }) {
  await query(
    `UPDATE presence_posts SET rank_score = $2, rank_reason = $3 WHERE id = $1`,
    [id, score, reason || null]
  );
}

export async function setDraft(id, { draft_comment }) {
  await query(
    `UPDATE presence_posts
        SET draft_comment = $2,
            drafted_at    = NOW(),
            status        = 'drafted'
      WHERE id = $1`,
    [id, draft_comment]
  );
}

// Posts to show in the /presence dashboard: drafted and not yet acted on,
// newest+highest-ranked first. 7-day window keeps the list from bloating.
export async function getPresenceFeed({ limit = 30 } = {}) {
  const { rows } = await query(
    `SELECT * FROM presence_posts
      WHERE status = 'drafted'
        AND received_at > NOW() - INTERVAL '7 days'
      ORDER BY rank_score DESC NULLS LAST, received_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function markPosted(id) {
  await query(`UPDATE presence_posts SET status = 'posted' WHERE id = $1`, [id]);
}

export async function markSkipped(id) {
  await query(`UPDATE presence_posts SET status = 'skipped' WHERE id = $1`, [id]);
}

export async function setThumbs(id, { thumbs, note }) {
  if (thumbs !== 'up' && thumbs !== 'down' && thumbs !== null) {
    throw new Error(`thumbs must be 'up' | 'down' | null, got ${thumbs}`);
  }
  await query(
    `UPDATE presence_posts SET thumbs = $2, feedback_note = $3 WHERE id = $1`,
    [id, thumbs, note || null]
  );
}

export async function getPresenceStats() {
  const { rows } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'new')      AS new_count,
      COUNT(*) FILTER (WHERE status = 'drafted')  AS drafted_count,
      COUNT(*) FILTER (WHERE status = 'posted')   AS posted_count,
      COUNT(*) FILTER (WHERE status = 'skipped')  AS skipped_count,
      COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '24 hours') AS last24h_count
    FROM presence_posts
  `);
  return rows[0];
}

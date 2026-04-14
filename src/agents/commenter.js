// Commenter agent: Claude drafts a short, postable LinkedIn comment for a
// single presence_posts row. Runs once per post (not per prospect), only on
// the top-ranked posts each day so we don't burn API credits on noise.
//
// Input contract: a post row from presence_posts (author + snippet + type).
// Output contract: { comment } on success, or { skip, skip_reason } when the
// post isn't worth engaging (bare link share, generic motivation, etc).

import Anthropic from '@anthropic-ai/sdk';
import { COMMENTER_PROMPT } from '../prompts/commenter.js';

const client = new Anthropic();

export async function draftComment(post) {
  const snippet = post.post_snippet || '';
  const isTruncated = snippet.endsWith('…') || snippet.endsWith('...') || (snippet.length > 0 && snippet.length < 120);

  const userContent = `POST CONTEXT

Author: ${post.author_name}${post.author_title ? ' — ' + post.author_title : ''}${post.author_company ? ' @ ' + post.author_company : ''}
Post type: ${post.post_type || 'share'}

Post snippet (from Sales Nav digest — ${isTruncated ? 'TRUNCATED, full post is longer' : 'full preview'}):
"""
${snippet || '(no snippet — digest did not include preview text)'}
"""

${isTruncated ? 'The operator will read the full post on LinkedIn before pasting your draft. Draft based on the topic/theme visible in the snippet, even if you can\'t see the ending. Only skip if the visible content is clearly noise (meme, hiring list, bare link, self-promo, personal life).' : ''}

Draft the comment now, following the voice + structure rules in the system prompt. Return JSON only.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: COMMENTER_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`commenter returned invalid JSON: ${text.slice(0, 200)}`);
  }

  if (parsed.skip) {
    return { skip: true, skip_reason: parsed.skip_reason || 'unspecified' };
  }
  if (!parsed.comment || typeof parsed.comment !== 'string') {
    throw new Error('commenter returned neither "comment" nor "skip"');
  }
  return { comment: parsed.comment.trim() };
}

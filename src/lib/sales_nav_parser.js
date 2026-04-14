// Sales Navigator email-digest parser.
//
// Input: raw HTML body of a Sales Nav alert email (subjects like "Your daily
// Sales Navigator update", "X shared a post", "Y changed jobs").
// Output: array of presence_post-shaped objects we can upsert.
//
// LinkedIn's digest HTML is deeply nested table-based email markup with lots
// of tracking redirects. We extract three things per item:
//   1. author display name (and optionally title/company) — from <a> text near
//      a LinkedIn member URL
//   2. post URL — LinkedIn wraps every link in /comm/... redirects pointing
//      at a real /posts/... or /feed/update/urn:li:activity:... URL
//   3. post snippet — the short preview text LinkedIn embeds beneath each item
//
// The format changes quarterly. This parser is intentionally conservative:
// it prefers to return fewer, well-formed posts over more, malformed ones,
// and it tags each row with post_type based on subject-line heuristics so
// the operator can tell digest-types apart in the UI.
//
// Until we have a real captured sample to test against, treat this as v0 —
// it will need tuning when the first real digest lands in the inbox.

const LI_POST_URL_RE = /https:\/\/www\.linkedin\.com\/(?:feed\/update\/urn:li:activity:\d+|posts\/[^\s"'<>]+)/gi;
const LI_MEMBER_URL_RE = /https:\/\/www\.linkedin\.com\/in\/[^\s"'<>?]+/gi;
const LI_COMM_URL_RE = /https:\/\/www\.linkedin\.com\/comm\/[^\s"'<>]+/gi;

function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// LinkedIn wraps every outbound link in /comm/<path>?<querystring>. The real
// destination is URL-encoded in the querystring. We don't actually need to
// unwrap — the /comm/ URL itself is canonical for dedup — but we do pluck
// the underlying URN when we can, so later we can resolve to the public post.
function extractPostUrls(html) {
  const out = new Set();
  const combined = new RegExp(`${LI_POST_URL_RE.source}|${LI_COMM_URL_RE.source}`, 'gi');
  let m;
  while ((m = combined.exec(html)) !== null) {
    // Filter obvious noise: unsubscribe, settings, help links
    const url = m[0];
    if (/\b(unsubscribe|email[-_]settings|help|privacy|psettings)\b/i.test(url)) continue;
    out.add(url);
  }
  return [...out];
}

function classifyPostType({ subject, blockText }) {
  const s = `${subject} ${blockText}`.toLowerCase();
  if (/changed (jobs|roles)|new (role|position|job)|joined|started a new/.test(s)) return 'job_change';
  if (/mentioned|in the news|featured in/.test(s)) return 'news_mention';
  if (/commented on|replied to/.test(s)) return 'comment';
  if (/shared|posted|wrote|published/.test(s)) return 'share';
  return 'share';
}

// Heuristic split: LinkedIn digest emails use a repeating <table> block per
// item. We split on post-URL occurrences and walk outward ~2000 chars to grab
// the surrounding context (name + snippet) for each one.
export function parseSalesNavDigest({ html, subject = '', from = '' } = {}) {
  if (!html || typeof html !== 'string') return [];

  const posts = [];
  const seen = new Set();
  const urls = extractPostUrls(html);

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);

    const idx = html.indexOf(url);
    if (idx < 0) continue;
    // Context window around this post URL, big enough to catch the name and
    // snippet which LinkedIn places immediately above/below the CTA link.
    const ctxStart = Math.max(0, idx - 2500);
    const ctxEnd = Math.min(html.length, idx + 1500);
    const ctxHtml = html.slice(ctxStart, ctxEnd);
    const ctxText = stripHtml(ctxHtml);

    // Author name: first linkedin.com/in/ link in the context.
    let author_name = null;
    let author_linkedin_url = null;
    const memberMatch = ctxHtml.match(LI_MEMBER_URL_RE);
    if (memberMatch && memberMatch[0]) {
      author_linkedin_url = memberMatch[0];
      // Pull anchor text for that member link
      const anchorRe = new RegExp(
        `<a[^>]*href="${memberMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"[^>]*>([\\s\\S]*?)</a>`,
        'i'
      );
      const aMatch = ctxHtml.match(anchorRe);
      if (aMatch) author_name = stripHtml(aMatch[1]);
    }
    // Fallback: grab the first capitalized 2-4-word phrase in the context
    // that isn't a known digest-chrome word.
    if (!author_name) {
      const words = ctxText.match(/\b([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){1,3})\b/);
      if (words && !/Sales Navigator|LinkedIn|Unsubscribe|View/.test(words[1])) {
        author_name = words[1];
      }
    }
    if (!author_name) continue; // can't attribute the post — skip

    // Author title/company: LinkedIn puts these on the line after the name as
    // "Title at Company", often inside a small grey <span>.
    let author_title = null;
    let author_company = null;
    const titleCoMatch = ctxText.match(/\b([A-Z][^.\n]{3,80}?)\s+at\s+([A-Z][^.\n]{1,60})/);
    if (titleCoMatch) {
      author_title = titleCoMatch[1].trim();
      author_company = titleCoMatch[2].trim().replace(/\s{2,}.*$/, '');
    }

    // Snippet: text between the name and the post URL, trimmed and clipped.
    let post_snippet = ctxText.slice(0, 400);
    // Strip obvious chrome
    post_snippet = post_snippet
      .replace(/Sales Navigator/gi, '')
      .replace(/View (in|on) LinkedIn/gi, '')
      .replace(/Unsubscribe/gi, '')
      .trim();
    if (post_snippet.length > 350) post_snippet = post_snippet.slice(0, 347) + '…';

    const post_type = classifyPostType({ subject, blockText: ctxText });

    posts.push({
      author_name,
      author_title,
      author_company,
      author_linkedin_url,
      post_url: url,
      post_snippet: post_snippet || null,
      post_type,
      raw_meta: { subject, from, url_was_redirect: /\/comm\//.test(url) },
    });
  }

  // If we found zero posts but the email looks like a Sales Nav digest, log
  // a preview so we can iterate on the parser from a real sample.
  if (posts.length === 0 && /sales\s*navigator/i.test(subject + ' ' + from)) {
    console.warn('[sales_nav_parser] 0 posts extracted from presumed Sales Nav digest. ' +
      'Subject=' + JSON.stringify(subject) + ' html_preview=' + JSON.stringify(stripHtml(html).slice(0, 400)));
  }

  return posts;
}

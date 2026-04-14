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

import crypto from 'node:crypto';

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

// "In case you missed it" daily digest (X-LinkedIn-Template:
// email_lss_in_case_you_missed_it_digest). This is the template LinkedIn
// actually sends today — a structured list of 5–10 leads who shared posts.
//
// Unlike the older "Your daily Sales Nav update" template, this one does NOT
// include direct post URLs. Every CTA is a /comm/sales/contract-chooser
// redirect to either the lead's Sales Nav profile (/sales/lead/<URN>) or the
// Sales Nav home. So the commenter can't jump straight to the post — it has
// to drop the operator on the lead's profile and let them click the post.
//
// We extract one item per lead by anchoring on the profile-image <a>, which
// has both the lead URN (in its redirect= param) and the author's name
// (in the <img alt="<Name>'s profile image">). Walking forward from there,
// we pick up the snippet (<p class="hero-body-content"> or "body-content")
// and title/company (<p class="text-xs ...">Title · Company</p>).
function extractLeadUrn(commHref) {
  const m = commHref.match(/redirect=%2Fsales%2Flead%2F([^,&"]+),NAME_SEARCH/i);
  return m ? m[1] : null;
}

function extractInCaseYouMissedItItems(html, subject, from) {
  const items = [];
  const seenUrn = new Set();

  // Match every /comm/sales/contract-chooser anchor that points at a lead
  // profile AND wraps an <img alt="Name's profile image">. This uniquely
  // picks the profile-image link for each entity block and skips the parallel
  // text-wrapper anchor (which redirects to /sales/index, not /sales/lead/).
  //
  // We greedy-match everything up to `profile image` and strip the possessive
  // suffix in post, so plural-possessives ("Trina Hymes'") don't truncate to
  // "Trina Hyme".
  const blockRe = /<a\s+href="(https:\/\/www\.linkedin\.com\/comm\/sales\/contract-chooser\?[^"]*redirect=%2Fsales%2Flead%2F[^"]+)"[^>]*>\s*<img[^>]*alt="([^"]+?)\s+profile\s+image"/gi;

  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const clickUrl = m[1].replace(/&amp;/g, '&');
    const author_name = m[2]
      .trim()
      // "Middleton's" -> "Middleton"; "Hymes'" -> "Hymes"; leave "Hymes" alone.
      .replace(/[’'\u2019]s$/, '')
      .replace(/[’'\u2019]$/, '');
    const leadUrn = extractLeadUrn(clickUrl);
    if (!leadUrn) continue;

    // Walk forward from the match to collect snippet + title. 4k chars is
    // enough to span one entity block without crossing into the next.
    const windowStart = m.index + m[0].length;
    const window = html.slice(windowStart, windowStart + 4000);

    // Snippet: first hero-body-content (featured block) or body-content
    // (other-notifications rows) or thumbnail-content (article/media card).
    let snippet = null;
    const snipRe = /<p[^>]*class="[^"]*(?:hero-body-content|body-content)[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
    const snipMatch = window.match(snipRe);
    if (snipMatch) snippet = stripHtml(snipMatch[1]);

    // Title · Company: <p class="... text-xs ...">Title · Company</p>. The
    // middle dot is U+00B7. Fall back to "Title at Company" if LinkedIn
    // ever switches.
    let author_title = null;
    let author_company = null;
    const tcRe = /<p[^>]*class="[^"]*text-xs[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
    const tcMatch = window.match(tcRe);
    if (tcMatch) {
      const tcText = stripHtml(tcMatch[1]);
      const parts = tcText.split(/\s*[·\u00b7]\s*/);
      if (parts.length >= 2) {
        author_title = parts[0].trim();
        author_company = parts.slice(1).join(' · ').trim();
      } else if (/\sat\s/i.test(tcText)) {
        const [t, ...rest] = tcText.split(/\s+at\s+/i);
        author_title = t.trim();
        author_company = rest.join(' at ').trim();
      }
    }

    // Classify the engagement type so the dashboard can route to the right
    // action. "In case you missed it" digests mix three kinds of entries:
    //   - top-level shares (lead posted something themselves)
    //   - comments (lead replied on someone else's post)
    //   - reactions/likes (lead hit react on someone else's post)
    // LinkedIn labels the block with a tiny header phrase like "posted" /
    // "commented on" / "reacted to" / "shared" — we stripHtml the window and
    // sniff for those markers. Default is 'share' since that's the dominant
    // case and the safest action (drop on profile).
    const windowText = stripHtml(window).toLowerCase();
    let post_type = 'share';
    if (/\bcommented on\b|\breplied to\b/.test(windowText)) post_type = 'comment';
    else if (/\breacted to\b|\blikes? this\b|\bcelebrated\b/.test(windowText)) post_type = 'reaction';
    else if (/\bnew (role|position|job)\b|\bstarted (a new|at)\b|\bchanged (jobs|roles)\b/.test(windowText)) post_type = 'job_change';
    else if (/\bmentioned\b|\bin the news\b|\bfeatured in\b/.test(windowText)) post_type = 'news_mention';

    // Dedup within this email by lead URN — the profile image anchor appears
    // once per lead, but if LinkedIn ever changes that we still want to avoid
    // double-inserts.
    if (seenUrn.has(leadUrn)) continue;
    seenUrn.add(leadUrn);

    // Synthetic stable post_url for DB dedup. Real lead URL + a snippet hash
    // so the same lead's distinct posts (across different digests) get
    // distinct rows. The user-clickable /comm redirect is stashed in
    // raw_meta.click_url — the dashboard prefers that for the "Open post"
    // button since it takes them straight to the lead's Sales Nav profile.
    const hashSrc = (snippet || author_name).slice(0, 120);
    const hash = crypto.createHash('sha1').update(hashSrc).digest('hex').slice(0, 10);
    const post_url = `https://www.linkedin.com/sales/lead/${leadUrn}#post-${hash}`;

    items.push({
      author_name,
      author_title,
      author_company,
      author_linkedin_url: null, // digest doesn't include the public /in/ URL
      post_url,
      post_snippet: snippet || null,
      post_type,
      raw_meta: {
        subject,
        from,
        template: 'in_case_you_missed_it_digest',
        lead_urn: leadUrn,
        click_url: clickUrl,
      },
    });
  }

  return items;
}

// Heuristic split: LinkedIn digest emails use a repeating <table> block per
// item. We split on post-URL occurrences and walk outward ~2000 chars to grab
// the surrounding context (name + snippet) for each one.
export function parseSalesNavDigest({ html, subject = '', from = '' } = {}) {
  if (!html || typeof html !== 'string') return [];

  // Dispatch: the "in case you missed it" daily digest has its own structure
  // and its own extractor. Detect via the template slug LinkedIn embeds in
  // every tracking URL.
  if (/email_lss_in_case_you_missed_it_digest|entities-digest-container/.test(html)) {
    const items = extractInCaseYouMissedItItems(html, subject, from);
    if (items.length > 0) return items;
    // Fall through to legacy extractor if structured parse came back empty
    // (template may have shifted — keep the safety net).
  }

  // Saved-search new-leads digest (email_lss_search_alert_queues_email):
  // contains headline+location for matched leads but no post URLs. Nothing
  // for the commenter to act on — skip cleanly so we don't log a warning.
  if (/email_lss_search_alert_queues_email/.test(html)) {
    return [];
  }

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

// Gmail IMAP poller for Sales Navigator digest emails.
//
// Reads every unseen message tagged with the Gmail label "Presence" (configurable
// via GMAIL_IMAP_LABEL). For each one we hand the raw HTML + subject + from-header
// to the Sales Nav parser, upsert each extracted post into presence_posts, and
// mark the email as Seen so we don't re-parse it on the next poll.
//
// Access path: IMAP + Google App Password. Required env:
//   GMAIL_IMAP_USER     = kai.passo@ambition.com
//   GMAIL_IMAP_PASSWORD = 16-char app password (no spaces)
//   GMAIL_IMAP_LABEL    = Presence  (optional, default)
//
// Gmail IMAP maps labels to IMAP "mailboxes", so selecting the label name as
// the mailbox is all we need — no folder math, no extensions required.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseSalesNavDigest } from '../lib/sales_nav_parser.js';
import { upsertPresencePost } from '../db/presence.js';

function client() {
  const user = process.env.GMAIL_IMAP_USER;
  const pass = process.env.GMAIL_IMAP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      '[gmail_imap] GMAIL_IMAP_USER and GMAIL_IMAP_PASSWORD must be set. ' +
      'Generate an app password at https://myaccount.google.com/apppasswords'
    );
  }
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

/**
 * Pull new Sales Nav digests and ingest every post. Idempotent: already-seen
 * emails are skipped by the IMAP \Seen flag; already-stored posts dedup on
 * post_url at the DB layer.
 *
 * Returns { emails_seen, posts_upserted, posts_new, errors }.
 */
export async function pollPresenceInbox({ markSeen = true, dryRun = false } = {}) {
  const label = process.env.GMAIL_IMAP_LABEL || 'Presence';
  const imap = client();
  const stats = { emails_seen: 0, posts_upserted: 0, posts_new: 0, errors: [] };

  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(label);
    try {
      // Unseen messages only. Gmail applies the label when our filter fires,
      // so this loop only iterates new Sales Nav digests.
      const unseen = await imap.search({ seen: false });
      if (!unseen || unseen.length === 0) {
        console.log(`[gmail_imap] no unseen messages in "${label}"`);
        return stats;
      }
      console.log(`[gmail_imap] ${unseen.length} unseen in "${label}"`);

      for (const uid of unseen) {
        stats.emails_seen++;
        try {
          const { source } = await imap.fetchOne(uid, { source: true }, { uid: true });
          const parsed = await simpleParser(source);
          const html = parsed.html || parsed.textAsHtml || parsed.text || '';
          const subject = parsed.subject || '';
          const from = parsed.from?.text || '';
          const messageId = parsed.messageId || `uid:${uid}`;

          const posts = parseSalesNavDigest({ html, subject, from });
          console.log(`[gmail_imap] uid=${uid} "${subject}" → ${posts.length} post(s)`);

          if (dryRun) continue;

          for (const p of posts) {
            try {
              const row = await upsertPresencePost({ ...p, source_email_id: messageId });
              stats.posts_upserted++;
              if (row.inserted) stats.posts_new++;
            } catch (err) {
              stats.errors.push(`upsert ${p.post_url}: ${err.message}`);
              console.error(`[gmail_imap] upsert failed:`, err.message);
            }
          }

          if (markSeen && !dryRun) {
            await imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          }
        } catch (err) {
          stats.errors.push(`uid ${uid}: ${err.message}`);
          console.error(`[gmail_imap] failed uid=${uid}:`, err.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
  console.log(`[gmail_imap] DONE emails=${stats.emails_seen} posts_upserted=${stats.posts_upserted} new=${stats.posts_new} errors=${stats.errors.length}`);
  return stats;
}

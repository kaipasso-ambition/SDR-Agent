// Gmail integration stub.
// Uses googleapis with OAuth refresh-token flow. Real send + reply polling
// to be completed once Gmail OAuth app is registered.

import { google } from 'googleapis';
import 'dotenv/config';

function getClient() {
  const {
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN,
  } = process.env;

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

/**
 * Fetch inbox replies that have not yet been classified by the reply agent.
 * Expected shape: { prospect_id, thread_id, message_id, from, subject, body }
 */
export async function getUnprocessedReplies() {
  const gmail = getClient();
  if (!gmail) {
    console.warn('[gmail] Not configured — returning []');
    return [];
  }

  // TODO: query for unread replies in the SDR inbox, cross-reference
  // thread IDs against sent_messages to resolve prospect_id, then return
  // structured objects for the reply agent.
  return [];
}

/**
 * Send an approved outreach or reply message through Gmail.
 */
export async function sendMessage({ to, subject, body, threadId = null }) {
  const gmail = getClient();
  if (!gmail) {
    throw new Error('Gmail not configured');
  }

  const raw = Buffer.from(
    [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ].join('\r\n')
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: threadId ? { raw, threadId } : { raw },
  });

  return res.data;
}

export async function markReplyProcessed(messageId) {
  const gmail = getClient();
  if (!gmail) return;
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

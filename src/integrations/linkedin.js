// LinkedIn automation via PhantomBuster.
// Touch 3 sequences are queued here for manual or automated send.

import 'dotenv/config';

const BASE_URL = 'https://api.phantombuster.com/api/v2';

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Phantombuster-Key': process.env.PHANTOMBUSTER_API_KEY || '',
  };
}

/**
 * Queue a LinkedIn connection request / message via PhantomBuster.
 * @param {{ profileUrl: string, message: string }} params
 */
export async function queueLinkedinMessage({ profileUrl, message }) {
  if (!process.env.PHANTOMBUSTER_API_KEY) {
    console.warn('[linkedin] PhantomBuster not configured — skipping');
    return { queued: false };
  }

  // TODO: Launch the configured phantom agent with { profileUrl, message }.
  // Implementation depends on which phantom is being used (LinkedIn Message Sender,
  // Connection Request Sender, etc.). Leaving this as a typed stub.
  void profileUrl;
  void message;
  return { queued: true };
}

export async function getPhantomRunStatus(runId) {
  if (!process.env.PHANTOMBUSTER_API_KEY) return null;
  const res = await fetch(`${BASE_URL}/agents/fetch-output?id=${runId}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`PhantomBuster ${res.status}`);
  return res.json();
}

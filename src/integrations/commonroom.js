// CommonRoom intent signal polling.

import 'dotenv/config';

const BASE_URL = 'https://api.commonroom.io/community/v1';

/**
 * Pull recent intent signals keyed by company domain.
 * Expected output: [{ domain, signal_type, signal_strength, observed_at, raw }]
 */
export async function getIntentSignals() {
  const { COMMONROOM_API_KEY, COMMONROOM_WORKSPACE } = process.env;
  if (!COMMONROOM_API_KEY || !COMMONROOM_WORKSPACE) {
    console.warn('[commonroom] Not configured — returning []');
    return [];
  }

  // TODO: replace with real signals endpoint. CommonRoom's API surface varies
  // by plan; this stub returns [] so cycles still run end-to-end.
  try {
    const res = await fetch(
      `${BASE_URL}/${COMMONROOM_WORKSPACE}/signals?limit=100`,
      {
        headers: {
          Authorization: `Bearer ${COMMONROOM_API_KEY}`,
        },
      }
    );
    if (!res.ok) {
      console.warn(`[commonroom] ${res.status} ${res.statusText}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.signals) ? data.signals : [];
  } catch (err) {
    console.error('[commonroom] fetch error:', err.message);
    return [];
  }
}

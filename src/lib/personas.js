// Target-persona definitions for the whitespace map on customer accounts.
//
// Narrowly scoped to the May 15 Performance Graph launch: the two roles the
// product is actually pitched at. Other personas exist in the outreach
// prompt (VP Sales, CRO, etc.) and may get their own coverage grid later —
// for now, keep the map focused so the AE sees the gap that matters this
// quarter instead of a sea of yellow cells.
//
// Matching is regex-first, title-string-based. includeRe → you're in the
// bucket. excludeRe → overrides include; e.g. "Regional Sales Manager" is
// Frontline, but "Regional Sales Manager, Enterprise" is NOT because the
// launch isn't pitched at enterprise-segment managers.

export const COVERAGE_FRESHNESS_DAYS = 60;

export const PERSONAS = [
  {
    id: 'frontline_manager',
    label: 'Frontline Manager',
    short: 'Mgr',
    // SMB / Commercial / SDR segment managers — the day-to-day Performance
    // Graph user. Intentionally excludes enterprise / strategic / named /
    // major-accounts tiers (different buying motion, different pitch).
    includeRe: /(sales\s+manager|regional\s+sales\s+manager|district\s+sales\s+manager|area\s+sales\s+manager|team\s+lead|sales\s+team\s+lead|inside\s+sales\s+manager|commercial\s+sales\s+manager|smb\s+sales\s+manager|sdr\s+manager|sdr\s+director|bdr\s+manager|bdr\s+director|mid[\s-]*market\s+sales\s+manager)/i,
    excludeRe: /(enterprise|strategic|major\s+accounts|key\s+accounts|named\s+accounts|vp\s+of\s+strategic)/i,
    // Why we care — shown in the UI tooltip / description.
    why: 'Day-to-day user of the Performance Graph. Coach from unified call + deal + methodology data instead of spreadsheets.',
  },
  {
    id: 'revops',
    label: 'RevOps / Ops Leader',
    short: 'Ops',
    // Broad operational-buyer bucket: RevOps, Revenue Enablement, Sales
    // Enablement, SDR leadership, Sales Strategy. Same pitch ("fits your
    // stack, managers will actually use it"), so we lump them.
    includeRe: /(rev\s*ops|revenue\s+operations|revenue\s+enablement|sales\s+enablement|sales\s+operations|sales\s+ops|gtm\s+ops|go[\s-]*to[\s-]*market\s+ops|sales\s+strategy|sdr\s+director|head\s+of\s+revenue\s+operations|director\s+of\s+revenue\s+operations|vp\s+of\s+revenue\s+operations|vp\s+revops|director\s+revops)/i,
    excludeRe: null,
    why: 'Technical evaluator — decides if the Performance Graph fits the stack. Adoption story is the unlock.',
  },
];

// Match a single title string to one persona (first hit wins). Returns null
// if it doesn't fit either bucket — those contacts still exist, they just
// don't count toward the launch-readiness coverage.
export function matchPersona(title) {
  if (!title || typeof title !== 'string') return null;
  const t = title.trim();
  if (!t) return null;
  for (const p of PERSONAS) {
    if (p.excludeRe && p.excludeRe.test(t)) continue;
    if (p.includeRe.test(t)) return p.id;
  }
  return null;
}

// Coverage state — drives the cell color and the CTA.
//   covered    — replied, OR contacted within the freshness window
//   stale      — contacted but not within the freshness window (needs a nudge)
//   researched — we have the contact in prospects, not contacted yet
//   gap        — no contact at all in this persona for this account
export function coverageState({ lastContactedAt, lastReplyAt, researched }) {
  if (lastReplyAt) return 'covered';
  if (lastContactedAt) {
    const ageDays = (Date.now() - new Date(lastContactedAt).getTime()) / 86400000;
    return ageDays <= COVERAGE_FRESHNESS_DAYS ? 'covered' : 'stale';
  }
  if (researched) return 'researched';
  return 'gap';
}

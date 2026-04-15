// Industry lexicon — maps a free-text `accounts_registry.industry` value
// onto the vocabulary that industry actually uses, so plays and
// artifacts don't sound like a SaaS consultant parachuting in. A
// transportation account doesn't have "AEs" — they have brokers. A
// staffing account doesn't have "pipeline" — they have a book.
//
// Used by play_builder (for move scripting + stakeholder narratives)
// and — optionally — by signal_analysis.so_what. Positioning module
// remains industry-agnostic (Performance Graph / GTM Governance are
// our nouns, not theirs); this module handles THEIR nouns.
//
// matchIndustryLexicon(industryString) is fuzzy — AE-entered industry
// fields are a wild west. We match by keyword hits against each
// lexicon's matchers and fall back to SAAS_DEFAULT.

const LEXICONS = {
  transportation: {
    label: 'Transportation & Logistics',
    matchers: [/transport/i, /logistic/i, /freight/i, /trucking/i, /3pl/i, /brokerage/i, /carrier/i, /shipper/i],
    seller_noun: 'broker',
    seller_plural: 'brokers',
    manager_noun: 'brokerage manager',
    team_noun: 'desk',
    leader_noun: 'VP of Brokerage',
    pipeline_noun: 'load board',
    deal_noun: 'load',
    quota_noun: 'margin target',
    coaching_noun: 'desk reviews',
    misc_notes: 'Talk in terms of load margin, carrier relationships, rep productivity per desk. Avoid "pipeline," "deal," "quota" — use "book," "load," "margin target." Performance conversations center on GP per broker and broker ramp time.',
  },
  insurance: {
    label: 'Insurance',
    matchers: [/insur/i, /underwrit/i, /broker(?!age)/i, /carrier.*insur/i, /mga/i, /agenc/i],
    seller_noun: 'producer',
    seller_plural: 'producers',
    manager_noun: 'agency principal',
    team_noun: 'agency',
    leader_noun: 'VP of Distribution',
    pipeline_noun: 'book of business',
    deal_noun: 'policy',
    quota_noun: 'written premium target',
    coaching_noun: 'producer ride-alongs',
    misc_notes: 'Talk in terms of producers, book of business, retention, renewal cycle, written premium. Avoid "AE," "pipeline," "ARR." Coaching = producer development and cross-sell motion.',
  },
  financial_services: {
    label: 'Financial Services',
    matchers: [/finance/i, /financial\s+service/i, /banking/i, /wealth/i, /advisor/i, /asset\s+manage/i, /capital\s+market/i],
    seller_noun: 'advisor',
    seller_plural: 'advisors',
    manager_noun: 'branch manager',
    team_noun: 'branch',
    leader_noun: 'Head of Distribution',
    pipeline_noun: 'book of business',
    deal_noun: 'account',
    quota_noun: 'AUM growth target',
    coaching_noun: 'advisor development',
    misc_notes: 'Advisors, branches, AUM, net new households, retention. Avoid "reps," "deals," "ARR." Coaching emphasizes client meetings and planning quality, not activity volume.',
  },
  real_estate: {
    label: 'Real Estate',
    matchers: [/real\s+estate/i, /proptech/i, /brokerage/i, /realty/i, /realtor/i, /property\s+manage/i],
    seller_noun: 'agent',
    seller_plural: 'agents',
    manager_noun: 'team lead',
    team_noun: 'team',
    leader_noun: 'Managing Broker',
    pipeline_noun: 'pipeline',
    deal_noun: 'transaction',
    quota_noun: 'GCI target',
    coaching_noun: 'agent development',
    misc_notes: 'Agents, teams, transactions, GCI, listings, buyer leads. Avoid "AEs," "ARR." Activity measured in appointments, showings, offers.',
  },
  staffing: {
    label: 'Staffing & Recruiting',
    matchers: [/staffing/i, /recruit/i, /talent\s+acquisition/i, /executive\s+search/i, /rpo/i],
    seller_noun: 'recruiter',
    seller_plural: 'recruiters',
    manager_noun: 'practice lead',
    team_noun: 'desk',
    leader_noun: 'Managing Director',
    pipeline_noun: 'req board',
    deal_noun: 'placement',
    quota_noun: 'spread target',
    coaching_noun: 'recruiter ride-alongs',
    misc_notes: 'Recruiters, desks, reqs, placements, spread, ramp. Avoid "AEs," "pipeline," "ARR." Activity centers on submittals, interviews, offers.',
  },
  healthcare: {
    label: 'Healthcare & Medical',
    matchers: [/health\s*care/i, /medical/i, /pharma/i, /medtech/i, /biotech/i, /provider\s+network/i, /payer/i],
    seller_noun: 'rep',
    seller_plural: 'reps',
    manager_noun: 'district manager',
    team_noun: 'territory',
    leader_noun: 'Regional Director',
    pipeline_noun: 'territory',
    deal_noun: 'account',
    quota_noun: 'territory quota',
    coaching_noun: 'field ride-alongs',
    misc_notes: 'Reps, territories, districts, field coverage, call plans, accounts. Highly regulated — messaging must be compliant, not pushy. Coaching often co-travel-based.',
  },
  manufacturing: {
    label: 'Manufacturing & Industrial',
    matchers: [/manufactur/i, /industrial/i, /machinery/i, /equipment/i, /fabric/i],
    seller_noun: 'territory manager',
    seller_plural: 'territory managers',
    manager_noun: 'regional sales manager',
    team_noun: 'region',
    leader_noun: 'VP of Sales',
    pipeline_noun: 'funnel',
    deal_noun: 'order',
    quota_noun: 'bookings target',
    coaching_noun: 'field coaching',
    misc_notes: 'Territory managers, channel partners, distributors, reorders, bookings. Long cycles, technical selling, heavy field presence.',
  },
  retail: {
    label: 'Retail & Commerce',
    matchers: [/retail/i, /ecommerce/i, /e-commerce/i, /d2c/i, /consumer\s+good/i, /cpg/i],
    seller_noun: 'store manager',
    seller_plural: 'store managers',
    manager_noun: 'district manager',
    team_noun: 'district',
    leader_noun: 'VP of Stores',
    pipeline_noun: 'conversion funnel',
    deal_noun: 'transaction',
    quota_noun: 'store target',
    coaching_noun: 'store walk-throughs',
    misc_notes: 'Store managers, districts, conversion, attach rate, NPS. Activity measured at the associate/manager level, not individual reps.',
  },
};

// The fallback — used when no industry matcher hits. Deliberately uses
// modern SaaS vocabulary since that's Ambition's native customer shape.
const SAAS_DEFAULT = {
  label: 'SaaS / Technology (default)',
  matchers: [],
  seller_noun: 'AE',
  seller_plural: 'AEs',
  manager_noun: 'frontline manager',
  team_noun: 'team',
  leader_noun: 'CRO',
  pipeline_noun: 'pipeline',
  deal_noun: 'deal',
  quota_noun: 'quota',
  coaching_noun: 'coaching',
  misc_notes: 'Standard SaaS vernacular. AEs, SDRs, pipeline, ARR, quota, bookings, managers. If the account is clearly not in this category the lexicon resolver should have swapped in a better match.',
};

// Fuzzy-match a free-text industry string to a lexicon. First matcher
// that hits wins; SAAS_DEFAULT if nothing does. Kept deliberately simple
// — if the AE has set a detailed industry string we pick the right one;
// if they've left it blank or set something weird, we don't invent.
export function matchIndustryLexicon(industryString) {
  if (!industryString || typeof industryString !== 'string') {
    return { key: 'saas_default', ...SAAS_DEFAULT };
  }
  for (const [key, lex] of Object.entries(LEXICONS)) {
    if (lex.matchers.some((re) => re.test(industryString))) {
      return { key, ...lex };
    }
  }
  return { key: 'saas_default', ...SAAS_DEFAULT };
}

// Render a prompt-appendable lexicon block. The play_builder (and
// optionally signal_analysis) can paste this into the model's
// instructions so generated moves, artifacts, and stakeholder
// narratives use the right industry vocabulary.
export function applyIndustryLexicon(industryString) {
  const lex = matchIndustryLexicon(industryString);
  return `
INDUSTRY LEXICON — this account is in: ${lex.label}${industryString ? ` ("${industryString}")` : ''}.

When writing any champion-facing artifact, stakeholder narrative, or move ask, use the vocabulary THIS industry actually uses. Do not paste generic SaaS vernacular into a ${lex.label} conversation.

Vocabulary map:
- seller (the person who sells): ${lex.seller_noun} (plural: ${lex.seller_plural})
- frontline manager: ${lex.manager_noun}
- team unit: ${lex.team_noun}
- senior revenue leader: ${lex.leader_noun}
- pipeline / work queue: ${lex.pipeline_noun}
- deal / transaction: ${lex.deal_noun}
- quota / target: ${lex.quota_noun}
- coaching activity: ${lex.coaching_noun}

Notes: ${lex.misc_notes}

If the contact's title uses a different word than the mapping suggests (e.g. an "Account Executive" at a logistics company), PREFER the title they actually hold over the lexicon default — the lexicon is a fallback, not a rewrite rule.
`.trim();
}

export { LEXICONS, SAAS_DEFAULT };

// Seed demo data so the Drafts and Replies pages have something real-looking
// to interact with before any integrations are wired up.
//
// Creates:
//   - 2 demo prospects (a logistics VP of Sales Ops, a SaaS Director of RevOps)
//   - 2 matching 3-touch outreach sequences in approval_queue (status=pending)
//   - 1 sample inbound reply in reply_queue (status=pending)
//
// Uses fixed demo IDs so the script is idempotent — re-running replaces the
// demo rows instead of duplicating them. Real prospects (different IDs) are
// never touched.
//
// Usage:
//   DATABASE_URL="postgres://..." node scripts/seed_demo.js
//
// To remove demo data later:
//   DATABASE_URL="postgres://..." node scripts/seed_demo.js --clean

import 'dotenv/config';
import { pool, query } from '../src/db/index.js';

const DEMO_PROSPECT_1 = '00000000-0000-4000-8000-00000000d001'; // logistics
const DEMO_PROSPECT_2 = '00000000-0000-4000-8000-00000000d002'; // saas
const DEMO_IDS = [DEMO_PROSPECT_1, DEMO_PROSPECT_2];

const prospects = [
  {
    id: DEMO_PROSPECT_1,
    company: 'Meridian Freight Solutions',
    domain: 'meridianfreight.com',
    contact_name: 'Marcus Thompson',
    contact_title: 'VP of Sales Operations',
    contact_email: 'marcus.thompson@meridianfreight.com',
    industry: 'logistics',
    persona: 'salesops',
    seniority: 'vp_plus',
    fit_score: 87,
    timing_signal: 'Hired 8 branch managers across the Midwest in the last 30 days',
    timing_signal_source: 'linkedin',
    customer_status: 'prospect',
    sales_headcount_estimate: '120–150',
    headcount_confidence: 'high',
    additional_context:
      'Mid-sized freight broker, 14 branches. CRO mentioned "manager visibility" as a 2026 priority on the Q4 earnings call. Running SAP TM + Salesforce.',
  },
  {
    id: DEMO_PROSPECT_2,
    company: 'Pivotal SaaS Analytics',
    domain: 'pivotalsaas.io',
    contact_name: 'Jennifer Park',
    contact_title: 'Director of Revenue Operations',
    contact_email: 'jennifer.park@pivotalsaas.io',
    industry: 'saas',
    persona: 'revops',
    seniority: 'director',
    fit_score: 82,
    timing_signal: 'Closed $45M Series C last week; hiring a VP of Sales + 20 AEs',
    timing_signal_source: 'news',
    customer_status: 'prospect',
    sales_headcount_estimate: '60+',
    headcount_confidence: 'medium',
    additional_context:
      'Post-Series C scale-up. Known to use Salesforce + Gong + Clari. Jennifer has posted on LinkedIn twice about "the manager coaching layer" being underinvested.',
  },
];

const drafts = {
  [DEMO_PROSPECT_1]: {
    prospect_id: DEMO_PROSPECT_1,
    customer_status: 'prospect',
    persona: 'salesops',
    industry: 'logistics',
    fit_score: 87,
    fit_rationale: {
      persona_fit:
        'VP of Sales Operations at a mid-market freight broker; directly owns rep efficiency and branch manager visibility.',
      timing_signal:
        'Eight new branch managers added in 30 days means the coaching gap is fresh and top of mind.',
      message_rationale:
        'Lead with the manager-layer problem framed around margin per load; avoid product pitch.',
    },
    sequence: [
      {
        touch: 1,
        channel: 'email',
        subject: '8 new branch managers and the TMS visibility gap',
        body:
          "Noticed you've added eight branch managers across the Midwest in the last month. The pattern we see at brokers your size: the new managers end up coaching from TMS data that's a day behind, tracking margin per load in side spreadsheets, and reporting somewhere else again. Nothing connects.\n\nWorth a conversation about how a few other logistics ops teams are closing that gap?",
      },
      {
        touch: 2,
        channel: 'email',
        subject: 'Re: 8 new branch managers and the TMS visibility gap',
        body:
          "Following up on the note below. Your CRO flagged manager visibility as a 2026 priority on the Q4 call — makes sense given the branch expansion.\n\nHappy to share what two other freight brokers saw in the first 60 days after they fixed the data flow into the branch-manager layer. Let me know if that's useful.",
      },
      {
        touch: 3,
        channel: 'linkedin',
        subject: '',
        body:
          "Saw Meridian's branch-manager hiring push — impressive pace. Ambition built the performance graph specifically for this problem: real-time activity + coaching signals at the branch level, not exec dashboards. Open to a short conversation if it's useful?",
      },
    ],
  },
  [DEMO_PROSPECT_2]: {
    prospect_id: DEMO_PROSPECT_2,
    customer_status: 'prospect',
    persona: 'revops',
    industry: 'saas',
    fit_score: 82,
    fit_rationale: {
      persona_fit:
        'Director of RevOps at a Series C SaaS scale-up owning the GTM data stack — decision-maker for this category.',
      timing_signal:
        'Fresh Series C + 20-AE hiring plan means the manager layer is about to be the bottleneck.',
      message_rationale:
        'Reference her public LinkedIn posts about the coaching layer without being creepy; name the problem, not the product.',
    },
    sequence: [
      {
        touch: 1,
        channel: 'email',
        subject: 'Post-Series C scaling and the coaching layer',
        body:
          "Congrats on the Series C. Hiring a VP and 20 AEs in the same quarter usually surfaces the same problem at the sales-manager layer: the data is clean at the rep level and clean for the exec team, but the managers in the middle are coaching from lagging Salesforce views.\n\nOpen to comparing notes on how a few other post-C teams structured that layer?",
      },
      {
        touch: 2,
        channel: 'email',
        subject: 'Re: Post-Series C scaling and the coaching layer',
        body:
          'Circling back on the note below. Saw your post on LinkedIn about the coaching layer being underinvested — that matches what we hear from RevOps leaders at companies your stage.\n\nI can share the specific activity + pipeline signals other teams put in front of their managers in the first 90 days. Worth a conversation?',
      },
      {
        touch: 3,
        channel: 'linkedin',
        subject: '',
        body:
          "Your post on the manager-coaching layer stuck with me. Ambition built the performance graph for exactly that gap — real-time activity and coaching signals at the manager level, not another dashboard. Happy to share more if it's relevant.",
      },
    ],
  },
};

const demoReply = {
  prospect_id: DEMO_PROSPECT_1,
  original_reply:
    "Thanks for reaching out. You're right that we're feeling the new-branch-manager ramp pain — margin per load across the new branches is already 4% below our mature branches and we don't have great visibility into what the new GMs are actually doing day-to-day. We're locked in on SAP TM and I'm not looking to rip-and-replace anything. What exactly does Ambition layer on top of the TMS, and is there a way to see it without a long demo?",
  classification: 'interested',
  draft_response:
    "Appreciate the honest framing. The short version: Ambition doesn't replace anything in your TMS stack — it reads from it plus your Salesforce and LinkedIn activity, then puts a live branch-manager view on top (activity, pipeline, coaching flags). Happy to show you a two-minute recorded walkthrough before any live demo — want me to send it?",
  referral_draft: '',
  escalate: false,
  escalate_reason: '',
  notes: 'Marcus is engaged and pragmatic — do not overpitch on the response.',
};

async function upsertProspect(p) {
  const sql = `
    INSERT INTO prospects (
      id, company, domain, contact_name, contact_title, contact_email,
      industry, persona, seniority, fit_score, timing_signal, timing_signal_source,
      customer_status, sales_headcount_estimate, headcount_confidence,
      additional_context, researched_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12,
      $13, $14, $15, $16, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      company = EXCLUDED.company,
      fit_score = EXCLUDED.fit_score,
      timing_signal = EXCLUDED.timing_signal,
      additional_context = EXCLUDED.additional_context,
      researched_at = NOW();
  `;
  const v = [
    p.id, p.company, p.domain, p.contact_name, p.contact_title, p.contact_email,
    p.industry, p.persona, p.seniority, p.fit_score, p.timing_signal, p.timing_signal_source,
    p.customer_status, p.sales_headcount_estimate, p.headcount_confidence, p.additional_context,
  ];
  await query(sql, v);
}

async function clean() {
  await query(`DELETE FROM reply_queue WHERE prospect_id = ANY($1::uuid[]);`, [DEMO_IDS]);
  await query(`DELETE FROM approval_queue WHERE prospect_id = ANY($1::uuid[]);`, [DEMO_IDS]);
  await query(`DELETE FROM sequences WHERE prospect_id = ANY($1::uuid[]);`, [DEMO_IDS]);
  await query(`DELETE FROM prospects WHERE id = ANY($1::uuid[]);`, [DEMO_IDS]);
}

async function main() {
  const mode = process.argv.includes('--clean') ? 'clean' : 'seed';

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Pass it inline or put it in .env.');
    process.exit(1);
  }

  if (mode === 'clean') {
    await clean();
    console.log('Demo rows removed.');
    return;
  }

  // Wipe any previous demo rows so re-running is idempotent.
  await clean();

  for (const p of prospects) {
    await upsertProspect(p);
  }

  for (const id of DEMO_IDS) {
    await query(
      `INSERT INTO approval_queue (prospect_id, draft, status)
       VALUES ($1, $2::jsonb, 'pending');`,
      [id, JSON.stringify(drafts[id])]
    );
  }

  await query(
    `INSERT INTO reply_queue (
       prospect_id, original_reply, classification, draft_response,
       referral_draft, escalate, escalate_reason, notes, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending');`,
    [
      demoReply.prospect_id,
      demoReply.original_reply,
      demoReply.classification,
      demoReply.draft_response,
      demoReply.referral_draft,
      demoReply.escalate,
      demoReply.escalate_reason,
      demoReply.notes,
    ]
  );

  console.log('Seeded demo data:');
  console.log(`  - ${prospects.length} prospects`);
  console.log(`  - ${DEMO_IDS.length} pending drafts`);
  console.log(`  - 1 pending reply`);
  console.log('\nLog in and check /drafts and /replies.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

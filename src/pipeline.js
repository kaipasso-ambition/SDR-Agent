// Research → draft pipeline for a single prospect.
//
// Same chain that the scheduled cron will run once Salesforce/PhantomBuster are
// wired: (a) call the research agent with Claude + web_search to find the best
// timing signal and score fit, (b) upsert the enriched prospect, (c) if it
// passes the fit threshold, call the writer agent to draft the 3-touch
// sequence, (d) drop into the owner's approval queue.
//
// Exposed as a function so the web UI can trigger it on-demand from the
// "Add prospect" form while we're waiting on Salesforce OAuth.

import { enrichProspect } from './agents/researcher.js';
import { generateSequence } from './agents/writer.js';
import { discoverCandidates } from './agents/discoverer.js';
import { getIntentSignals } from './integrations/commonroom.js';
import { upsertProspect } from './db/prospects.js';
import { addToApprovalQueue } from './queue/approval_queue.js';
import { getCampaignRoster, addProspectToCampaign } from './db/campaigns.js';
import { setMoveStatus } from './db/champions.js';
import { getAccountById } from './db/accounts_registry.js';
import { query } from './db/index.js';
import { PILOT_BATCH } from './lib/pilot_batch.js';
import { findOrCreateLaunchCampaign } from './lib/launch_campaign.js';
import { PERSONAS } from './lib/personas.js';

const MIN_FIT_TO_DRAFT = 60; // below this we save the prospect but skip drafting

export async function researchAndDraft({ company, domain, contact_name, owner_user_id }) {
  if (!company) throw new Error('company is required');

  const signals = await getIntentSignals(); // returns [] if CommonRoom not connected

  const rawAccount = {
    company,
    domain: domain || null,
    contact_name: contact_name || null,
  };

  // Step 1: research (Claude + web_search)
  const enriched = await enrichProspect(rawAccount, signals);

  // Step 2: persist the enriched prospect under the current user
  const prospect = await upsertProspect({ ...enriched, owner_user_id });

  // Step 3: decide whether to draft
  if (prospect.disqualified) {
    return { prospect, draft: null, reason: 'disqualified: ' + (prospect.disqualify_reason || 'unspecified') };
  }
  if ((prospect.fit_score ?? 0) < MIN_FIT_TO_DRAFT) {
    return { prospect, draft: null, reason: `fit_score ${prospect.fit_score} below threshold (${MIN_FIT_TO_DRAFT})` };
  }

  // Step 4: draft the sequence
  const draft = await generateSequence(prospect);
  await addToApprovalQueue({ prospect, draft, status: 'pending' });

  return { prospect, draft, reason: null };
}

/**
 * Autonomous discovery cycle: Claude surfaces net-new ICP candidates from
 * the web, then each one runs through the research → draft pipeline.
 * Triggered by the "Find new prospects" button, or on a schedule.
 *
 * Owner assignment: if owner_user_id is provided (button press), all new
 * prospects go to that user. If null (cron), owners round-robin across
 * active users.
 */
export async function runDiscoveryCycle({ count = 5, hint = '', owner_user_id = null, job_id = null } = {}) {
  console.log(`[discovery] START job=${job_id} count=${count} owner=${owner_user_id}`);

  const updateJob = async (fields) => {
    if (!job_id) return;
    const keys = Object.keys(fields);
    // diagnostics is jsonb — cast explicitly so pg doesn't reject a text value.
    const sets = keys.map((k, i) => {
      const cast = k === 'diagnostics' ? '::jsonb' : '';
      return `${k} = $${i + 2}${cast}`;
    }).join(', ');
    const values = keys.map((k) => {
      const v = fields[k];
      return k === 'diagnostics' && v && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    await query(`UPDATE discovery_jobs SET ${sets} WHERE id = $1`, [job_id, ...values]);
  };

  let candidates, diagnostics;
  try {
    const result = await discoverCandidates({ count, hint });
    candidates = result.candidates;
    diagnostics = result.diagnostics;
    await updateJob({ diagnostics });
  } catch (err) {
    console.error('[discovery] discoverer failed:', err.message);
    await updateJob({
      status: 'failed',
      error: err.message,
      finished_at: new Date(),
      diagnostics: { error: err.message, stack: err.stack?.slice(0, 1000) },
    });
    return { discovered: 0, drafted: 0, error: err.message };
  }
  console.log(`[discovery] ${candidates.length} candidates cleared size filter:`,
    candidates.map((c) => `${c.company} (${c.signal_type})`).join(', ') || '(none)');

  if (candidates.length === 0) {
    await updateJob({
      status: 'completed',
      discovered_count: 0,
      drafted_count: 0,
      skipped_count: 0,
      finished_at: new Date(),
    });
    return { discovered: 0, drafted: 0, skipped: 0, error: null };
  }

  // Dedup: drop any candidate whose domain we already have.
  const domains = candidates.map((c) => c.domain).filter(Boolean);
  const existing = domains.length
    ? (await query(
        `SELECT DISTINCT lower(domain) AS domain FROM prospects WHERE lower(domain) = ANY($1::text[])`,
        [domains.map((d) => d.toLowerCase())]
      )).rows.map((r) => r.domain)
    : [];
  const fresh = candidates.filter(
    (c) => c.domain && !existing.includes(c.domain.toLowerCase())
  );
  console.log(`[discovery] ${fresh.length} new after dedup`);

  // Round-robin owner if not specified (cron case).
  let ownerCycle = [];
  if (!owner_user_id) {
    const { rows } = await query(`SELECT id FROM users ORDER BY created_at ASC`);
    ownerCycle = rows.map((r) => r.id);
  }

  let drafted = 0;
  let skipped = 0;
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    const owner = owner_user_id || ownerCycle[i % (ownerCycle.length || 1)] || null;
    try {
      const result = await researchAndDraft({
        company: c.company,
        domain: c.domain,
        owner_user_id: owner,
      });
      if (result.draft) {
        drafted++;
        console.log(`[discovery] drafted ${c.company}`);
      } else {
        skipped++;
        console.log(`[discovery] saved-no-draft ${c.company}: ${result.reason}`);
      }
    } catch (err) {
      console.error(`[discovery] pipeline failed on ${c.company}:`, err.message);
    }
  }
  console.log(`[discovery] DONE job=${job_id} discovered=${fresh.length} drafted=${drafted} skipped=${skipped}`);
  await updateJob({
    status: 'completed',
    discovered_count: fresh.length,
    drafted_count: drafted,
    skipped_count: skipped,
    finished_at: new Date(),
  });
  return { discovered: fresh.length, drafted, skipped, error: null };
}

/**
 * Pilot batch: run the 10 hand-picked prospects through research+draft at
 * 5-concurrent parallelism. Owner routing is hard-coded by name on each row,
 * resolved to a user_id at runtime via a LIKE match on users.name.
 *
 * Writes progress into the same discovery_jobs row the regular /discover cycle
 * uses, so the running/stuck/completed banner in layout.ejs works unchanged.
 */
export async function runPilotBatch({ job_id = null, limit = null, indices = null } = {}) {
  // Selection priority: explicit `indices` > legacy `limit` (top-N slice) >
  // full batch. `indices` lets the operator cherry-pick specific rows via
  // checkboxes; `limit` is kept for backward compat with any old links.
  let activeBatch;
  if (Array.isArray(indices) && indices.length > 0) {
    const clean = [...new Set(indices)]
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < PILOT_BATCH.length);
    activeBatch = clean.map((i) => PILOT_BATCH[i]);
  } else if (limit && limit > 0 && limit < PILOT_BATCH.length) {
    activeBatch = PILOT_BATCH.slice(0, limit);
  } else {
    activeBatch = PILOT_BATCH;
  }

  console.log(`[pilot] START job=${job_id} batch_size=${activeBatch.length} (of ${PILOT_BATCH.length})`);

  const updateJob = async (fields) => {
    if (!job_id) return;
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => {
      const cast = k === 'diagnostics' ? '::jsonb' : '';
      return `${k} = $${i + 2}${cast}`;
    }).join(', ');
    const values = keys.map((k) => {
      const v = fields[k];
      return k === 'diagnostics' && v && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    await query(`UPDATE discovery_jobs SET ${sets} WHERE id = $1`, [job_id, ...values]);
  };

  // Resolve owner names → user ids once up front. If a match fails, skip those
  // rows with a clear error rather than silently assigning them to no-one.
  const uniqueOwners = [...new Set(activeBatch.map((p) => p.owner_name))];
  const ownerMap = {};
  for (const name of uniqueOwners) {
    const { rows } = await query(
      `SELECT id, name, email FROM users WHERE LOWER(name) LIKE $1 OR LOWER(email) LIKE $1 ORDER BY created_at ASC LIMIT 1`,
      [name.toLowerCase() + '%']
    );
    ownerMap[name] = rows[0] || null;
    console.log(`[pilot] owner "${name}" → ${rows[0] ? rows[0].email : 'NO MATCH'}`);
  }

  const resolved = activeBatch.map((p) => ({ ...p, owner: ownerMap[p.owner_name] }));
  const skippedForOwner = resolved.filter((p) => !p.owner);
  const runnable = resolved.filter((p) => p.owner);

  // Concurrency-limited worker pool. 5 parallel research+draft chains is
  // reasonable: each is Claude with web_search, and the Anthropic SDK will
  // queue requests at the HTTP layer if we exceed its per-connection limit.
  const CONCURRENCY = 5;
  const results = [];
  let idx = 0;

  const worker = async () => {
    while (idx < runnable.length) {
      const i = idx++;
      const pick = runnable[i];
      const label = `${pick.company} → ${pick.owner.email}`;
      const started = Date.now();
      try {
        const r = await researchAndDraft({
          company: pick.company,
          domain: pick.domain,
          owner_user_id: pick.owner.id,
        });
        const ms = Date.now() - started;
        results.push({
          company: pick.company,
          domain: pick.domain,
          owner: pick.owner.email,
          owner_name: pick.owner_name,
          drafted: !!r.draft,
          fit_score: r.prospect?.fit_score ?? null,
          reason: r.reason,
          disqualified: !!r.prospect?.disqualified,
          duration_ms: ms,
        });
        console.log(`[pilot] ${label} done in ${ms}ms — drafted=${!!r.draft} score=${r.prospect?.fit_score} reason=${r.reason || '-'}`);
      } catch (err) {
        results.push({
          company: pick.company,
          domain: pick.domain,
          owner: pick.owner.email,
          owner_name: pick.owner_name,
          drafted: false,
          fit_score: null,
          reason: 'pipeline error: ' + (err.message || 'unknown'),
          error: true,
          duration_ms: Date.now() - started,
        });
        console.error(`[pilot] ${label} failed:`, err.message);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, runnable.length) }, worker));

  for (const s of skippedForOwner) {
    results.push({
      company: s.company,
      owner_name: s.owner_name,
      drafted: false,
      fit_score: null,
      reason: `no user matched name "${s.owner_name}" — create that account and re-run`,
      error: true,
    });
  }

  const drafted = results.filter((r) => r.drafted).length;
  const skipped = results.filter((r) => !r.drafted && !r.error).length;
  const errored = results.filter((r) => r.error).length;

  console.log(`[pilot] DONE job=${job_id} drafted=${drafted} skipped=${skipped} errored=${errored}`);

  await updateJob({
    status: 'completed',
    discovered_count: runnable.length,
    drafted_count: drafted,
    skipped_count: skipped + errored,
    finished_at: new Date(),
    diagnostics: {
      pilot_batch: true,
      // Preserve pilot_indices so the /prospects/import page can show the
      // actual rows that ran (for the "last pilot run" section too).
      pilot_indices: Array.isArray(indices) && indices.length > 0 ? indices : null,
      batch_size: activeBatch.length,
      full_batch_size: PILOT_BATCH.length,
      limit_applied: limit ?? null,
      concurrency: CONCURRENCY,
      results,
    },
  });

  return { total: activeBatch.length, drafted, skipped, errored, results };
}

/**
 * Draft a champion-reconnect sequence for a detected job move. Skips the
 * research agent entirely — we already know who the person is and where
 * they've landed. We synthesize a minimal prospect record, upsert it,
 * generate the sequence with customer_status='champion_reconnect', queue
 * the draft, and flip the move row to 'drafted'.
 *
 * `move` is a row from champion_moves joined with its champion. Returns the
 * approval_queue row on success, or { skipped: reason } when we decline.
 */
export async function draftChampionReconnect(move) {
  if (move.routing === 'skip' || move.routing === 'internal_customer') {
    return { skipped: `routing=${move.routing}` };
  }
  if (!move.to_company) {
    return { skipped: 'no to_company on move row' };
  }

  // Pull the champion's relationship_owner as the draft owner so the
  // reconnect draft lands in the right person's queue.
  const { rows: champRows } = await query(
    `SELECT relationship_owner_user_id FROM champions WHERE id = $1`,
    [move.champion_id]
  );
  const owner_user_id = champRows[0]?.relationship_owner_user_id || null;

  const customer_status = move.routing === 'winback' ? 'winback' : 'champion_reconnect';

  // Synthesize a prospect record. fit_score is not researched here — we set
  // it to 75 ('warm, signal-verified by definition') so the drafts page
  // renders it alongside outbound drafts without re-scoring.
  const prospectSeed = {
    company: move.to_company,
    domain: move.to_domain || null,
    contact_name: move.full_name,
    contact_title: move.to_title || null,
    contact_email: move.email || null,
    industry: null,
    persona: null,
    seniority: null,
    fit_score: 75,
    timing_signal: `Champion moved: ${move.from_company || 'prior role'} → ${move.to_company}${move.to_title ? ' as ' + move.to_title : ''}`,
    timing_signal_source: move.source_url || null,
    customer_status,
    additional_context: move.one_line_context
      ? `Prior relationship with Ambition via ${move.from_company || 'previous role'}: ${move.one_line_context}`
      : `Prior relationship with Ambition via ${move.from_company || 'previous role'}.`,
    disqualified: false,
    owner_user_id,
  };

  const prospect = await upsertProspect(prospectSeed);
  const draft = await generateSequence(prospect);
  const queued = await addToApprovalQueue({ prospect, draft, status: 'pending' });

  // Link the move row to the spawned prospect and flip it to 'drafted' so
  // the /champions UI stops showing it as "new — needs action".
  await setMoveStatus(move.id, 'drafted', prospect.id);

  return { prospect, draft: queued, routing: move.routing };
}

// Draft a May-15-launch intro for a specific persona on a specific customer
// account. Used by the "Draft launch intro" button on the whitespace map.
//
// If we already have a researched prospect matching the persona on this
// account, we draft against that contact. If we don't (a "gap" cell), we
// synthesize a placeholder prospect seeded with just the account + persona
// — the writer's system prompt knows how to handle a thin prospect as long
// as the campaign context is rich, and the operator can fill in the actual
// contact name before sending from the approval queue.
export async function draftLaunchIntro({
  account_id,
  persona_id,
  prospect_id = null,
  owner_user_id = null,
}) {
  const persona = PERSONAS.find((p) => p.id === persona_id);
  if (!persona) throw new Error(`unknown persona: ${persona_id}`);

  const account = await getAccountById(account_id);
  if (!account) throw new Error('account not found');
  if (account.status !== 'customer') {
    return { skipped: `launch intros only apply to customer accounts (got ${account.status})` };
  }

  // Prefer an existing researched contact on this account if the caller
  // pointed us at one. Otherwise build a seed keyed on account + persona
  // so the writer can lead with the feedback/input framing.
  let prospect;
  if (prospect_id) {
    const { rows } = await query(`SELECT * FROM prospects WHERE id = $1`, [prospect_id]);
    prospect = rows[0];
    if (!prospect) throw new Error('prospect not found');
  } else {
    prospect = await upsertProspect({
      company: account.account_name,
      domain: account.domain,
      contact_name: null,
      contact_title: persona.label,
      contact_email: null,
      industry: account.industry || null,
      // Use the existing outreach-prompt persona vocabulary so the writer
      // recognizes it without a schema change. Frontline Mgr maps to the
      // existing 'salesleader' bucket; RevOps stays 'revops'.
      persona: persona.id === 'frontline_manager' ? 'salesleader' : 'revops',
      seniority: persona.id === 'frontline_manager' ? 'manager' : 'director',
      fit_score: 80, // customer = warm by definition
      customer_status: 'customer',
      timing_signal: 'Performance Graph launch (May 15) + CEO Gartner CSO Summit roundtable',
      timing_signal_source: null,
      additional_context: `Target persona: ${persona.label} — ${persona.why}`,
      disqualified: false,
      owner_user_id: owner_user_id || account.owner_user_id,
    });
  }

  const campaign = await findOrCreateLaunchCampaign(owner_user_id || account.owner_user_id);
  await addProspectToCampaign(campaign.id, prospect.id);

  const draft = await generateSequence(prospect, {
    ...campaign,
    // Leave special_invite off by default — operator can flip it per
    // prospect from the campaign page once Gartner attendees are confirmed.
    special_invite_for_this_prospect: false,
  });

  const queued = await addToApprovalQueue({
    prospect,
    draft,
    status: 'pending',
    campaign_id: campaign.id,
  });

  return { prospect, draft: queued, campaign };
}

/**
 * Generate campaign-tailored drafts for every prospect on the campaign roster.
 * Skips research (Marketing already did the ICP work) and skips prospects
 * that already have a pending draft for this campaign.
 */
export async function draftForCampaign(campaign) {
  const roster = await getCampaignRoster(campaign.id);
  let drafted = 0;
  let skipped = 0;

  for (const prospect of roster) {
    if (prospect.draft_count > 0) {
      skipped++;
      continue; // already has a draft in this campaign
    }
    try {
      const draft = await generateSequence(prospect, {
        ...campaign,
        special_invite_for_this_prospect: prospect.special_invite,
      });
      await addToApprovalQueue({
        prospect,
        draft,
        status: 'pending',
        campaign_id: campaign.id,
      });
      drafted++;
      console.log(`[campaign ${campaign.name}] drafted ${prospect.company}`);
    } catch (err) {
      console.error(`[campaign ${campaign.name}] failed for ${prospect.company}:`, err.message);
    }
  }
  return { drafted, skipped };
}

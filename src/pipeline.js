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
import { getCampaignRoster } from './db/campaigns.js';
import { query } from './db/index.js';
import { PILOT_BATCH } from './lib/pilot_batch.js';

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
export async function runPilotBatch({ job_id = null } = {}) {
  console.log(`[pilot] START job=${job_id} batch_size=${PILOT_BATCH.length}`);

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
  const uniqueOwners = [...new Set(PILOT_BATCH.map((p) => p.owner_name))];
  const ownerMap = {};
  for (const name of uniqueOwners) {
    const { rows } = await query(
      `SELECT id, name, email FROM users WHERE LOWER(name) LIKE $1 OR LOWER(email) LIKE $1 ORDER BY created_at ASC LIMIT 1`,
      [name.toLowerCase() + '%']
    );
    ownerMap[name] = rows[0] || null;
    console.log(`[pilot] owner "${name}" → ${rows[0] ? rows[0].email : 'NO MATCH'}`);
  }

  const resolved = PILOT_BATCH.map((p) => ({ ...p, owner: ownerMap[p.owner_name] }));
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
      batch_size: PILOT_BATCH.length,
      concurrency: CONCURRENCY,
      results,
    },
  });

  return { total: PILOT_BATCH.length, drafted, skipped, errored, results };
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

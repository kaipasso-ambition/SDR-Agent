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
import { getIntentSignals } from './integrations/commonroom.js';
import { upsertProspect } from './db/prospects.js';
import { addToApprovalQueue } from './queue/approval_queue.js';

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

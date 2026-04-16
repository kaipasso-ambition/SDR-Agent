-- Ambition SDR Agent schema
-- Usage: psql -U postgres -d ambition_sdr -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Prospects
CREATE TABLE IF NOT EXISTS prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company TEXT NOT NULL,
  domain TEXT,
  contact_name TEXT,
  contact_title TEXT,
  contact_email TEXT,
  industry TEXT,
  persona TEXT,
  seniority TEXT,
  fit_score INTEGER,
  timing_signal TEXT,
  timing_signal_source TEXT,
  customer_status TEXT DEFAULT 'prospect',
  sales_headcount_estimate TEXT,
  headcount_confidence TEXT,
  additional_context TEXT,
  disqualified BOOLEAN DEFAULT FALSE,
  disqualify_reason TEXT,
  researched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prospects_domain_idx ON prospects(domain);
CREATE INDEX IF NOT EXISTS prospects_fit_score_idx ON prospects(fit_score);

-- Per-user ownership (backfilled for existing rows as NULL = shared/legacy).
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS prospects_owner_idx ON prospects(owner_user_id);

-- Approval queue (outbound drafts)
CREATE TABLE IF NOT EXISTS approval_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  draft JSONB NOT NULL,
  status TEXT DEFAULT 'pending',
  reviewed_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS approval_queue_status_idx ON approval_queue(status);

-- Reply queue (inbound reply drafts)
CREATE TABLE IF NOT EXISTS reply_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  original_reply TEXT,
  classification TEXT,
  draft_response TEXT,
  referral_draft TEXT,
  escalate BOOLEAN DEFAULT FALSE,
  escalate_reason TEXT,
  notes TEXT,
  status TEXT DEFAULT 'pending',
  reviewed_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reply_queue_status_idx ON reply_queue(status);

-- Sequence state tracker
CREATE TABLE IF NOT EXISTS sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  current_touch INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  last_sent_at TIMESTAMPTZ,
  next_send_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sequences_prospect_idx ON sequences(prospect_id);
CREATE INDEX IF NOT EXISTS sequences_next_send_idx ON sequences(next_send_at);

-- Sent messages log
CREATE TABLE IF NOT EXISTS sent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  touch INTEGER,
  channel TEXT,
  subject TEXT,
  body TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  reply_received BOOLEAN DEFAULT FALSE,
  reply_received_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sent_messages_prospect_idx ON sent_messages(prospect_id);

-- Users (web UI logins)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- Session store for connect-pg-simple
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);

-- Idempotent guard: only add the PK if it isn't there yet
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Campaigns — themed outreach plays (events, product launches, ABM pushes).
-- Roster is provided by Marketing (or the operator); research/discovery is
-- skipped because the ICP work has already been done upstream.
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  goal TEXT,                              -- the CTA: "ask if attending Gartner"
  description TEXT,                       -- longer context fed to the writer
  event_date TIMESTAMPTZ,
  event_url TEXT,
  special_invite_description TEXT,        -- "invite to CEO's talk on ..." (null = no special invite)
  special_invite_capacity INTEGER,        -- cap on how many prospects can get the invite
  status TEXT NOT NULL DEFAULT 'active',  -- active | paused | completed
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS campaigns_owner_idx ON campaigns(owner_user_id);

-- Junction: which prospects belong to which campaigns, and whether each
-- prospect is flagged for the special invite (e.g., CEO talk). signal_*
-- fields record WHY this person was selected for this campaign so the
-- operator can judge quality and the writer can reference it in Touch 1.
CREATE TABLE IF NOT EXISTS campaign_prospects (
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  special_invite BOOLEAN DEFAULT FALSE,
  signal_type TEXT,          -- 'speaker' | 'attending' | 'icp_fit'
  signal_detail TEXT,        -- one-sentence why
  signal_source_url TEXT,    -- URL backing the signal
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (campaign_id, prospect_id)
);

-- Let draft rows know which campaign they belong to (NULL = generic outreach).
ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS approval_queue_campaign_idx ON approval_queue(campaign_id);

-- Discovery job tracker — persists across page navigations so the UI can
-- show progress from any page, not just the one that kicked it off.
CREATE TABLE IF NOT EXISTS discovery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',
  requested_count INTEGER,
  discovered_count INTEGER,
  drafted_count INTEGER,
  skipped_count INTEGER,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS discovery_jobs_user_idx ON discovery_jobs(user_id, started_at DESC);

-- Free-form diagnostics (stop_reason, raw Claude text preview, pre/post-filter
-- candidate lists) so we can see WHY a run ended with 0 drafts from the UI.
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS diagnostics JSONB;

-- Presence copilot: LinkedIn posts ingested from Sales Navigator email alerts.
-- One row per post, deduped by post_url. Ranker populates rank_score; commenter
-- populates draft_comment for the top ~10/day. Kai/Colin post manually.
CREATE TABLE IF NOT EXISTS presence_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_name TEXT NOT NULL,
  author_title TEXT,
  author_company TEXT,
  author_linkedin_url TEXT,
  post_url TEXT UNIQUE,
  post_snippet TEXT,
  post_type TEXT,                -- 'share' | 'job_change' | 'news_mention' | 'comment' | 'other'
  posted_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  rank_score NUMERIC,
  rank_reason TEXT,
  draft_comment TEXT,
  drafted_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'drafted' | 'posted' | 'skipped' | 'archived'
  thumbs TEXT,                   -- 'up' | 'down' | null
  feedback_note TEXT,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_email_id TEXT,          -- IMAP Message-ID for trace
  raw_meta JSONB
);
CREATE INDEX IF NOT EXISTS presence_posts_status_idx ON presence_posts(status);
CREATE INDEX IF NOT EXISTS presence_posts_received_idx ON presence_posts(received_at DESC);
CREATE INDEX IF NOT EXISTS presence_posts_rank_idx ON presence_posts(rank_score DESC NULLS LAST);

-- Presence refresh job tracker — mirrors discovery_jobs. Each manual click
-- of "Refresh now" inserts a row; the /presence view renders a banner from
-- the latest row so users see that a poll+rank is in flight (and stop
-- hammering the button). Cron-triggered polls don't create rows (they're
-- invisible background work).
CREATE TABLE IF NOT EXISTS presence_refresh_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'completed' | 'failed'
  emails_seen INTEGER DEFAULT 0,
  posts_upserted INTEGER DEFAULT 0,
  posts_new INTEGER DEFAULT 0,
  drafted INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  errored INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS presence_refresh_jobs_started_idx ON presence_refresh_jobs(started_at DESC);

-- ---------------------------------------------------------------------------
-- Champion tracker + account registry
-- ---------------------------------------------------------------------------
-- The Strategic-AE track: Ambition wants to follow champions across companies
-- (highest-converting warm-outbound signal per UserGems/Champify research —
-- job-change conversions run 3–5x cold). Sourced from three populations:
--   1. customer_champion — active champions at current Ambition customers
--   2. foa ("Friends of Ambition") — curated alumni / advocates list
--   3. churned_customer_contact — contacts at churned accounts (boomerang play)
--
-- accounts_registry gives us a lightweight account book so we can route
-- moves correctly: a champion landing at a live customer → internal note;
-- landing at a non-customer → warm outbound; churned contact re-signaling
-- at a churned account → win-back play.

CREATE TABLE IF NOT EXISTS accounts_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name TEXT NOT NULL,
  domain TEXT,
  status TEXT NOT NULL DEFAULT 'prospect',  -- customer | prospect | churned | disqualified
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_role TEXT,                          -- 'ae' | 'csm' | null
  industry TEXT,
  notes TEXT,
  last_signal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_registry_domain_unique
  ON accounts_registry(LOWER(domain)) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS accounts_registry_status_idx ON accounts_registry(status);

CREATE TABLE IF NOT EXISTS champions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT,
  linkedin_url TEXT,
  current_company TEXT,
  current_title TEXT,
  associated_account_domain TEXT,  -- loose FK to accounts_registry.domain (customer they came from)
  source TEXT DEFAULT 'customer_champion',  -- customer_champion | foa | churned_customer_contact
  tier TEXT,                       -- hot | warm | casual
  one_line_context TEXT,           -- e.g. "sponsored the 2024 SDR rollout"
  last_touch_date DATE,
  do_not_contact BOOLEAN DEFAULT FALSE,
  relationship_owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'tracking',  -- tracking | moved | acted | dormant
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS champions_status_idx ON champions(status);
CREATE INDEX IF NOT EXISTS champions_last_checked_idx ON champions(last_checked_at NULLS FIRST);
CREATE UNIQUE INDEX IF NOT EXISTS champions_linkedin_unique
  ON champions(LOWER(linkedin_url)) WHERE linkedin_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS champions_email_unique
  ON champions(LOWER(email)) WHERE email IS NOT NULL;

-- One row per detected job change. Lets us show "3 new moves this week" and
-- tracks which ones we've already acted on (drafted a reconnect) vs dismissed.
CREATE TABLE IF NOT EXISTS champion_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  champion_id UUID REFERENCES champions(id) ON DELETE CASCADE,
  from_company TEXT,
  to_company TEXT,
  to_title TEXT,
  to_domain TEXT,
  source_url TEXT,
  confidence TEXT,                 -- high | medium | low
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'new',       -- new | drafted | dismissed | acted
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  routing TEXT,                    -- warm_outbound | internal_customer | winback | skip
  notes TEXT
);
CREATE INDEX IF NOT EXISTS champion_moves_status_idx ON champion_moves(status);
CREATE INDEX IF NOT EXISTS champion_moves_champion_idx ON champion_moves(champion_id);

-- Champion-tracker job tracker — mirrors discovery_jobs so the UI can show a
-- "Checking N champions…" banner while the weekly (or manual) run is in flight.
CREATE TABLE IF NOT EXISTS champion_check_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',
  checked_count INTEGER DEFAULT 0,
  moves_detected INTEGER DEFAULT 0,
  drafts_created INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS champion_check_jobs_started_idx ON champion_check_jobs(started_at DESC);

-- ---------------------------------------------------------------------------
-- Account signal intelligence (Sprint 1: Pulse + Monday Brief)
-- ---------------------------------------------------------------------------
-- Weekly Claude+web_search scan per customer account. Each finding is
-- classified as defense_risk / offense_opportunity / neutral with severity
-- 1–5, deduped per account via dedup_key (so a reposted headline the next
-- week doesn't create a second row), and ranked by composite score
-- (risk_weight*10 + severity) then detected_at DESC in the /brief view.
--
-- Positioning guardrail: title + summary stay factual; so_what +
-- recommended_move use the Ambition 2.0 lexicon (see src/lib/positioning.js).

CREATE TABLE IF NOT EXISTS account_signal_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed
  accounts_scanned INTEGER DEFAULT 0,
  signals_detected INTEGER DEFAULT 0,
  signals_skipped_dedup INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS account_signal_jobs_started_idx ON account_signal_jobs(started_at DESC);

CREATE TABLE IF NOT EXISTS account_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts_registry(id) ON DELETE CASCADE,
  job_id UUID REFERENCES account_signal_jobs(id) ON DELETE SET NULL,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT,                            -- 'web_search' | 'manual' | 'ingest'
  signal_type TEXT,                       -- exec_move | restructure | earnings | product_launch | layoff | hiring | funding | partnership | consolidation_note | other
  risk_class TEXT NOT NULL CHECK (risk_class IN ('defense_risk', 'offense_opportunity', 'neutral')),
  severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  title TEXT NOT NULL,                    -- factual headline; NO positioning language
  summary TEXT,                           -- factual 1–2 sentences; NO positioning language
  so_what TEXT,                           -- interpretation — USES Ambition 2.0 lexicon
  recommended_move TEXT,                  -- one concrete next step — USES lexicon
  source_url TEXT,
  source_excerpt TEXT,
  dedup_key TEXT NOT NULL,                -- stable hash of (signal_type + canonical subject)
  status TEXT NOT NULL DEFAULT 'new',     -- new | acknowledged | playing | dismissed
  acknowledged_at TIMESTAMPTZ,
  raw_model_output JSONB,
  UNIQUE (account_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS account_signals_account_detected_idx
  ON account_signals(account_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS account_signals_rank_idx
  ON account_signals(status, risk_class, severity DESC, detected_at DESC);
CREATE INDEX IF NOT EXISTS account_signals_new_recent_idx
  ON account_signals(detected_at DESC) WHERE status = 'new';

-- Link a draft row back to the signal that prompted it, so the staging
-- page's "Draft outbound" CTA can be traced end-to-end and we can
-- transition the signal to status='playing' when the draft is produced.
ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS signal_id UUID
  REFERENCES account_signals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS approval_queue_signal_idx ON approval_queue(signal_id);

-- ============================================================================
-- Game Plan (Sprint 2 foundations)
--
-- Three tables modelling enterprise account navigation as chess:
--   1. account_contacts    — the pieces on the board (org chart + deal role)
--   2. account_hypotheses  — our current theory of the case (use case to sell)
--   3. account_plays       — the move sequence (instinct + AI expansion)
--
-- Schema-only for now; DB layer + UI + play_builder prompt ship next.
-- ============================================================================

-- People at the account with a deal role and stance. self-referencing
-- reports_to_contact_id makes it a tree (org chart). Can link to a
-- tracked champion if we already know them, or stand alone if freshly
-- placed by a signal mention.
CREATE TABLE IF NOT EXISTS account_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts_registry(id) ON DELETE CASCADE,
  champion_id UUID REFERENCES champions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  linkedin_url TEXT,
  -- Deal role in Miller-Heiman / Challenger terms. 'unknown' is the
  -- landing state for signal-mentioned contacts until the AE classifies.
  deal_role TEXT DEFAULT 'unknown' CHECK (deal_role IN (
    'economic_buyer', 'champion', 'coach', 'influencer',
    'blocker', 'user', 'unknown'
  )),
  -- Stance toward us specifically. Separate from deal_role because
  -- a blocker can still be neutral, and a champion can go cold.
  stance TEXT DEFAULT 'neutral' CHECK (stance IN (
    'hot', 'warm', 'neutral', 'cold', 'hostile'
  )),
  reports_to_contact_id UUID REFERENCES account_contacts(id) ON DELETE SET NULL,
  last_touchpoint_at TIMESTAMPTZ,
  last_touchpoint_type TEXT,  -- e.g. 'email_sent', 'reply_received', 'meeting'
  notes TEXT,
  source TEXT DEFAULT 'manual' CHECK (source IN (
    'manual', 'enrichment', 'signal_mention'
  )),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS account_contacts_account_idx
  ON account_contacts(account_id);
CREATE INDEX IF NOT EXISTS account_contacts_reports_to_idx
  ON account_contacts(reports_to_contact_id);
-- One contact per (account, linkedin_url) if LinkedIn is known — prevents
-- duplicate insertion when a signal re-mentions the same person.
CREATE UNIQUE INDEX IF NOT EXISTS account_contacts_account_linkedin_unique
  ON account_contacts(account_id, LOWER(linkedin_url))
  WHERE linkedin_url IS NOT NULL;

-- Our current theory of what to sell and why. An account can carry
-- multiple hypotheses (different angles for different personas). The
-- play chooses one.
CREATE TABLE IF NOT EXISTS account_hypotheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts_registry(id) ON DELETE CASCADE,
  -- Which Ambition capability this hypothesis maps to. Enum is
  -- deliberately small; messaging rides on narrative_hook, not on
  -- cutting the capability finer.
  use_case TEXT NOT NULL CHECK (use_case IN (
    'performance_graph', 'ascend_coaching', 'gtm_governance',
    'manager_enablement', 'rep_ramp', 'multi_team_rollup'
  )),
  -- Who we'd pitch this to. Mirrors PERSONAS in src/lib/personas.js
  -- (frontline_mgr | revops | cro_exec).
  target_persona_id TEXT NOT NULL,
  narrative_hook TEXT NOT NULL,
  -- Signals that support this theory. Array not FK-table because
  -- order doesn't matter and we want set semantics.
  evidence_signal_ids UUID[] DEFAULT ARRAY[]::UUID[],
  confidence INTEGER DEFAULT 3 CHECK (confidence BETWEEN 1 AND 5),
  status TEXT DEFAULT 'theory' CHECK (status IN ('theory', 'validated', 'disproven')),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS account_hypotheses_account_idx
  ON account_hypotheses(account_id);
CREATE INDEX IF NOT EXISTS account_hypotheses_status_idx
  ON account_hypotheses(status);

-- Three-beat narrative arc (Nasralla / Fluint): the story the champion
-- forwards internally — status quo pain, what "better" looks like, and
-- why us as the bridge. narrative_hook stays as the one-line headline;
-- this JSONB carries the structured arc. Nullable so existing hypotheses
-- don't need backfill.
ALTER TABLE account_hypotheses ADD COLUMN IF NOT EXISTS narrative JSONB;

-- The play artifact. Instinct + AI expansion + contact path. Status
-- lifecycle: drafting -> active -> (paused?) -> won|lost|abandoned.
-- triggered_by_signal_id and hypothesis_id are nullable so a play can
-- be composed freeform (no originating signal, no formal hypothesis
-- yet) — the AE's strategic thinking isn't always reactive.
CREATE TABLE IF NOT EXISTS account_plays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts_registry(id) ON DELETE CASCADE,
  hypothesis_id UUID REFERENCES account_hypotheses(id) ON DELETE SET NULL,
  triggered_by_signal_id UUID REFERENCES account_signals(id) ON DELETE SET NULL,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  instinct TEXT,
  -- Claude's expansion: {named_play, moves[], internal_ask, risks,
  -- positioning_hooks, ai_model_version}. JSONB so the schema of the
  -- expansion can evolve with prompt iteration without migrations.
  ai_expansion JSONB,
  -- Ordered list of contact_ids tracing the path through the org.
  -- Validation (contacts all belong to account_id) lives in the DB
  -- layer, not a DB constraint — constraints on array element FKs
  -- would require a trigger and aren't worth the complexity.
  contact_path UUID[] DEFAULT ARRAY[]::UUID[],
  status TEXT DEFAULT 'drafting' CHECK (status IN (
    'drafting', 'active', 'paused', 'won', 'lost', 'abandoned'
  )),
  next_action TEXT,
  next_action_due DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS account_plays_account_idx
  ON account_plays(account_id);
CREATE INDEX IF NOT EXISTS account_plays_status_idx
  ON account_plays(status);
CREATE INDEX IF NOT EXISTS account_plays_author_idx
  ON account_plays(author_user_id);
-- Surfaces "plays with a next action due this week" on the dashboard
-- without a full table scan.
CREATE INDEX IF NOT EXISTS account_plays_next_due_idx
  ON account_plays(next_action_due)
  WHERE status = 'active' AND next_action_due IS NOT NULL;

-- One-off events / campaigns the AE orchestrates across many accounts
-- at once — Gartner CSO Summit, a CVI dinner, a roadshow stop. These
-- are the moments where "the play" isn't scoped to one account at all;
-- it's a coordinating artifact with many account-level plays hanging
-- off it. Nullable event_id on account_plays lets a play belong to
-- an event OR stand alone.
CREATE TABLE IF NOT EXISTS play_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                  -- "Gartner CSO Summit 2026" | "CVI dinner — NYC, Apr 28"
  kind TEXT DEFAULT 'event' CHECK (kind IN (
    'event',       -- conference, dinner, roadshow stop
    'campaign',    -- themed outreach wave (e.g. May 15 launch)
    'one_off'      -- catch-all for the weird stuff
  )),
  event_date DATE,                     -- the date the event lands on (nullable for open-ended campaigns)
  location TEXT,                       -- "Orlando" | "NYC"
  description TEXT,                    -- free-form context for the prompt + the AE
  context JSONB,                       -- structured: {theme, sponsors, invite_list, ...}
  status TEXT DEFAULT 'planning' CHECK (status IN (
    'planning',    -- being set up
    'active',      -- in-flight, outreach going out
    'completed',   -- post-event
    'cancelled'
  )),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS play_events_status_idx ON play_events(status);
CREATE INDEX IF NOT EXISTS play_events_date_idx   ON play_events(event_date);

-- Attach a play to an event so /events can show all plays running for
-- Gartner / CVI-dinner / etc. as a single coordinated view. NULL =
-- account-play (default) — preserves existing semantics for all plays
-- already in the table.
ALTER TABLE account_plays ADD COLUMN IF NOT EXISTS event_id UUID
  REFERENCES play_events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS account_plays_event_idx ON account_plays(event_id)
  WHERE event_id IS NOT NULL;

-- Reference material the AE hands in when setting up an event — URLs
-- (session pages, sponsor lists, invite lists), pasted briefs. The
-- event_researcher agent walks these + web_search to build the
-- structured `context` payload above (theme, audience profile,
-- sessions, suggested angles, sources). research_status lets the
-- UI tell the AE whether a background research run is in flight.
ALTER TABLE play_events ADD COLUMN IF NOT EXISTS reference_links TEXT[] DEFAULT '{}';
ALTER TABLE play_events ADD COLUMN IF NOT EXISTS research_status TEXT DEFAULT 'none'
  CHECK (research_status IN ('none','pending','completed','failed'));
ALTER TABLE play_events ADD COLUMN IF NOT EXISTS research_error TEXT;
ALTER TABLE play_events ADD COLUMN IF NOT EXISTS researched_at TIMESTAMPTZ;

-- Some events have a scarce "personal invite" moment we want to steward —
-- e.g. Travis is on stage at Gartner and the session has 40 seats, or
-- the CVI dinner has 12 seats. This column captures that slot so the
-- play composer can offer a multi-select against each account's
-- contact_path and the event view can tally "N of 40 seats promised."
--   shape: { title, speaker, session_time, seat_cap, notes, session_url }
ALTER TABLE play_events ADD COLUMN IF NOT EXISTS personal_invite_session JSONB;

-- Per-account play can mark which contacts on its path are being given
-- one of the event's limited-seat invites. Validated against the account's
-- own contacts in the route handler; we don't FK-constrain it because a
-- contact may legitimately be deleted later without breaking the play.
ALTER TABLE account_plays ADD COLUMN IF NOT EXISTS personal_invite_contact_ids UUID[] DEFAULT '{}';

-- Event targets — the people (not accounts) the AE wants to move at this
-- event. Two actions live against each row:
--   1. "Draft session invite" — a short pasteable invite from our
--      speaker's voice to earmark one of the limited seats at the
--      personal_invite_session.
--   2. "Draft meeting request" — a short note asking for a 20-min
--      exchange at the event.
-- account_id lets us link a target back to the book when the company
-- matches one of the AE's accounts; null when it's a net-new contact.
-- invite_draft / meeting_draft hold the most recent Claude-drafted copy
-- so the AE can reopen and tweak without re-paying the API call.
CREATE TABLE IF NOT EXISTS event_attendees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES play_events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  company TEXT,
  linkedin_url TEXT,
  email TEXT,
  account_id UUID REFERENCES accounts_registry(id) ON DELETE SET NULL,
  invite_status TEXT DEFAULT 'target' CHECK (invite_status IN (
    'target',    -- we want to reach them; no move yet
    'invited',   -- invite/meeting request sent
    'accepted',  -- they said yes
    'declined',  -- they said no
    'met',       -- face-to-face happened
    'passed'     -- we decided not to pursue (scarce seats)
  )),
  invite_draft TEXT,
  meeting_draft TEXT,
  notes TEXT,
  source TEXT DEFAULT 'manual' CHECK (source IN ('manual','paste','csv','linkedin','import')),
  added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS event_attendees_event_idx ON event_attendees(event_id);
CREATE INDEX IF NOT EXISTS event_attendees_account_idx ON event_attendees(account_id) WHERE account_id IS NOT NULL;

-- Follow-up tracking. When the AE clicks "Mark invited," we stamp
-- invited_at and set a default followup_due_at a few days out so the
-- attendee surfaces as "follow up with them" in the list until the AE
-- marks it done or snoozes.
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS invited_at         TIMESTAMPTZ;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS followup_due_at    TIMESTAMPTZ;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS followup_done_at   TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS event_attendees_followup_idx
  ON event_attendees(followup_due_at)
  WHERE followup_due_at IS NOT NULL AND followup_done_at IS NULL;

-- Integration credentials (stored after OAuth so users don't edit .env for these)
CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT UNIQUE NOT NULL, -- 'gmail' | 'salesforce' | 'commonroom'
  account_label TEXT,            -- e.g. 'kai@ambition.com'
  credentials JSONB NOT NULL,    -- access_token, refresh_token, expiry, etc.
  connected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- dead_deals: Closed Lost + Customer-Churned opportunities imported from
-- Salesforce. Each row is one lost/churned opportunity; an account can have
-- many (ConstructConnect tried 4 times). This is the input stream for the
-- /revisit queue — we reuse the signal_analyzer against these accounts to
-- detect what changed since we lost, and match against the original loss
-- reason + pain to suggest a re-entry angle.
--
-- Dedup key is opportunity_id (Salesforce 18-char ID). Re-running the import
-- monthly updates the row in place, never duplicates.
CREATE TABLE IF NOT EXISTS dead_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts_registry(id) ON DELETE CASCADE,
  opportunity_id TEXT UNIQUE NOT NULL,
  close_date DATE,
  loss_reason TEXT,                          -- "Bad Timing" / "Competitive" / "No Engagement" / "No budget: Budget not set aside"
  account_type_at_close TEXT,                -- 'Prospect' | 'Customer - Churned'
  owner_name TEXT,                           -- AE name from SF (Kai Passo, Mark McWatters)
  next_step TEXT,                            -- activity-note-y field, still useful context
  current_state_pains TEXT,
  business_technical_pains TEXT,
  champion_raw TEXT,                         -- free text; resolved to champions table later
  decision_criteria TEXT,
  decision_process TEXT,
  why_taking_call TEXT,
  why_now TEXT,
  why_ambition TEXT,
  foa_note TEXT,                             -- Friend of Ambition flag + relationship
  last_signal_scan_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dead_deals_account_idx ON dead_deals(account_id);
CREATE INDEX IF NOT EXISTS dead_deals_close_date_idx ON dead_deals(close_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS dead_deals_loss_reason_idx ON dead_deals(loss_reason);

-- Per-deal scan state, owned by the /revisit UI. One scan per deal at a time;
-- last_scan_result holds the most recent triggers as JSONB. If we ever need
-- scan history we add a separate dead_deal_scans table — for now keep it
-- inline so the list view can render last-result badges without a join.
ALTER TABLE dead_deals ADD COLUMN IF NOT EXISTS last_scan_status TEXT;        -- running | completed | failed | NULL
ALTER TABLE dead_deals ADD COLUMN IF NOT EXISTS last_scan_started_at TIMESTAMPTZ;
ALTER TABLE dead_deals ADD COLUMN IF NOT EXISTS last_scan_result JSONB;        -- array of triggers
ALTER TABLE dead_deals ADD COLUMN IF NOT EXISTS last_scan_searches INT;
ALTER TABLE dead_deals ADD COLUMN IF NOT EXISTS last_scan_error TEXT;

-- Revisit paths — three re-entry strategies per trigger, with projected
-- outcomes. The AE picks one; we store the selection + eventual outcome so
-- the prompt can learn from win/loss patterns over time.
CREATE TABLE IF NOT EXISTS revisit_paths (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  trigger_index INT NOT NULL,         -- index into dead_deals.last_scan_result[]
  trigger_title TEXT,                 -- snapshot so the card is readable even if re-scanned
  paths JSONB NOT NULL,               -- array of 3 path objects
  selected_path INT,                  -- 0|1|2 — which the AE chose
  outcome TEXT CHECK (outcome IN ('won','lost','no_response','in_progress')),
  outcome_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  selected_at TIMESTAMPTZ,
  outcome_at TIMESTAMPTZ,
  FOREIGN KEY (opportunity_id) REFERENCES dead_deals(opportunity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS revisit_paths_opp_idx ON revisit_paths(opportunity_id);

-- Revisit notes — timestamped free-form scraps the AE picks up about a dead
-- deal between scans ("heard their new CRO is ex-Outreach", "saw their VP at
-- Gartner last week"). These feed back into both the scanner and the path
-- generator as additional context, so late-arriving intel actually steers the
-- output instead of sitting in a forgotten field.
CREATE TABLE IF NOT EXISTS revisit_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES dead_deals(opportunity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS revisit_notes_opp_idx ON revisit_notes(opportunity_id, created_at DESC);

-- Account expansion dossier — one row per active customer we're trying to
-- grow. Free-text fields so the AE can dump what they know as it comes
-- (bullets, prose, pasted meeting recaps). The shape is deliberately loose
-- in Phase 1; if a field turns out to need real structure we promote it
-- later. People-map lives in game_plan_contacts so it stays in sync with
-- the /accounts/:id/plan chess-board view.
CREATE TABLE IF NOT EXISTS account_expansion_dossier (
  account_id UUID PRIMARY KEY REFERENCES accounts_registry(id) ON DELETE CASCADE,
  footprint TEXT,             -- teams × seats × health × 1-line
  destination TEXT,           -- stated goals × sponsor × timing
  stack_competitive TEXT,     -- other tools in play + live objections
  open_questions TEXT,        -- what we don't know yet — feeds the scanner
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Expansion notes — chronological scraps per customer (meeting recaps,
-- Slack chatter, exec-dinner takeaways). Same pattern as revisit_notes;
-- Phase 2's scanner + path generator will read these as additional context.
CREATE TABLE IF NOT EXISTS expansion_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts_registry(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS expansion_notes_account_idx ON expansion_notes(account_id, created_at DESC);


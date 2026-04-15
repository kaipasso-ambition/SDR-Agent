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


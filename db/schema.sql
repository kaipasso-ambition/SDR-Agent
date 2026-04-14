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


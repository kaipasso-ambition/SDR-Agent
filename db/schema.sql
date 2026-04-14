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


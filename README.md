# Ambition SDR Agent

An autonomous SDR agent that researches prospects, generates 3-touch outreach
sequences (email + LinkedIn), classifies replies, and routes drafts to a
human approval queue. Built around Anthropic's Claude API, Postgres, Gmail,
Salesforce, and CommonRoom.

## Architecture

```
src/
├── index.js              # Entry point + cron scheduler
├── prompts/              # System prompts for each Claude call
│   ├── research.js
│   ├── outreach.js
│   └── reply_handler.js
├── agents/               # Orchestration per cycle
│   ├── researcher.js     # Enrich + score prospects
│   ├── writer.js         # Generate 3-touch sequences
│   └── reply_agent.js    # Classify + draft reply responses
├── integrations/
│   ├── salesforce.js     # SFDC account/contact pull (jsforce)
│   ├── gmail.js          # Gmail send + reply monitoring (googleapis)
│   ├── linkedin.js       # PhantomBuster automation layer
│   └── commonroom.js     # Intent signal polling
├── queue/
│   ├── approval_queue.js # Outbound draft queue state
│   └── sequence_tracker.js
├── db/
│   ├── index.js          # pg Pool
│   └── prospects.js      # prospect read/write helpers
└── api/
    ├── server.js         # Express server
    └── routes.js         # REST endpoints for approval UI

db/schema.sql             # Postgres schema (top-level for psql convenience)
```

## Quick-start

```bash
# 1. Install
npm install

# 2. Configure secrets
cp .env.example .env
# then fill in ANTHROPIC_API_KEY, DATABASE_URL, SFDC/Gmail/CommonRoom creds

# 3. Create the database
psql -U postgres -c "CREATE DATABASE ambition_sdr;"
psql -U postgres -d ambition_sdr -f db/schema.sql

# 4. Run
npm run dev
```

The prompt text in `src/prompts/*.js` is already populated from the product
spec. Edit those files if you need to tune voice, ICP, or reply rules.

## Scheduler cadence

| Cycle         | Cron                  | Purpose                                                  |
| ------------- | --------------------- | -------------------------------------------------------- |
| Research      | `0 7,11,15,19 * * 1-5`| Enrich + score new accounts from SFDC/CSV + CommonRoom   |
| Writer        | `30 8,12,16 * * 1-5`  | Generate 3-touch sequences for Tier 1+2 prospects        |
| Reply monitor | `*/30 8-18 * * 1-5`   | Poll Gmail, classify replies, queue drafts               |
| Send          | `0 9,11,13,15,17 * * 1-5` | Send human-approved messages within daily limit      |

All schedules run Monday–Friday. Adjust `SEND_WINDOW_START/END` and
`SEND_TIMEZONE` in `.env` for your timezone.

## Approval UI

The `ui/` directory is reserved for a React approval queue frontend (outbound
drafts tab + Replies tab). Backend endpoints for it live in `src/api/routes.js`.

## ICP + voice rules

See `src/prompts/outreach.js` for the full system prompt — ICP personas,
industry vocabulary, touch structure, and hard writing constraints (≤75
words, no "quick question", etc.).

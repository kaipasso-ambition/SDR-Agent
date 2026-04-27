# Ambition SDR Agent

An SDR agent that researches prospects, generates 3-touch outreach sequences
(email + manually-sent LinkedIn drafts), classifies replies, and routes drafts
to a human approval queue. Built around Anthropic's Claude API, Postgres,
Gmail, Salesforce, and CommonRoom.

> **Automation paused.** After LinkedIn blocked the account, all scheduled
> cron pulls are disabled by default. Set `AUTOMATION_ENABLED=true` to
> re-enable cron once the LinkedIn situation is resolved. Manual scans from
> the UI continue to work regardless. The PhantomBuster integration has
> been removed — LinkedIn touches are draft-only and must be sent by a
> human from their own LinkedIn session.

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

All cron jobs below are gated behind `AUTOMATION_ENABLED=true`. With the
flag off (default), nothing runs on a schedule — the operator drives every
scan from the UI.

| Cycle         | Cron                  | Purpose                                                  |
| ------------- | --------------------- | -------------------------------------------------------- |
| Research      | `0 7,11,15,19 * * 1-5`| Enrich + score new accounts from SFDC/CSV + CommonRoom   |
| Writer        | `30 8,12,16 * * 1-5`  | Generate 3-touch sequences for Tier 1+2 prospects        |
| Reply monitor | `*/30 8-18 * * 1-5`   | Poll Gmail, classify replies, queue drafts               |
| Send          | `0 9,11,13,15,17 * * 1-5` | Send approved email touches within daily limit       |
| Presence      | `15 7,11,15,19 * * 1-5` | Poll Sales Nav digest inbox + rank posts (LinkedIn)    |
| Champion check| `0 8 * * 1`           | Weekly job-change scan for tracked champions             |
| Discovery     | `0 7 * * 1`           | Weekly autonomous prospect discovery                     |

All schedules run Monday–Friday. Adjust `SEND_WINDOW_START/END` and
`SEND_TIMEZONE` in `.env` for your timezone.

Manual equivalents (always available, regardless of `AUTOMATION_ENABLED`):
`/presence` "Refresh now", `/champions` "Check now", `/brief` "Scan signals",
`/accounts/:id` "Rescan" / "Scan all", `/discover`, `/revisit/:id/scan`,
`/expand/:id/scan`.

## Web UI

Server-rendered (EJS + Tailwind via CDN, no separate build step). Lives in
`src/views/` with routes in `src/web/routes.js`. Pages:

- `/login` — email + password login
- `/` — dashboard with queue counts and connection status
- `/drafts` — pending outbound sequences (approve / edit / reject)
- `/replies` — pending reply drafts (send / discard, escalations flagged red)
- `/settings` — connect Gmail / Salesforce / CommonRoom, view team

Auth uses bcrypt password hashes and Postgres-backed sessions via
`connect-pg-simple`. Create users from the CLI:

```bash
node scripts/create_user.js you@example.com "MyStrongPassword!" "Your Name"
```

Re-running with the same email resets that user's password.

## First-run setup (after `npm install`)

```bash
# 1. Make sure DATABASE_URL and SESSION_SECRET are set in .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
# Copy that into SESSION_SECRET in .env

# 2. Apply schema (adds users + session + integrations tables on top of existing data)
psql -d ambition_sdr -f db/schema.sql

# 3. Create your first login
node scripts/create_user.js you@example.com "yourPassword" "Your Name"

# 4. Run
npm run dev

# 5. Open http://localhost:3000 in your browser
```

## ICP + voice rules

See `src/prompts/outreach.js` for the full system prompt — ICP personas,
industry vocabulary, touch structure, and hard writing constraints (≤75
words, no "quick question", etc.).

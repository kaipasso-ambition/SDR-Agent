# SDR-Agent

## Friends of Ambition (FOA) weekly report

`scripts/foa_report.py` finds Salesforce contacts who qualify for the Friends
of Ambition program (more than 5 distinct Gong calls in the trailing 12
months, not already flagged FOA, not already reported), drafts an invite
email for each new candidate, flags anyone newly flipped to FOA since the
last run, posts a report to Slack, and commits updated state to
`data/reported_contacts.json` and `data/known_foa_contacts.json` so future
runs don't repeat anyone. A full markdown report (including every draft
email) is written to `reports/`.

Runs weekly via `.github/workflows/foa_weekly.yml` (Sundays), and can be
triggered on demand from the Actions tab (`workflow_dispatch`).

### Required secrets / environment variables

Salesforce (username-password flow):
- `SF_USERNAME`
- `SF_PASSWORD`
- `SF_SECURITY_TOKEN`
- `SF_DOMAIN` (optional; `login` for production, `test` for a sandbox)

Slack (one of the two):
- `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID`, or
- `SLACK_WEBHOOK_URL`

### Running locally

```bash
pip install -r requirements.txt
export SF_USERNAME=... SF_PASSWORD=... SF_SECURITY_TOKEN=...
export SLACK_BOT_TOKEN=... SLACK_CHANNEL_ID=...
python scripts/foa_report.py
```

Pass `--dry-run` to print the Slack message instead of posting it (state
files and the report are still written) — useful for demoing with only
Salesforce credentials configured.

### Known limitations

- **No positive-intent signal.** The qualification logic only checks call
  volume (>5 calls/12mo), FOA status, and prior-report state. A "positive
  intent" criterion was scoped but isn't wired in: the Gong objects synced
  to Salesforce (`Gong__Gong_Call__c`, `Gong__Tracker__c`) have no
  sentiment field, only topic-tracker keyword counts (Timing, Budget,
  Competitors, `[SMART] Product feedback`), which aren't a positive/negative
  signal on their own. Adding real intent means either pulling it from
  Gong's own product (not synced to Salesforce) or agreeing on a proxy from
  the existing trackers — worth a decision before this goes live.
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
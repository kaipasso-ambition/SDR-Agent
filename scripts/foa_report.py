#!/usr/bin/env python3
"""Friends of Ambition (FOA) weekly report pipeline.

Queries Salesforce for customer contacts who qualify for the FOA program
(more than 5 distinct Gong calls in the trailing 12 months, not already FOA,
not already reported), drafts an invite email for each new candidate, flags
anyone newly flipped to FOA since the last run, posts a report to Slack, and
updates the committed state files so the next run doesn't repeat anyone.
"""

import os
import sys
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from simple_salesforce import Salesforce

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
REPORTS_DIR = REPO_ROOT / "reports"
REPORTED_CONTACTS_PATH = DATA_DIR / "reported_contacts.json"
KNOWN_FOA_PATH = DATA_DIR / "known_foa_contacts.json"

CALL_THRESHOLD = 5
WINDOW_DAYS = 365
CHUNK_DAYS = 90
SLACK_TEXT_LIMIT = 3500
SLACK_CHUNK_SIZE = 3900

EMAIL_TEMPLATE = """Subject: Invite: Friends of Ambition

Hi {first_name},

Because you see the power of Ambition and are driving real change at
{account}, we'd love to invite you to Friends of Ambition, a small group of
customer champions we work with directly.

As a member, you get:
- Early access to new features before general release
- A direct line to our product team to shape what we build next
- A quarterly roundtable with peers at other companies facing similar
  challenges
- First look at case studies, with the option to be featured

It's a light commitment on your end. If you're interested, just reply and
I'll get you added.

Thanks for everything you do with the team."""


def require_env(*names):
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        sys.exit(f"Missing required environment variable(s): {', '.join(missing)}")


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text())
    return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def connect_salesforce():
    require_env("SF_USERNAME", "SF_PASSWORD", "SF_SECURITY_TOKEN")
    return Salesforce(
        username=os.environ["SF_USERNAME"],
        password=os.environ["SF_PASSWORD"],
        security_token=os.environ["SF_SECURITY_TOKEN"],
        domain=os.environ.get("SF_DOMAIN", "login"),
    )


def date_chunks(start, end, chunk_days=CHUNK_DAYS):
    chunks = []
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=chunk_days), end)
        chunks.append((cur, nxt))
        cur = nxt
    return chunks


def soql_datetime(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_call_participants(sf, window_start, window_end):
    """Query Gong__Call_Participant__c in date-bounded chunks to stay under
    Salesforce's per-query row cap, merging results in code."""
    records = []
    for chunk_start, chunk_end in date_chunks(window_start, window_end):
        query = f"""
            SELECT Gong__Contact_Participant__c,
                   Gong__Contact_Participant__r.Name,
                   Gong__Contact_Participant__r.Title,
                   Gong__Contact_Participant__r.Email,
                   Gong__Contact_Participant__r.Account.Name,
                   Gong__Contact_Participant__r.Friend_of_Ambition__c,
                   Gong__Gong_Call__c,
                   Gong__Gong_Call__r.Gong__Call_Start__c
            FROM Gong__Call_Participant__c
            WHERE Gong__Contact_Participant__c != null
              AND Gong__Gong_Call__r.Gong__Call_Start__c >= {soql_datetime(chunk_start)}
              AND Gong__Gong_Call__r.Gong__Call_Start__c < {soql_datetime(chunk_end)}
        """
        records.extend(sf.query_all(query)["records"])
    return records


def group_by_contact(records):
    """Group call-participant rows by contact, deduping calls by ID so a
    contact appearing twice on the same call only counts it once."""
    by_contact = {}
    for rec in records:
        contact_id = rec["Gong__Contact_Participant__c"]
        contact = rec.get("Gong__Contact_Participant__r") or {}
        entry = by_contact.setdefault(contact_id, {
            "contact_id": contact_id,
            "name": contact.get("Name"),
            "title": contact.get("Title"),
            "email": contact.get("Email"),
            "account": (contact.get("Account") or {}).get("Name"),
            "is_foa": bool(contact.get("Friend_of_Ambition__c")),
            "call_ids": set(),
        })
        call_id = rec.get("Gong__Gong_Call__c")
        if call_id:
            entry["call_ids"].add(call_id)
    return by_contact


def fetch_foa_contacts(sf):
    return sf.query_all(
        "SELECT Id, Name, Email, Account.Name FROM Contact "
        "WHERE Friend_of_Ambition__c = true"
    )["records"]


def find_new_candidates(by_contact, reported_ids):
    candidates = []
    for contact_id, entry in by_contact.items():
        if entry["is_foa"] or contact_id in reported_ids:
            continue
        call_count = len(entry["call_ids"])
        if call_count > CALL_THRESHOLD:
            candidates.append({
                "contact_id": contact_id,
                "name": entry["name"] or "Unknown",
                "account": entry["account"],
                "title": entry["title"],
                "email": entry["email"],
                "call_count": call_count,
            })
    candidates.sort(key=lambda c: c["call_count"], reverse=True)
    return candidates


def draft_email(candidate):
    first_name = (candidate["name"] or "").split(" ")[0] or "there"
    return EMAIL_TEMPLATE.format(
        first_name=first_name, account=candidate["account"] or "your company"
    )


def build_report_markdown(run_date, candidates, newly_foa):
    lines = [f"# Friends of Ambition weekly report — {run_date:%Y-%m-%d}", ""]
    lines.append(f"- New candidates: {len(candidates)}")
    lines.append(f"- Newly flagged FOA: {len(newly_foa)}")
    lines.append("")

    lines.append("## New candidates")
    lines.append("")
    if candidates:
        lines.append("| Name | Account | Title | Calls |")
        lines.append("|---|---|---|---|")
        for c in candidates:
            lines.append(
                f"| {c['name']} | {c['account'] or ''} | {c['title'] or ''} | {c['call_count']} |"
            )
    else:
        lines.append("None this week.")
    lines.append("")

    lines.append("## Newly flagged as Friend of Ambition")
    lines.append("")
    if newly_foa:
        for r in newly_foa:
            acct = (r.get("Account") or {}).get("Name") or ""
            lines.append(f"- {r['Name']} ({acct})")
    else:
        lines.append("None this week.")
    lines.append("")

    lines.append("## Draft invite emails")
    lines.append("")
    if candidates:
        for c in candidates:
            lines.append(f"### {c['name']} <{c['email'] or 'no email on file'}>")
            lines.append("")
            lines.append("```")
            lines.append(draft_email(c))
            lines.append("```")
            lines.append("")
    else:
        lines.append("None this week.")

    return "\n".join(lines)


def write_report_file(run_date, markdown):
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORTS_DIR / f"foa_report_{run_date:%Y-%m-%d}.md"
    path.write_text(markdown)
    return path


def build_report_url(report_path):
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        return None
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    branch = os.environ.get("GITHUB_REF_NAME", "main")
    rel_path = report_path.relative_to(REPO_ROOT)
    return f"{server}/{repo}/blob/{branch}/{rel_path}"


def build_slack_text(run_date, candidates, newly_foa, report_url):
    lines = [f"*Friends of Ambition — weekly report — {run_date:%Y-%m-%d}*", ""]

    if candidates:
        lines.append(f"*{len(candidates)} new candidate(s):*")
        for c in candidates:
            lines.append(
                f"• {c['name']} — {c['account'] or 'Unknown account'} — "
                f"{c['title'] or 'No title'} — {c['call_count']} calls"
            )
    else:
        lines.append("No new candidates this week.")
    lines.append("")

    if newly_foa:
        lines.append(f"*{len(newly_foa)} contact(s) newly flagged FOA:*")
        for r in newly_foa:
            acct = (r.get("Account") or {}).get("Name") or "Unknown account"
            lines.append(f"• {r['Name']} ({acct})")
    else:
        lines.append("No newly flagged FOA contacts.")

    summary = "\n".join(lines)

    email_lines = []
    if candidates:
        email_lines.append("")
        email_lines.append("*Draft invite emails:*")
        for c in candidates:
            email_lines.append(
                f"\n*{c['name']}* <{c['email'] or 'no email on file'}>\n```{draft_email(c)}```"
            )
    full_text = summary + "\n".join(email_lines)
    if report_url:
        full_text += f"\n\nFull report: {report_url}"

    if len(full_text) <= SLACK_TEXT_LIMIT or not report_url:
        return full_text
    return summary + f"\n\nDraft emails omitted for length — see full report: {report_url}"


def chunk_text(text, size=SLACK_CHUNK_SIZE):
    return [text[i:i + size] for i in range(0, len(text), size)] or [""]


def post_to_slack(text):
    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    channel_id = os.environ.get("SLACK_CHANNEL_ID")
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not (bot_token and channel_id) and not webhook_url:
        sys.exit(
            "No Slack credentials configured: set SLACK_BOT_TOKEN + "
            "SLACK_CHANNEL_ID, or SLACK_WEBHOOK_URL."
        )

    for chunk in chunk_text(text):
        if bot_token and channel_id:
            resp = requests.post(
                "https://slack.com/api/chat.postMessage",
                headers={"Authorization": f"Bearer {bot_token}"},
                json={"channel": channel_id, "text": chunk, "unfurl_links": False},
                timeout=30,
            )
            resp.raise_for_status()
            payload = resp.json()
            if not payload.get("ok"):
                sys.exit(f"Slack API error: {payload}")
        else:
            resp = requests.post(webhook_url, json={"text": chunk}, timeout=30)
            resp.raise_for_status()


def main():
    run_date = datetime.now(timezone.utc)
    window_start = run_date - timedelta(days=WINDOW_DAYS)

    reported = load_json(REPORTED_CONTACTS_PATH, [])
    reported_ids = {r["contact_id"] for r in reported}
    known_foa_ids = set(load_json(KNOWN_FOA_PATH, []))

    sf = connect_salesforce()

    participant_records = fetch_call_participants(sf, window_start, run_date)
    by_contact = group_by_contact(participant_records)
    candidates = find_new_candidates(by_contact, reported_ids)

    foa_contacts = fetch_foa_contacts(sf)
    newly_foa = [r for r in foa_contacts if r["Id"] not in known_foa_ids]

    report_markdown = build_report_markdown(run_date, candidates, newly_foa)
    report_path = write_report_file(run_date, report_markdown)
    report_url = build_report_url(report_path)

    slack_text = build_slack_text(run_date, candidates, newly_foa, report_url)
    post_to_slack(slack_text)

    today = run_date.strftime("%Y-%m-%d")
    reported.extend({
        "contact_id": c["contact_id"],
        "name": c["name"],
        "account": c["account"],
        "date_first_reported": today,
    } for c in candidates)
    save_json(REPORTED_CONTACTS_PATH, reported)
    save_json(KNOWN_FOA_PATH, sorted({r["Id"] for r in foa_contacts}))

    print(
        f"FOA report {today}: {len(candidates)} new candidate(s), "
        f"{len(newly_foa)} newly-flagged FOA contact(s). Report: {report_path}"
    )


if __name__ == "__main__":
    main()

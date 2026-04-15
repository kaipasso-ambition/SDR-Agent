# data/imports/

Drop Salesforce / CRM exports here. This directory is gitignored — files
you place here never get committed. Claude reads them locally; Railway
never sees them.

## Dead deals (Closed Lost + Customer-Churned)

Put the CSV/TSV at `data/imports/dead_accounts.csv` and run:

```
npm run import:dead-deals -- data/imports/dead_accounts.csv
```

Idempotent — safe to re-run whenever you refresh the Salesforce report.
Dedup happens on `Opportunity ID`; account status winner per account is
`Customer - Churned` > `Customer` > `Prospect`.

### Expected columns (headers flexible, aliases in importer)

- Account Name
- Opportunity ID *(dedup key)*
- Close Date
- Closed Lost Reason
- Account Type *(Prospect / Customer - Churned)*
- Account Owner
- Linkedin
- Industry
- Next Step
- Current State & Pains
- What are the Business & Technical Pains?
- Champion
- Decision Criteria
- Decision Process
- Why are they taking the call?
- Why now? Critical Event?
- Why Ambition?
- FOA (Friend of Ambition)

Delimiter auto-detected (tab vs comma). Quoted multi-line fields OK.
Trailing empty columns OK.

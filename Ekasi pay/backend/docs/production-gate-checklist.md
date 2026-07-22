# Production gate checklist

All boxes require named evidence. Unchecked external items block enabling the affected production flag.

- [ ] Named product, engineering, security, finance/risk, privacy and incident owners.
- [ ] External legal classification and licensing decision for each enabled product.
- [ ] Contracted provider/underwriter/lender/settlement authority and tested credentials.
- [ ] Safeguarding, settlement, refunds, reversals and reconciliation procedures approved.
- [ ] Privacy impact assessment, retention schedule, data-subject and breach processes approved.
- [ ] Threat model reviewed; penetration test and high-severity remediation completed.
- [ ] Merchant onboarding documents, reviewer authority and rejection/appeal procedure approved.
- [ ] Production secrets, CORS origins, backups, restore test, monitoring and alert escalation verified.
- [ ] Idempotency, ledger invariants, limits and failure-mode tests pass for every enabled posting route.
- [ ] Runbook proves `FINANCIAL_POSTING_ENABLED=false` stops new postings while login, reads and investigation remain available.
- [ ] Rollout uses low limits/canary users and a named rollback decision-maker.
- [ ] Post-launch reconciliation and incident review cadence scheduled.

Phase 0 does not satisfy these external decisions and does not authorize production money movement.

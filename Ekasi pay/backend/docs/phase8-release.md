# Phase 8 — release readiness

Phase 8 packages customer-protection evidence, CI hardening, and a fail-closed
production readiness gate. It does **not** authorize live money movement,
provider certification, or legal classification by itself.

## CI (repository)

Workflow: `.github/workflows/ci.yml`

- Concurrency cancel-in-progress per ref
- Default `permissions: contents: read`
- Job `timeout-minutes`
- `npm audit --omit=dev --audit-level=high` on frontend, backend, and ops UI
- Secret scan via MIT **gitleaks** CLI (no `GITLEAKS_LICENSE` required)
- PostgreSQL 16 service: `migrate:up` / `migrate:status` / reconcile /
  `test:postgres` with `TEST_DATABASE_URL` and `PG_INTEGRATION_TESTS=1`

### Configure in GitHub UI (not inventable in YAML)

Operators must set, per org policy and plan:

- Protected default branch with **required pull-request reviews**
- **Required status checks** matching this workflow’s jobs
- **Environments** (staging / production) with required reviewers before deploy

The workflow job `github-controls-reminder` only documents these; it does not
enable them.

## Production readiness gate

Script: `backend/scripts/production-readiness.mjs`  
npm: `cd backend && npm run production:ready`

### How to run

```bash
cd "Ekasi pay/backend"
cp evidence/production-readiness.example.json evidence/production-readiness.json
# Fill only real approved evidence + artifact digests for this RELEASE_SHA.
# Leave gated product flags pending while CASH_SEND_ENABLED / LENDING_ENABLED /
# INSURANCE_ENABLED / STOKVEL_MONEY_MOVEMENT_ENABLED remain false.

export NODE_ENV=production
export RELEASE_SHA="$(git rev-parse HEAD)"
export DATABASE_URL=postgresql://...   # target Postgres
export FINANCIAL_POSTING_ENABLED=true  # only after evidence is complete
# Keep product flags false unless matching productFlags evidence is approved:
# export CASH_SEND_ENABLED=false
# export LENDING_ENABLED=false
# export INSURANCE_ENABLED=false
# export STOKVEL_MONEY_MOVEMENT_ENABLED=false

npm run production:ready
```

Optional:

- `READINESS_EVIDENCE_FILE` — path to the manifest (default
  `evidence/production-readiness.json`)
- `READINESS_REPORT` — output report path (default
  `artifacts/readiness/report.json`)

### Fail-closed product flags

If any of `CASH_SEND_ENABLED`, `LENDING_ENABLED`, `INSURANCE_ENABLED`, or
`STOKVEL_MONEY_MOVEMENT_ENABLED` is true, the gate requires a matching
`status: approved|passed` entry in `productFlags` (artifact + sha256, same
release SHA / unexpired rules as other controls). Disabled flags do not need
evidence. Never invent approvals in the example template.

Also see [critical-financial-controls.md](./critical-financial-controls.md) and
[production-gate-checklist.md](./production-gate-checklist.md).

## Rollback

1. Set `FINANCIAL_POSTING_ENABLED=false` (and product flags false) in the
   deployment environment; redeploy or restart so config reloads.
2. Confirm new money routes return fail-closed responses; login/read/ops
   investigation remain available.
3. Preserve journals, provider instructions, and audit outbox; do not rewrite
   history.
4. Run ledger/voucher reconcile on an isolated connection; open incident with
   named commander.
5. Revert the deploy to the last known-good image/SHA only after reconcile
   confirms no open break that the rollback would hide.

## Architecture notes

- Ops UI is a **static Vite app** calling the **main API** (`/api` or `/api/v1`).
  The obsolete `ops-dashboard/server/` Node DB server was removed.
- API versioning: [api-versioning.md](./api-versioning.md)
- Future folder rename: [directory-rename-checklist.md](./directory-rename-checklist.md)

## External blockers (not satisfiable in-repo)

- Legal classification / licensing for each enabled product
- Contracted provider, underwriter, lender, and settlement credentials
- Penetration test and high-severity remediation sign-off
- GitHub branch protection and environment approval configuration
- Live Neon (or other) production migration window and backup/restore proof
  against the real provider
- POPIA / privacy impact and retention approvals
- Named production owners and incident commander roster

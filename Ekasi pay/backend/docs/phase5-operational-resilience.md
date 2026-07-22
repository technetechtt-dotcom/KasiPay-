# Phase 5 operational resilience

Status: engineering controls implemented; external services remain deployment gates.

## Fraud and risk

`006_phase5_operational_resilience.js` creates tier/transaction limits, versioned
rules, velocity signals, linked-identity edges, allow/block lists, evaluations,
holds, cases, and immutable notes. Rules use safe facts and scores; a block-list
match must override an allow-list match. Circular-flow analysis is bounded.

Sanctions and PEP checks use `SanctionsPepProvider`. There is intentionally no
mock "clear" result. Deployed startup requires a provider, endpoint, and key.
Potential matches must be held for a compliance operator.

## Cash Send

- References contain 128 random bits. PINs are independent and only their hash
  is stored. The API never returns the plaintext PIN.
- Reference and PIN are sent in separate SMS messages. Durable outbox rows carry
  no plaintext PIN.
- Beneficiary ID/phone binding is hashed. Collection validates the beneficiary
  ID and locks the voucher row before posting.
- Create, collect, cancel, and scheduled expiry/refund couple voucher state and
  ledger posting in one transaction. `voucher:expire` is the scheduler entrypoint.
- `voucher:reconcile` compares every voucher's exact hold, settlement, or refund
  posting IDs and amounts. Any discrepancy exits non-zero.
- Run at least two expiry workers in staging to verify `FOR UPDATE SKIP LOCKED`.

## Observability and audit

Logs are JSON and pass through centralized redaction. Request and correlation
IDs are bounded and propagated in headers, audit/outbox rows, and provider
contracts. Metrics cover HTTP latency/errors and hooks exist for DB pool,
postings, idempotency, reconciliation, authentication, and voucher attempts.
Export `/internal/metrics` only through a private service/network.

`/health/live` only proves the process is alive. `/health/ready` checks the
database and, outside local environments, a fresh encrypted/verified backup
marker. Posted journal transitions insert append-only audit evidence in the same
transaction. Every audit insert transactionally queues the external sink.

## Backup and disaster recovery

Required targets are configured with `RTO_MINUTES` and `RPO_MINUTES`.
`backup:postgres` creates a custom-format dump, encrypts it, deletes plaintext,
and emits a checksum marker. This does not configure cloud backup or PITR.

Restore drill:

1. Provision an isolated database with no production network route.
2. Fetch the encrypted artifact and object-store inventory; record hashes.
3. Decrypt only in the isolated runner and restore with `pg_restore`.
4. Run migration status, `ledger:reconcile`, `voucher:reconcile`, row-count and
   object-inventory checks.
5. Record a `phase5.drill.v1` result and a `backup_verification_markers` row.
6. Destroy the isolated database and plaintext.

Readiness fails when the latest verified marker is absent or expired. Explicit
encryption, PITR, and verification markers are production configuration gates.

## Safe failure drills

`npm run drill -- <type>` refuses production and aborts unless an isolated fault
adapter is supplied. Supported types: API kill after commit, DB loss, provider
timeout, malformed/duplicate webhook, dead-letter recovery, and partial
settlement. Results use `phase5.drill.v1` with timestamps, outcome, assertions,
evidence references, and runner version. Never point a drill adapter at a
production URL or provider.

## Incident response

Severity:

- SEV-1: active loss, unauthorized posting, sanctions breach, material data leak.
- SEV-2: posting outage, reconciliation break, backup/RPO breach.
- SEV-3: degraded provider, elevated fraud queue, isolated customer impact.

Workflow: declare severity, appoint commander/scribe, preserve immutable evidence,
activate only the minimum control, notify escalation route, issue timestamped
updates, reconcile before recovery, and complete post-incident review.

Runbooks:

- Account takeover/credential stuffing: pause affected sessions, preserve auth
  signals, investigate linked devices, notify users.
- Fraud/circular flow: hold references, open cases, screen subjects, preserve
  notes and provider evidence.
- Ledger/reconciliation: activate posting kill switch, keep reads/auth/case work
  available, identify first divergent reference, reverse rather than edit.
- Voucher attack: pause postings if systemic, retain lookup/collect attempt
  metrics, lock affected vouchers, reconcile escrow exactly.
- Provider/webhook outage: stop outbound retries at threshold, quarantine
  malformed events, recover from dead letter with idempotency.
- Database outage/corruption: disable postings, fail readiness, invoke isolated
  PITR/restore plan, reconcile before reopening.
- Privacy/security incident: restrict evidence, preserve hashes and access audit,
  follow POPIA notification decision process.
- Backup freshness/RPO breach: fail readiness, investigate provider, create and
  verify a fresh encrypted backup before reopening.

The capability-scoped posting switch requires a 15-character reason and writes
an immutable control event plus audit event transactionally. It affects only new
money postings, preserving reads, authentication, and investigations.

## Templates

Evidence: incident ID, UTC time, actor, request/correlation ID, financial
references, immutable event IDs, safe hashes, query/version, custodian.

Communication: severity, customer impact, known start, mitigations, data/funds
status, next update time, owner. Never include secrets, ID numbers, PINs, OTPs,
phone numbers, or unverified attribution.

External blockers before production: real sanctions/PEP contract and integration,
monitoring/tracing sink, alert routing/on-call ownership, cloud encrypted backup
and PITR configuration, external audit sink, and completed isolated drills.

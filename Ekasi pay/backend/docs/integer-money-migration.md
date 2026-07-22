# Phase 2 integer-money migration

All production PostgreSQL money is represented as signed 64-bit integer ZAR
cents. Public decimal inputs are validated as canonical base-10 values and are
converted immediately. PostgreSQL `BIGINT` values are handled as strings by the
driver and converted to JavaScript `bigint`; they are never converted through
`number`.

## Deployment sequence

1. **Backup and sign-off.** Create and verify a Neon branch or point-in-time
   restore checkpoint. Record the branch ID, migration owner, reviewer, and
   rollback decision maker. Do not use the production branch to rehearse.
2. **Preflight.** Apply migration 002 only on the rehearsal branch first. Its
   first transactional phase scans every legacy column and aborts before any
   DDL when it finds NaN, infinity, or more than two decimal places.
3. **Expand/backfill.** Run `npm run migrate:expand`. Migration 002 adds
   `*_cents BIGINT`, backfills by exact multiplication (never `ROUND()`), adds
   nonnegative constraints, and installs temporary compatibility triggers.
   The entire migration is transactional.
4. **Verify.** Run `npm run money:reconcile` and archive both its JSON output
   and human-readable log. It exits nonzero for unsupported precision,
   legacy/cents differences, or wallet-versus-ledger differences. Investigate
   every exception row; do not waive differences by increasing a tolerance.
5. **Cut over.** Deploy the Phase 2 application. New PostgreSQL reads and writes
   use only `*_cents`. Closely monitor rejected precision, failed postings, and
   reconciliation output. The legacy columns are compatibility mirrors and are
   not authoritative.
6. **Contract (separate release).** After an agreed observation window and
   written finance/operations sign-off, set `ALLOW_MONEY_CONTRACT=1`, then run
   `npm run migrate:contract` to apply
   `003_contract_legacy_money`. It verifies reconciliation again in the same
   transaction, removes compatibility triggers, and drops every legacy
   floating column. Do not apply 003 in the initial expand deployment.

## Neon release evidence

- Tested restore/branch identifier and timestamp
- `migrate:validate` and migration rehearsal output
- Pre- and post-migration reconciliation JSON
- Row-count and aggregate-cent comparisons for every reported column
- Wallet/ledger exception disposition
- Application and operations sign-off
- Named rollback owner and restore procedure

Migrations 002 and 003 are intentionally irreversible. Rollback means restoring the
verified Neon checkpoint and reverting the application deployment.

## Embedded JSON

`sales.items_json`, `purchase_slips.line_items_json`,
`layby_orders.installments_json`, and stokvel member JSON can contain historical
display amounts. They are not balance authorities. New writers must store
canonical decimal strings or explicit `*Cents` integer strings in those
documents. Historical JSON conversion requires a separately reconciled data
migration because its schemas are not uniform.

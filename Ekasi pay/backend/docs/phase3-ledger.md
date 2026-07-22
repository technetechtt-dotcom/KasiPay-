# Phase 3 PostgreSQL ledger

## Source of truth

`journal_transactions` and `journal_entries` are the financial source of truth.
The old `transactions`, `ledger_entries`, and `wallets.balance_cents` fields are
updated in the same transaction as compatibility projections for existing API
mappers. New code must not write those projections directly.

Every posting has a globally unique reference, batch, currency, pool, effective
date, explicit lifecycle state, and at least one equal debit/credit pair.
Corrections append a linked full/partial reversal or refund; posted rows are
never edited or deleted.

## Database controls

- Positive integer cents and constrained side/currency/state values prevent
  malformed entries.
- Accounts and balance projections are locked in lexical id order. The posting
  engine checks wallet state, currency, pool, and funds before inserting the
  balanced journal and updating projections atomically.
- Deferred constraint triggers validate balance after all entries have been
  inserted but before commit. This permits normal multi-row posting while making
  an unbalanced posted transaction impossible.
- Projection triggers reject negative available balances unless an account is
  explicitly configured to allow them.
- Append-only triggers protect entries, posted transactions, and commission
  records. Commission cancellation inserts a linked negative compensation.
- Pool-owned posting retries serialization failures and deadlocks three times
  with bounded exponential delay. Callers that already own a transaction retain
  control of retrying the whole business operation.

## Idempotency and inbound events

Money-moving routes require `Idempotency-Key`. Claims are scoped by
actor/route/key and bind to a canonical SHA-256 request hash. Identical completed
requests replay the stored status/body; changed payloads return 422; live claims
return 409; expired leases can be safely reclaimed.

`webhook_inbox` stores provider event uniqueness, occurrence/receipt timestamps,
payload hash, signature, processing lease, attempts, and terminal status.
Signatures must be verified over the raw request bytes before
`claimWebhookEventPg` is called. `voucher_replay_guard` provides an additional
unique operation guard for collect/cancel/expiry.

## Reconciliation and deployment gate

Run:

```sh
npm run ledger:reconcile
```

The command fails on unbalanced journals, negative restricted projections,
projection drift, or an unsigned historical backfill. Migration 004 records
legacy row count in `ledger_backfill_status`. A database with historical
transactions remains `pending_signoff`; production deployment is blocked until
an operator:

1. freezes writes and takes a verified backup;
2. produces opening balances per wallet/account and investigates discrepancies;
3. posts approved opening-balance journals with globally unique references;
4. compares journal-derived and legacy balances;
5. records the report and marks the single status row `completed`.

Migration 004 intentionally does not infer accounting classifications from old
free-form transaction types.

After the opening-balance report is approved, the guarded implementation is:

```sh
ALLOW_LEDGER_BACKFILL=1 \
LEDGER_BACKFILL_APPROVAL="change-ticket-or-signed-report" \
npm run ledger:backfill
```

It refuses a non-empty journal, negative legacy wallet, or an unsupported
currency/pool. API startup also refuses `pending_signoff`, so the gate cannot be
bypassed by omitting the reconciliation command.

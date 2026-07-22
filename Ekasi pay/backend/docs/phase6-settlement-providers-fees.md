# Phase 6 — settlement, fees, providers and reversals

## Scope and safety boundary

Phase 6 adds vendor-neutral controls. It does **not** certify a bank format,
activate a production provider, move live money, or migrate a live Neon
database. Sandbox simulator records are installed disabled from production by
environment separation.

## Settlement contract

The only accepted import contract is UTF-8, LF-delimited CSV with this exact
header:

```text
provider_reference,bank_reference,amount_cents,currency,value_date,direction
```

Amounts are signed integer minor units; currency is ISO-4217 uppercase;
`value_date` is `YYYY-MM-DD`; direction is `credit` or `debit`. Quoted fields,
extra columns, CRLF, locale amounts and ambiguous dates are rejected. The
original byte hash and canonical row hash are unique per provider. Rows are
individually hashed and duplicates are rejected.

Matching order is deterministic:

1. provider reference + amount + currency: exact match;
2. provider reference + currency with a different amount: partial break;
3. more than one eligible candidate: duplicate break;
4. otherwise: unmatched break.

Every row points to a posted journal transaction. Exact rows point to the
business posting. Breaks create a balanced suspense posting and an immutable
alert. Finance resolution requires a maker proposal, a different checker, a
posted target journal, reason and evidence. Daily close records preserve
expected, statement, matched and break totals plus an evidence SHA-256.

## Fee policy

Fee schedules are versioned by code/version and selected server-side by
product, currency, effective time and integer-cent tier. A tier combines flat
cents and basis points, applies integer rounding and min/max caps, then
allocates exactly 10,000 basis points among platform, provider, tax, agent and
merchant liabilities.

Cash Send now resolves its fee from the published `cash_send` schedule. The
initial schedule preserves the prior R10 customer fee and 50% agent allocation,
but those values are data, not route constants. Accrual creates a balanced
journal from escrow into dedicated liabilities. Collection pays principal
only. Cancellation and expiry create an immutable, linked fee-clawback journal
before refunding principal plus fee.

Self/circular agent and merchant beneficiaries are rejected. Legacy commission
rows remain an append-only statement projection and now link to the fee
assessment and accrual journal.

## Refunds and reversals

`POST /api/refunds` accepts integer cents and requires an idempotency key.
Refundable ceiling is original debit less all posted/settled linked
compensating entries. The operation creates a `refund_request` and a linked
compensating journal; it never edits or deletes the original. Amounts at or
above R1,000 require an unexpired approved maker-checker request. Product and
stock/domain compensation evidence is retained with the request.

Only transactions represented as wallet journal postings can be executed by
the generic endpoint. Provider-specific utility, insurance and lending
eligibility still has to be confirmed by the relevant adapter before calling
it. This is intentional: “refund” must not imply a provider can recover value.

## Provider instruction journal

`provider_instructions`, immutable attempts, signed callback inbox, dead
letters and circuit state separate business posting from external side
effects. States are:

`created → submitted → accepted → fulfilled | failed | unknown → reversed`

Requests use canonical JSON SHA-256 plus HMAC over
`timestamp.payload_sha256`. Callbacks reject stale timestamps and invalid
signatures. Endpoint environment is explicit; deployed environments reject
sandbox callbacks. Endpoint + idempotency key, provider event ID, callback
payload hash and provider reference are unique.

Timeout creates `unknown`, not `failed`. Dispatch re-queries unknown
instructions with a provider reference before submitting again. Retries use
bounded exponential jitter. The included simulator is test/sandbox only and
can model fulfillment, rejection, timeout and unknown-then-recovered.

Utility ordering is now:

1. reserve value into escrow and commit the authorization;
2. create the provider instruction in the same transaction;
3. dispatch;
4. mark fulfilled and retain token fingerprint on success;
5. compensate the authorization on a definitive failure;
6. keep value reserved and state `unknown` on timeout for re-query.

This prevents provider fulfillment before authorization and prevents a second
token/value request from using a different idempotency key.

## Operations

The ops dashboard Settlement tab imports canonical files, reports exact and
break counts, and shows suspense cases with journal references. APIs also
provide fee schedule creation/publication, settlement overview, maker-checker
suspense resolution and daily close/sign-off.

Operational alerts are append-only database evidence. Existing monitoring
export must route `settlement_alerts` and provider unknown/dead-letter metrics
to the configured monitoring provider.

## Production blockers

Production enablement remains blocked until all of the following are complete:

- each bank supplies samples and signs off a mapping into `phase6-v1`;
- statement timezone, booking/value date and debit/credit semantics are
  certified per bank;
- payout provider request, status-query and callback contracts pass conformance
  and replay tests;
- provider keys are in a managed secret/KMS service and endpoint records refer
  to those keys;
- utility providers certify unknown-outcome lookup and token idempotency;
- SMS and KYC vendors expose stable idempotency/status APIs before their
  existing adapters can be fully moved onto the instruction dispatcher;
- finance approves fee/tax accounting, VAT treatment, settlement cutoffs and
  liability beneficiaries;
- legal/product owners approve refundability for loans, insurance and consumed
  utility value;
- monitoring routing, dead-letter ownership, bank holiday calendars and
  settlement SLAs are configured and exercised in staging;
- the migration is applied to an isolated PostgreSQL clone and reconciliation
  evidence is reviewed before any live Neon migration.

No production provider should be enabled while any applicable blocker remains.

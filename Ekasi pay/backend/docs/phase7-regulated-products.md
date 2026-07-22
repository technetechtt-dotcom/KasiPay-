# Phase 7 — regulated products

## Safety boundary

Phase 7 installs controls and sandbox primitives. It does not approve a legal
classification, appoint a custodian or lender, certify a provider, migrate live
Neon, or authorize production. All five products fail closed. Production needs:

1. the latest append-only database evidence for all seven controls to be
   `approved` and unexpired;
2. `REGULATED_PRODUCTS_PRODUCTION_ENABLED=true`;
3. the matching `PRODUCT_<PRODUCT>_PRODUCTION_ENABLED=true`.

The controls are legal, provider, accounting, customer journey, reconciliation,
testing and runbook. A rejection or withdrawal appended after an approval
immediately blocks the product. The ops screen displays evidence but cannot
turn evidence into an external approval. Artifacts are referenced by URI and
SHA-256; sensitive documents must remain in approved private storage.

Sandbox additionally needs all seven sandbox evidence records and
`PHASE7_SANDBOX_ENABLED=true`. Simulator endpoints are valid only when their
database environment is `sandbox` and the process is development/test.

## Common operating procedure

Before any controlled sandbox session:

1. confirm the target environment and product in `/api/ops/product-readiness`;
2. independently verify each artifact digest and authority reference;
3. append evidence through `/api/ops/product-readiness/evidence`;
4. run `/api/ops/product-readiness/checks` and retain its immutable snapshot;
5. verify product accounting mappings are approved and point to different debit
   and credit accounts;
6. run the product failure suite and reconciliation;
7. stop if the gate is not enabled. Never bypass HTTP 423.

For an incident: stop the relevant product config gate, preserve provider
instructions and journals, classify unknown outcomes before retrying, run the
reconciliation, open disputes where customer value is affected, and append a
new readiness withdrawal if an approval is no longer valid.

## Stokvel

### Customer journey

Create a separate group account; record the legal custodian; publish a
constitution version; authenticate each user membership; collect consent to the
exact constitution digest; then activate. Contributions are append-only period
records. Corrections are new linked adjustments. Missed/partial states remain
visible. Withdrawals need the constitution's threshold and at least two
different active members. Statements contain contributions, approvals,
withdrawals, disputes and state events. Removal, resignation, closure and
dispute events never erase history.

### Accounting and reconciliation

Custodied value maps between `P7-STOKVEL-CUSTODY-ZAR` and
`P7-STOKVEL-MEMBER-ZAR`. Daily reconciliation compares the custody asset,
member liability, contribution journals, posted withdrawals and group
statement. Any difference is a blocking break.

Legacy `stokvel_groups` are not mutated. On an isolated clone,
`npm run phase7:stokvel-inventory` hashes group, loan and contribution snapshots
into `stokvel_legacy_conversion`. A maker reconciles expected cents, a different
checker approves, and conversion may be marked complete only when converted
cents equal expected cents. Old write APIs remain behind the common gate and
must be retired after reviewed conversion.

### Failure tests and runbook

Test duplicate contribution, attempted update/delete, unauthenticated member,
stale constitution consent, removed member, one-person approval, duplicate
approver, insufficient custody, closure with open dispute, and interrupted
legacy conversion. Freeze the group on a monetary break; do not edit history.

## Lending

### Customer journey

Only an approved server product version supplies limits, term, interest and
fees. The client submits the selected version, principal and affordability
evidence; it cannot submit rates. The server records inputs, rule version and
decision, generates an integer-cent schedule, and binds agreement/disclosure
digests to an authenticated session. Disbursement and write-off require a
maker-checker approval with different operators. Statements include schedule,
repayment allocations, states and settlement quotes.

### Accounting and reconciliation

Principal, interest, fees and impairment use distinct
`P7-LOAN-PRINCIPAL-ZAR`, `P7-LOAN-INTEREST-ZAR`, `P7-LOAN-FEE-ZAR` and
`P7-LOAN-IMPAIRMENT-ZAR` accounts. Repayment waterfall is fee, interest,
principal. Schedule cent remainders are assigned deterministically to earliest
instalments. Reconcile these accounts to loan component balances, journals,
state events, disbursements and repayments.

### Failure tests and runbook

Test client rate injection, out-of-range principal, unaffordable application,
missing evidence, stale disclosure, duplicate disbursement, maker equals
checker, partial/overpayment, month-end dates, arrears transition, restructure,
write-off and expired settlement quote. Pause disbursement on any component
break.

Production remains blocked until lender-of-record, NCA applicability and
registration decisions, affordability rules, statutory wording and collections
authority are evidenced.

## Merchant credit book

### Customer journey

An approved merchant terms version and regulatory classification are selected
server-side. Each purchase links to a sale and customer consent. Purchases,
payments, adjustments, reversals and write-offs are immutable events.
Allocations are deterministic oldest eligible purchase first. Corrections use a
dispute and linked reversal/adjustment, never an update. Receipts and statements
show consent, sale, allocations and disputes. Employee grants restrict customer
name, phone, balance, transactions, consent and dispute fields separately.

### Accounting and reconciliation

Credit purchases and repayments map to `P7-CREDIT-RECEIVABLE-ZAR` and approved
merchant revenue/cash mappings. Reconcile obligation outstanding cents to the
sum of immutable effective events, allocations, linked sales and journal
balances.

### Failure tests and runbook

Test missing consent/terms/sale, duplicate purchase, payment over-allocation,
historical mutation, correction without reason, reversal reuse, unauthorized
employee fields and disputed debt collection. Freeze the obligation during a
dispute; correct only with new events.

Production remains blocked until the book-debt/incidental-credit/credit-
agreement classification and required customer disclosures are evidenced.

## Insurance

### Customer journey

Only a certified provider can publish a versioned catalogue. Acceptance binds
provider wording and disclosure digests to an authenticated session. Policies
move through pending, cooling-off, active, grace, lapsed, cancelled and expired.
Premiums are separately collected and settled. Claims preserve evidence and go
to provider review. Approved/paid claims require delegated-authority and
provider-decision references; ops cannot approve unilaterally. Payouts use a
journal and all communications preserve template/content evidence.

### Accounting and reconciliation

Premium collections map to `P7-INSURANCE-PREMIUM-ZAR`; approved claim payouts
map to `P7-INSURANCE-CLAIMS-ZAR`. Reconcile policy periods, collection and
provider settlement journals, provider bordereaux, claim decisions and payouts.

### Failure tests and runbook

Test uncertified provider, stale wording, duplicate acceptance, cooling-off
cancellation, failed premium, grace/lapse, missing claim evidence, ops-only
approval, payout without journal, duplicate provider decision and failed
communication. Suspend new sales on bordereaux or premium breaks.

Production remains blocked until licensed insurer/intermediary roles, binder or
delegated authority, product certification, wording, premium collection and
claims settlement are evidenced.

## Utilities

### Customer journey

The client selects a published provider catalogue ID. Category, provider
reference, cost, fee, limits and finality disclosure come from that immutable
version. Supported categories are electricity, water, airtime and data.
Authorization precedes provider instruction. A definitive failure posts a
compensating reversal. A timeout remains unknown and is re-queried; it is never
resubmitted as new value. Delivery attempts and token recovery are append-only.
Receipts include provider/product references, fee and finality digest.

### Accounting and reconciliation

Provider prefund uses `P7-UTILITY-PREFUND-ZAR`; uncertain fulfillment uses
`P7-UTILITY-SUSPENSE-ZAR`. Reconcile provider balance, prefund ledger, fulfilled
face value/cost/fees, unknown instructions, reversals and token delivery.

### Failure tests and runbook

Test client provider spoofing, retired catalogue, amount limits, duplicate
idempotency key, timeout then fulfillment, definitive failure reversal,
callback replay, token delivery failure/recovery, duplicate token and prefund
break. Keep unknown value reserved, re-query the same provider instruction, and
never issue a replacement token until finality is known.

Mock adapters are strictly nonproduction. Production remains blocked until each
provider certifies catalogue, idempotent fulfillment, status query, token
recovery, finality, prefund statement and reconciliation contracts.

## External gates intentionally left open

- legal opinions/classifications for every product;
- Stokvel custodian appointment and safeguarding structure;
- lender-of-record, NCA status/registration and statutory disclosures;
- merchant-credit classification and customer terms;
- licensed insurer/intermediary, binder/delegated authority and certified
  policy wording;
- utility provider contracts and conformance certification;
- finance approval of all event/account/tax mappings;
- approved customer journeys, accessibility/language review and complaints
  handling;
- provider/bank reconciliation samples and signed expected-result reports;
- independent failure/security/UAT evidence and exercised operations runbooks;
- isolated-clone migration and conversion reconciliation before any live Neon
  action.

# Payment settlement

Merchant settlement is **net**, not one external payout per sale.

Example: cash-in R10,000 and cash-out R7,000 → net R3,000.

Tables:

- `merchant_settlement_positions` — opening, cash-in/out, wallet in/out,
  commission, fees, adjustments, net, status
- `settlement_batches` — existing Phase 6 batch header
- `settlement_batch_items` — links positions into a net batch

`POST /ops/settlement/net-batches` creates a batch and marks positions `batched`.
It does **not** send money. `externalPayout: "blocked"` until a contracted
adapter exists.

Reconciliation covers wallet vs journal, float vs ledger, escrow vs outstanding
vouchers, commission liabilities, provider instructions, settlement batches,
statements, and safeguarding vs client liabilities. Drift opens a case and
blocks affected posting. Balances are never silently forced to match.

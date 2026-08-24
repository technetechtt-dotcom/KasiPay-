# KasiPay payment architecture

PayShap is **optional**. It is a future strategic rail, not a launch dependency.

Initial launch rails (software only — production money flags stay off):

1. In-shop **cash**
2. **KasiPay internal wallet** (ledger wallet-to-wallet)
3. **Cash Send** (regional escrow + agent network)
4. **Bank deposit / settlement workflows** (match and net; no live payout adapter)

Do not enable:

- `FINANCIAL_POSTING_ENABLED`
- `CASH_SEND_ENABLED`
- `LENDING_ENABLED` / `LENDING_DISBURSEMENT_ENABLED`
- `INSURANCE_ENABLED`
- `STOKVEL_MONEY_MOVEMENT_ENABLED`
- `LIVE_UTILITIES_ENABLED`

This repository cannot open a trust/client-funds bank account, contract a PSP, or
license the business. Those remain **BLOCKED** external dependencies.

## Products

| Product | Rail | Notes |
|---|---|---|
| `consumer_to_merchant` | `internal_wallet` | POS wallet sale. Charges **net** after discount. |
| `consumer_to_consumer` | `internal_wallet` | `POST /payments/p2p` — any authenticated user |
| `merchant_to_merchant` | `internal_wallet` | Same pool only |
| `merchant_internal_transfer` | `internal_wallet` | Sales vs float stay separated |
| `cash_send` | `cash_send` | Same-region collect remains mandatory |
| `pos_cash` | `cash` | Record only |
| `float_topup` | `bank_deposit` | Credit only after matched bank evidence |
| `float_withdrawal` | `bank_payout` | Workflow only until a contracted adapter exists |

The router never silently substitutes a rail that would change fees or settlement.

## Ledger

All money movement uses `walletPostingPg.ts` (row locks, journal, projections,
idempotency). There is no second ledger.

Wallet kinds: `user`, `merchant_sales`, `merchant_float`, `system_escrow`.

Agent float is one wallet for both Cash Send legs:

- cash-in: `merchant_float` → `system_escrow`
- cash-out: `system_escrow` → `merchant_float`
- bank-matched top-up: `system_escrow` → `merchant_float`

POS sales stay on `merchant_sales` / `user`.

## payment_intents

`payment_intents` is **not** universal. It is only for orchestrated/external
rails (`bank_deposit`, `bank_payout`, and future PSPs). Cash, internal wallet,
and Cash Send post journals directly. Ops payments reads
`journal_transactions` as the source of truth.

## POS totals

`netTotalCents = grossTotalCents - discountCents` with
`0 <= discountCents <= grossTotalCents`.

`sales.total_cents` is **net**. `sales.gross_total_cents` preserves the pre-discount
gross. Historical rows keep the previously stored `total_cents` (the discount bug
stored gross there) and copy it into `gross_total_cents` without rewriting posted
wallet amounts.

## Production drift

Existing wallet/ledger drift is **not** auto-remediated. Use
`drift_remediation_proposals` + named approval. Never run `money:remediate-drift`
automatically.

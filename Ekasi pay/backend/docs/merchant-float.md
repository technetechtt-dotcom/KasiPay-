# Merchant float

`merchant_float` is cash-out liquidity. It is not the POS sales wallet.

## Lifecycle

1. Merchant applies as a payout agent (`POST /merchant/payout-agent/apply`).
2. Ops enrolls (`POST /ops/payout-agents/:id/approve`).
3. Merchant requests a top-up (`POST /merchant/float/topups`) and receives a
   **unique** reference `KP-FLOAT-{short}-{entropy}-{checksum}` per request.
   Consecutive top-ups by the same merchant never reuse a reference.
4. A bank statement/deposit is ingested (`POST /ops/bank-deposits`).
5. Exact match on merchant + reference + currency + amount, **credit-only**, and
   destination fingerprint of an **approved `client_funds` safeguarding account**.
6. Ops confirms the bank transaction is **settled** (`POST /ops/bank-transactions/:id/settle`
   or a signed bank webhook `credit.settled`). Pending EFTs never create float.
7. Ops confirms credit (`POST /ops/merchant-float/topups/:id/credit`).
8. Ledger posts **Dr safeguarded client-funds bank asset / Cr regional escrow**,
   then escrow → `merchant_float`. Merchant float is never issued before the
   bank asset journal.
9. The same bank transaction cannot back more than one float top-up
   (`merchant_float_topups.bank_transaction_id` and
   `bank_transactions.matched_topup_id` are unique).

A merchant claim that “the EFT was sent” never credits float.

Debits, operating-account deposits, unmatched, partial, and duplicate deposits
go to suspense. They are not auto-credited.

Withdrawals (`POST /merchant/float/withdrawals`) enter a maker/checker workflow
(`requested → approved → submitted → …`). External fulfilment is **BLOCKED**
until a payout adapter is installed. Simulation flags stay explicit.

## Limits

`payout_agents` stores per-transaction and daily caps. Collect locks the
payout-agent row `FOR UPDATE` and atomically reserves daily capacity **inside**
the same transaction as the voucher lock. Concurrent cash-outs cannot both
pass a stale remaining-limit check.

Physical cash-out uses `merchant_cash_liquidity` (available/reserved cents),
not the cash band alone. Bands remain a UI seed. Missing liquidity fails closed.

Electronic float is the agent's position with KasiPay:

- **Cash-in (create)** debits `merchant_float` → regional `system_escrow`.
- **Cash-out (collect)** credits `merchant_float` from escrow after the shop
  pays physical cash.
- A float floor alone does **not** authorize cash-out.

## Physical cash

`merchant_cash_liquidity` is the cash-out eligibility gate. Declare
`availableCents` (or seed from a band ceiling; `over_5000` requires explicit
cents). Collect reserves free cash (`available - reserved`) then consumes it
after payout posts. Missing liquidity fails closed. `merchant_cash_availability`
bands are a hint only.

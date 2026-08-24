# Merchant float

`merchant_float` is cash-out liquidity. It is not the POS sales wallet.

## Lifecycle

1. Merchant applies as a payout agent (`POST /merchant/payout-agent/apply`).
2. Ops enrolls (`POST /ops/payout-agents/:id/approve`).
3. Merchant requests a top-up (`POST /merchant/float/topups`) and receives a
   **unique** reference `KP-FLOAT-{short}-{entropy}-{checksum}` per request.
   Consecutive top-ups by the same merchant never reuse a reference.
4. A bank statement/deposit is ingested (`POST /ops/bank-deposits`).
5. Exact match on merchant + reference + currency + amount → `matched`.
6. Ops confirms credit (`POST /ops/merchant-float/topups/:id/credit`).
7. Ledger posts escrow → `merchant_float`.

A merchant claim that “the EFT was sent” never credits float.

Unmatched, partial, and duplicate deposits go to suspense. They are not
auto-credited.

Withdrawals (`POST /merchant/float/withdrawals`) enter a maker/checker workflow
(`requested → approved → submitted → …`). External fulfilment is **BLOCKED**
until a payout adapter is installed. Simulation flags stay explicit.

## Limits

`payout_agents` stores per-transaction and daily caps. Collect fails closed when
the agent is not enrolled, KYC/activation is incomplete, physical cash
availability does not cover the voucher, the agent is suspended, the voucher is
invalid, pools differ, risk blocks, or posting is disabled.

Electronic float is the agent's position with KasiPay:

- **Cash-in (create)** debits `merchant_float` → regional `system_escrow`.
- **Cash-out (collect)** credits `merchant_float` from escrow after the shop
  pays physical cash.
- A float floor alone does **not** authorize cash-out.

## Physical cash

`merchant_cash_availability` is the cash-out eligibility gate. Missing or
`unavailable` fails closed.

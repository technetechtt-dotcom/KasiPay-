# Merchant float

`merchant_float` is cash-out liquidity. It is not the POS sales wallet.

## Lifecycle

1. Merchant applies as a payout agent (`POST /merchant/payout-agent/apply`).
2. Ops enrolls (`POST /ops/payout-agents/:id/approve`).
3. Merchant requests a top-up (`POST /merchant/float/topups`) and receives a
   deterministic reference `KP-FLOAT-{short}-{checksum}`.
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

`payout_agents` stores floor, per-transaction, daily cap, and daily usage.
Collect fails closed when the agent is suspended, float controls fail, the
voucher is invalid, pools differ, risk blocks, or posting is disabled.

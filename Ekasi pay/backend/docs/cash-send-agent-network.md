# Cash Send agent network (product decisions)

These rules apply before national real-money Cash Send. They do not enable
funds flags. Migration `022_payment_architecture.js` publishes Cash Send fee
**version 3** (R9 = R6 platform + R1 sending shop + R2 payout shop) for **new**
vouchers only. Historical v1/v2 assessments are not rewritten. Collect credits
the payout shop `merchant_float` wallet, never a personal `user` wallet.

## R3 merchant commission

| Phase | Who earns the R3 | When it posts |
|---|---|---|
| Same-region pilot, collect-anywhere in that pool | **Sending shop keeps R3.00** | At voucher create; reverse on cancel/expire |
| National M-Pesa-style agent network | **R1.00 sending shop + R2.00 payout shop** | R1 at create; R2 at successful collect |

**Why the split later:** the payout shop supplies scarce cash float and takes
the cash-out risk. The sending shop only accepts cash-in and prints a voucher.
Until payout shops are a distinct KYC’d role with a float wallet, splitting
would pay a second party that the ledger cannot identify.

Do not accrue payout commission at create. If the voucher expires, only the
originating R1 is reversed (R2 never posted).

## Payout-shop commission (agent network)

When (and only when) a shop is enrolled as a cash-out agent:

1. Collect credits the **payout shop float wallet**, not a personal wallet.
2. Post R2 as `commission_postings` with `agent_user_id = payout_shop_id` and
   `source_type = cash_send_payout`.
3. Daily settlement nets: float drawdown vs commission vs activation balance.
4. Caps: per-voucher, per-day, and per-shop float floor. Below floor, the shop
   cannot pay out until they top up.

Keep the same-region collect check until inter-pool settlement exists.

## Merchant float top-up / rebalancing

Separate **sales wallet** (POS takings) from **cash-out float wallet**.

Top-up path:

1. Merchant EFT / cash deposit into the **safeguarded client-funds account**.
2. Bank statement import matches `merchant_id` + reference.
3. Only after exact match: credit that shop’s float wallet from regional escrow.
4. Rebalancing between shops is an ops job, not a merchant-to-merchant transfer.

Never let a shop pay out from uncleared sales takings.

## Safeguarded bank / client-funds account

Target (legal must still confirm):

- One South African bank account titled for **client funds**, not operating
  expenses.
- Ledger `system_escrow` per region must reconcile to that account every
  business day (Phase 6 CSV settlement contract).
- Platform R6 fee is swept to an **operating** account on a delay; it must not
  sit mixed with unpaid voucher principal.
- Activation fees (R600) are not client funds once recognised; until then they
  stay deferred.

This account is not created from git. Contract a bank that will open it and
accept the settlement CSV.

## Same-region limitation

Keep the same-pool collect rejection for the pilot.

National rollout needs, in order:

1. Per-pool escrow wallets already in the ledger.
2. An **inter-pool settlement account** (corridor) with a netting window
   (T+0 book, T+1 bank).
3. Explicit debit pool A escrow → corridor → credit pool B escrow before the
   payout shop in B can pay cash.
4. A corridor float cap. Above cap, cross-pool collect stays blocked.

Do not delete the same-region check until 2–4 are live and reconciled.

## Real-money Cash Send pilot gate

Low-limit pilot (suggested cap: R500 voucher, R2 000 per shop per day) only
after:

- 017–019 on the live DB (done 2026-08-21)
- API and worker proven on that DB
- Rotated ops credentials
- Redis + monitoring live
- Encrypted restore drill on file
- SMS + KYC/sanctions contracts
- Pentest + accountant + POPIA/FICA opinion
- One contracted settlement bank
- Safeguarded account open and first reconciliation green

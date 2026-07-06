# Money movement, float, and escrow (target architecture)

This document captures the recommended **central network float / escrow** model for KasiPay, and how it relates to today’s codebase.

---

## Recommended architecture

### Regional escrow (digital float)

- Maintain **one or a small number** of ledger accounts per region (or per corridor) labelled **Network Float / Escrow** (“KasiPay Escrow”).
- These are **not** normal merchant wallets; they are **system accounts** backed by pooled bank/settlement liquidity.

### Inbound flow (“Send” and similar customer-to-network movements)

1. Funds from **Send** (and other inward rails) are first recognised as credits to **Escrow** (or to a staged sub-ledger keyed by instruction).
2. User-facing balances can still show **“available”** once policy allows (immediate UX) while the **true settlement position** is Escrow + matching obligations.

### Payout / merchant settlement

1. When a **payout** to a paying spaza (or agent) is executed, the platform posts: **debit Escrow → credit that shop’s wallet** (or vice versa for reversals), with a clear **reference** tying back to the original send or batch.
2. **Netting**: many sends and payouts across shops offset inside Escrow; only the **net** need move in the banking layer (e.g. daily sweeps).

### Benefits (operational and risk)

| Benefit | Mechanism |
|--------|-----------|
| Shops don’t pre-fund other shops’ transfers | Liquidity sits in **Escrow**; shops fund their own wallet only as needed for their role. |
| Observable float | Escrow balance + per-region limits + alerts. |
| Bank reconciliation | Periodic **Escrow ↔ bank** movements match **net** platform position. |
| Isolation | A bad actor or failed settlement affects **controlled segments** (limits, holds), not arbitrary bilateral wallet exposure. |
| “Instant nationwide” UX | Digitally Instant book entries in Escrow + policy; settlement can lag bank reality within defined risk caps. |

---

## Current implementation (SQLite backend) — gap analysis

Today the system uses **user-bound wallets** (`wallets`) and immediate double-entry-style updates:

| Flow | Today | Escrow-aligned target |
|------|--------|------------------------|
| **P2P transfer** (`POST /transfers`) | Debit sender wallet, credit recipient wallet, `transactions.type = transfer`, status `completed` in one DB transaction | Optional: Debit sender → credit **Escrow** (pending); second leg **Escrow** → recipient on policy/payout; or keep instant book with **synthetic** Escrow mirror for reporting |
| **Cash Send create** | Sender → **regional escrow** (`postBetweenWallets`, type `cash_send_hold`); voucher still tracks state + PIN | Funds sit in `system_escrow` for that `pool_id` until collect, cancel, or expire |
| **Cash Send collect** | Escrow → collector for **principal** only (type `cash_send_collect`); **fee stays in escrow** as platform-side float | Matches payout-from-float; cross-pool collection is rejected |
| **Cash Send cancel / expire** | Escrow → sender for **principal + fee** (`cash_send_cancel_refund`, `cash_send_expire_refund`) | Refund path clears escrow liability |
| **Sales / wallet checkout** (`sales` + wallet) | Moves between customer and merchant wallets | Can remain bilateral or route via Escrow depending on product (optional) |

**Conclusion:** you already have **`transactions`** + **`ledger_entries`** — good primitives. What’s missing for the described model:

1. **System wallet rows** (or dedicated `ledger_accounts` not tied to `users`) for Escrow per region/pool.
2. **Explicit multi-leg postings** for send/settle (e.g. pending → settled) and idempotent payout jobs.
3. **Operational controls**: per-region caps, reconciliation jobs, immutable audit linkage from bank batch → ledger batch.

---

## Suggested ledger pattern (minimal extension)

Without changing UX on day one, you can evolve toward:

```
Leg 1 (send accepted):    user_wallet (-) , escrow_wallet (+)
Leg 2 (payout/release): escrow_wallet (-) , merchant_wallet (+)
```

Reuse one `transactions` row with `status = pending → completed` **or** two linked transaction IDs with a `correlation_id` (cleaner for audits).

**Cash Send** alignment:

- On create: `user_wallet → escrow` (instead of “disappear into voucher-only accounting”).
- On collect: `escrow → collector_wallet`.
- On cancel/expiry: `escrow → sender_wallet` (refund).

Voucher row remains the **instruction + state machine**; balances always tie to ledger lines on Escrow and user wallets.

---

## Implementation phases (practical rollout)

1. **Schema**: Add `wallet_kind` (`user` | `system_escrow`) or separate `pool_id` / `system_wallets` table; seed Escrow wallets per region in migration.
2. **Posting service**: Single module (e.g. `postLedgerMove`) enforcing invariants + writing `transactions` + `ledger_entries`.
3. **Migrate one flow**: Cash Send (visible, bounded) to use Escrow legs; simulate in dev first.
4. **Transfers**: Switch `POST /transfers` to two-leg escrow path **or** add **reporting mirror**-only Escrow if product needs instant pairwise settlement initially.
5. **Ops**: Daily job — compare Escrow book balance vs bank CSV; alerting on drift; freeze rules.

---

## Compliance and product notes

- **Customer communication**: If funds are “instant” in-app but settlement is deferred, disclosures and Ts&Cs must match regulatory expectations in your jurisdictions.
- **Fees**: Decide whether fees accrue to Escrow, platform revenue ledger, or merchant wallet explicitly; mirror each fee as its own ledger line.

---

## Schema (implemented)

- **`users.country_code`** — ISO 3166-1 alpha-2 (default `ZA`). Used with wallet pool for regional isolation.
- **`users.is_system`** — `1` for internal identities (e.g. escrow holder); excluded from admin user list and cannot log in.
- **`wallets.pool_id`** — Ledger pool (matches country for now; one Escrow row per pool).
- **`wallets.wallet_kind`** — `user` | `system_escrow`.
- **Seeded row** — ZA network float wallet via `poolConstants.ts` + `seedEscrowPoolZa` in `db.ts`.
- **API** — `GET /wallets/me` returns `poolId` and `walletKind`; public user includes `countryCode`.

## File references

- Transfers: `backend/src/routes/transfers.ts`
- Cash Send: `backend/src/routes/cashSendRoutes.ts`
- Wallet sales movements: `backend/src/routes/sales.ts`
- Schema & escrow seed: `backend/src/db.ts`, `backend/src/poolConstants.ts`
- Ledger tables: `transactions`, `ledger_entries`

# Safeguarding reconciliation

This is a **software control model**. The git repository cannot open a real
client-funds bank account. Contracting a bank remains **BLOCKED**.

## Entities

- `bank_accounts` with purpose `client_funds | operating | settlement | suspense`
  and `approved` (matching requires an approved `client_funds` row plus a
  `safeguarding_accounts` link)
- Unique bank-transaction backing for merchant float top-ups
- `safeguarding_accounts` (pool + currency → bank account)
- `safeguarding_reconciliations` (daily report rows)

## Daily report

```
expected_client_funds_cents
  = merchant_float liabilities
  + customer user-wallet liabilities
  + outstanding Cash Send principal
actual_client_funds_cents   = reported bank client-funds balance (or null)
difference_cents
status = balanced | shortfall | surplus | unknown
```

Recognised KasiPay operating revenue (earned/swept platform fees) is **excluded**
from client liabilities.

## Shortfall

If `status = shortfall`:

1. Emit a CRITICAL structured alert (`safeguarding.shortfall`)
2. Disable the financial posting control (kill-switch)
3. Do **not** invent a correcting journal

Ops reviews `GET /ops/safeguarding` and `POST /ops/safeguarding/run`.

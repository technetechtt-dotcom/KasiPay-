# Commercial pricing and POS (in-repo)

This is the in-repo implementation of the R9 Cash Send fee, R600 activation, sale voids, and Playwright coverage. External items (pentest, legal opinions, contracted rails, Google Play) stay on `docs/external-assurance-track.md`.

## Cash Send fee (versioned)

Schedule `CASH_SEND_STANDARD` version 2 is the published commercial tariff:

| Total customer fee | KasiPay (platform) | Merchant |
|---|---|---|
| R9.00 (900 cents) | R6.00 | R3.00 |

Version 1 (R10, 50/50 agent/platform) is retired by migration `018_cash_send_r9_pricing.js`. Allocations are exact integer cents: remainder always lands on the platform component.

Cancel / expire / refund claws back the fee via `reverseFeeAccrualPg` and posts reversing `commission_postings` rows so merchant commission is not kept after a reversal.

Merchant statement: `GET /api/commissions/me/statement?from=&to=`
Platform revenue: `GET /api/ops/platform-revenue?from=&to=` (finance capability)

## R600 merchant activation

`merchant_activations` records:

- fee amount (default 60000 cents)
- payment status / reference / receipt path
- activation date
- programme/sponsor
- waived/discounted
- onboarding completion
- agreement acceptance
- accounting treatment (`unrecognised` → `activation_revenue` or `waived_sponsorship`)

Merchant routes:

- `POST /api/merchants/me/activate`
- `POST /api/merchants/me/activation/accept-agreement`
- `POST /api/merchants/me/activation/pay`
- `POST /api/merchants/me/activation/complete-onboarding`

Waivers require maker-checker action `merchant_activation_waiver` then `POST /api/ops/merchant-activations/:id/waive`.

## POS

- Discounts on Shop checkout (percent or amount)
- Receipts on sale complete and History
- `POST /api/sales/:id/void` restocks and reverses wallet payments

## Secret scanning

CI job `secret-scan` runs gitleaks on every push (full history). Operator reset credentials must never be committed; use `npm run ops:rotate-operator` with env vars.

## Playwright

`npm run test:e2e` starts Vite and runs Chromium journeys with a mocked API: login, POS sale + discount, Cash Send entry.

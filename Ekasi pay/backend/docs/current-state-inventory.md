# Phase 0 current-state inventory

Last reviewed: 2026-07-21. This is an engineering inventory, not legal approval.

## Money domains, APIs, and primary records

- Wallet transfers: `POST /api/transfers`; `wallets`, `transactions`, `ledger_entries`, `compliance_flags`.
- Merchant sales and credit: `POST /api/sales`, `/api/credit/transactions`; `sales`, `credit_customers`, `credit_transactions`.
- Cash Send hold, collection, cancellation: `/api/cash-send*`; `cash_send_vouchers`, wallet/ledger records, commission records.
- Lending: `/api/loans*`; `loans`, wallet/ledger records.
- Utilities: `POST /api/utility-purchases`; `utility_purchases`, wallet/ledger records.
- Stokvel: `/api/stokvel*`; `stokvel_groups`, `stokvel_loans`, `stokvel_contributions`.
- Insurance: `/api/insurance*`, `/api/admin/insurance/claims*`; `insurance_policies`, `insurance_claims`.
- Reconciliation and investigation: `/api/admin/reconciliation/run`, admin monitoring/audit endpoints; read-only except the explicit reconciliation run.

## PII categories

- Identity/contact: names, phone numbers, physical addresses, country, business details.
- High-risk identity data: SA ID/document values captured for Cash Send and hashed credit-verification identifiers.
- Authentication/security: PIN hashes, refresh-session material, reset/OTP hashes, device/install and request identifiers.
- Financial/behavioral: balances, transaction history, purchases, debts, loan terms, beneficiaries, utility accounts, stokvel membership/contributions.
- Compliance: KYC status, merchant documents and metadata, review outcomes, flags, reviewer/audit identifiers.

External decisions required: retention periods, lawful bases, data-subject processes, cross-border/provider transfers, record-of-processing ownership, and breach-notification obligations.

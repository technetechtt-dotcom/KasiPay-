# Ekasi Pay Ops Dashboard

Static monitoring UI for Ekasi Pay. It uses the **same backend** as the merchant app (`ekasi-pay-api`) — there is no separate ops Node server.

## What it does

- Platform overview (users, wallets, 24h volume, open compliance flags)
- User search and detail
- Cash Send vouchers
- Compliance flags, audit events, transactions
- Ledger reconciliation snapshot

Admin **writes** (suspend users, approve merchants, resolve flags) stay in the main app: **More → Admin Tools**.

## Architecture

```
┌─────────────────────┐     HTTPS /api/*      ┌──────────────────┐
│  ops-dashboard      │ ─────────────────────► │  ekasi-pay-api   │
│  (static Vite UI)   │   admin phone + PIN    │  (one backend)   │
└─────────────────────┘                        └────────┬─────────┘
                                                        │
                                                        ▼
                                                 Postgres (Neon)
```

## Local development

1. Start the main API (`Ekasi pay/backend`) on port 8787.
2. In this folder:

```bash
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:8787`.

3. Sign in with an **admin** phone + PIN (same account as More → Admin Tools).

## Production (Render)

- Service type: **static**
- Build: `npm install && npm run build`
- `API_HOST` / `VITE_API_URL` → main API host
- On `ekasi-pay-api`, set `FRONTEND_ORIGINS` to include both the web app and ops origins (comma-separated)

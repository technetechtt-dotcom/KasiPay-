# Ekasi Pay Ops Dashboard

Standalone **read-only** monitoring console for Ekasi Pay. It runs as its own process and deployment — it is **not** mounted on the main API (`backend/`).

## What it does

- Platform overview (users, wallets, 24h transaction volume, open compliance flags)
- User search and detail (wallet, merchant profile, flags, recent transactions)
- Compliance flags, audit events, recent transactions
- Read-only ledger reconciliation snapshot

## Architecture

```
┌─────────────────────┐     read-only      ┌──────────────────┐
│  ops-dashboard      │ ──────────────────► │  Postgres / SQLite │
│  port 8790        │                     │  (same as main API)│
└─────────────────────┘                     └──────────────────┘
         ▲
         │ HTTPS (separate host, e.g. ops.yourdomain.com)
         ▼
   Operator browser
```

The main Ekasi Pay API is unchanged. Ops staff never use merchant admin routes in the consumer app for platform monitoring.

## Local development

1. Ensure the main API has data (SQLite at `backend/data/ekasi-pay.db` or Postgres).

2. Configure ops dashboard:

```bash
cd ops-dashboard
cp .env.example .env
# Set OPS_DASHBOARD_PASSWORD (plain text OK in dev)
```

3. Install and run (API + Vite UI):

```bash
npm install
npm run dev
```

- Ops API: http://localhost:8790
- UI: http://localhost:5174 (proxies `/ops-api` to 8790)

Default dev password from `.env.example`: `change-me-ops-password`

## Production deployment

Deploy **only** the `ops-dashboard` package to a separate host (or private network):

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

Set in environment:

| Variable | Required | Notes |
|----------|----------|-------|
| `OPS_JWT_SECRET` | Yes | ≥ 32 random chars |
| `OPS_DASHBOARD_PASSWORD` | Yes | **Bcrypt hash** (not plain text) |
| `OPS_DASHBOARD_ORIGIN` | Yes | Public URL of this dashboard |
| `DATABASE_URL` | Recommended | Postgres read-only user on Neon |
| `OPS_PORT` | No | Default `8790` |

Generate bcrypt password:

```bash
node -e "import('bcryptjs').then(b=>b.hash('your-strong-password',12).then(console.log))"
```

### Postgres read-only user (recommended)

Create a Neon/user with `SELECT` only on Ekasi Pay tables. Point `DATABASE_URL` at that role so the ops service cannot mutate merchant data even if compromised.

## Security notes

- **Read-only** DB connection (SQLite opens with `readonly: true`)
- Separate operator auth (not Ekasi Pay user JWTs)
- No write endpoints — suspend users / disburse loans remain on main API admin routes
- Restrict network access (VPN, IP allowlist, or private subnet)

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Ops API + Vite dev UI |
| `npm run build` | Build static UI to `dist/` |
| `npm start` | Run ops server (serves `dist/` if present) |
| `npm run typecheck` | TypeScript check |

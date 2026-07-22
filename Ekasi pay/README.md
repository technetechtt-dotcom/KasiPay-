# Ekasi Pay — application operations

Ekasi Pay is a Capacitor + React shop app with an Express API. PostgreSQL is
required in deployed environments; SQLite is retained for local development and tests.

Roadmap controls:

- [Critical financial controls](backend/docs/critical-financial-controls.md)
- [Phase 8 release readiness](backend/docs/phase8-release.md) (CI, production gate, rollback)
- [Phase 6 settlement, provider, fee and reversal engineering](backend/docs/phase6-settlement-providers-fees.md)
- [API versioning](backend/docs/api-versioning.md) (`/api` compatibility + `/api/v1`)

## 1. One-machine dev

- **Frontend** (repo root folder `Ekasi pay`): `npm install` then `npm run dev` — Vite proxies `/api` → `http://localhost:8787` (see `vite.config.ts`).
- **Backend**: `cd backend && npm install && npm run dev` — listens on port **8787** by default.
- **Smoke API** (starts compiled server against a temp DB): `cd backend && npm run smoke`.

## 2. Hosted API & mobile builds

Production and Android WebView installs **must** set `VITE_API_URL` before `npm run build` (same origin `/api` is only for desktop dev proxy).

Example `.env` in the frontend app directory:

```
VITE_API_URL=https://api.your-domain.example
VITE_APP_VERSION=pilot-2026-05-10
```

Rebuild the web bundle, then Capacitor sync:

```bash
npm run mobile:build
```

## 3. Android networking

- **Release** APK: HTTPS API recommended. `network_security_config.xml` blocks cleartext by default outside listed dev hosts.
- **Debug** builds merge `android/app/src/debug/AndroidManifest.xml` with `usesCleartextTraffic="true"` so you can aim a LAN HTTP API during pilots.
- For **HTTPS** TLS APIs, matching hostname + valid cert — no manifest tweak needed.

## 4. Server CORS (production)

Express uses `NODE_ENV === 'production'` CORS whitelist from:

- `FRONTEND_ORIGINS` — comma-separated SPA origins, e.g.  
  `https://app.example.com,https://localhost` (include Capacitor’s `https://localhost` if you load from that origin).
- If unset, falls back to `FRONTEND_ORIGIN` (single string).

## 5. Auth, sessions, rate limits

- **Access tokens** are short-lived JWTs kept **in-memory only** (no localStorage) so they're not exposed to XSS exfiltration. They are minted from the refresh token on page reload.
- **Refresh tokens** live in `sessionStorage` and rotate on `/api/refresh`. Sessions have an **absolute hard cap** (`REFRESH_ABSOLUTE_TTL_SEC`, default **30 days**) regardless of activity — users must sign in again after that.
- **Reuse detection**: if a previously rotated refresh token is replayed, **all** of that user's sessions are revoked (likely token leak).
- **Per-user PIN lockout**: 5 consecutive bad PINs lock the account for 5 min, 10 for 30 min; counter resets on a successful login or 30 min of inactivity.
- **Rate limits**: separate per-IP buckets for `/api/login` & `/api/register` (`LOGIN_RATE_LIMIT_PER_MIN`, default **20**/IP/min), `/api/refresh` (6× higher, for background tabs), and `/api/pin-reset/*` (10/IP/min).
- **Logout** calls `/api/logout` to revoke the server session row when online.
- **`JWT_SECRET` is mandatory in production** — the API refuses to start with the dev fallback or a value shorter than 32 chars. `BCRYPT_ROUNDS` is also env-configurable (default 12, bounded 8–14).

## 5b. Forgot PIN & account deletion

- `POST /api/pin-reset/request` with `{ phone }` issues a 6-digit code (10-min TTL). Dev builds log the code to the server console **and** echo it in the response body — wire your SMS provider in production by replacing the `console.info` in `routes/me.ts`.
- `POST /api/pin-reset/confirm` validates the code, sets the new PIN, clears failed-PIN counters, and revokes all sessions.
- `DELETE /api/me` soft-deletes the user (sets `deleted_at`, anonymises name/phone), closes the wallet if its balance is zero, revokes all sessions. Requires the current PIN **and** the literal phrase `DELETE MY ACCOUNT` as confirmation.

## 6. Data, migrations, and backup

Cash Send flows persist ID-related fields in **`DATABASE_PATH`** (see `backend/.env.example`). Before any pilot:

1. Decide retention with your sponsor.
2. Schedule file copies of `ekasi-pay.db` (stop API briefly or use SQLite backup tooling for cleaner snapshots).
3. Store backups encrypted at rest where possible.

For staging/production, set `DATABASE_URL`, run `npm ci`, then
`npm run migrate:validate && npm run migrate:up` in `backend/` before starting
the release. The API refuses to start with pending or unknown schema versions.
Existing Neon baseline and rollback guidance is in
`backend/docs/postgresql-migrations.md`.

## 7. iOS camera (future)

When adding an Xcode target, set **Privacy - Camera Usage Description** (`NSCameraUsageDescription`) explaining barcode scan for IDs and inventory.

## 8. Diagnostics

- Clients send `X-Request-Id` per request (see `src/services/api.ts`).
- Server echoes `X-Request-Id` and logs `{requestId} METHOD path → status`.
- In-app **Account Settings → Diagnostics → Copy** includes URL, online flag, recent client-side error strings.

## 9. Automated smoke checklist

`cd backend && npm run smoke` boots a freshly-compiled API against a throw-away SQLite file and exercises:

1. `GET /health`
2. Auth lifecycle: register → `/api/me` → `/api/refresh` → `/api/logout`
3. Sales: product create → sale create → `/api/reports/income-statement`
4. Credit book: customer create → purchase posting
5. Per-user PIN lockout: 6 bad logins must escalate to HTTP 423 / 429

Frontend tests: `npm test` (Vitest) covers hydration, login flow, and the no-token start case.

## 9b. Admin tools

When signed in as a user with role `admin`:

- `GET /api/admin/compliance/flags` + `PATCH /api/admin/compliance/flags/:id` to review/clear KYC flags.
- `POST /api/admin/reconciliation/run` returns wallets whose `balance` diverges from the sum of `ledger_entries` (tolerance 0.01). The Admin Console exposes both as buttons.
- Loan disbursement: `PATCH /api/loans/:id/disburse` moves funds from the regional escrow into the borrower's wallet. Borrowers repay via `POST /api/loans/:id/repayments`.

## 10. Camera / scanner field tips

Documented in-app under **Help → Field pilot — quick steps**. Prefer USB retail scanners for dense barcodes; use extra light for phone cameras.

## 11. Ops dashboard (static UI → main API)

Platform monitoring is a **static Vite UI** in **`ops-dashboard/`**. It talks to
the **same Express API** as the merchant app (`/api` or `/api/v1`). There is no
separate ops database server.

```bash
# Start ekasi-pay-api on port 8787 first, then:
cd ops-dashboard
cp .env.example .env
npm install
npm run dev
```

Production serves the built static files (`npm start` on port **8790** by
default) and points `API_HOST` / `VITE_API_URL` at the main API. See
`ops-dashboard/README.md`.

## 12. Production readiness gate

Before enabling posting or gated products in production:

```bash
cd backend
cp evidence/production-readiness.example.json evidence/production-readiness.json
# Record real approvals + artifact digests only — never invent status=approved.
NODE_ENV=production RELEASE_SHA=<git-sha> DATABASE_URL=postgresql://... \
  npm run production:ready
```

Details: [phase8-release.md](backend/docs/phase8-release.md).

---

See also `backend/.env.example` and root `.env.example` for tunable env vars.

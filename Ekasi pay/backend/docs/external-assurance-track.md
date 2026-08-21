# External assurance track (parallel)

This track cannot be completed from the repository. Use it to book owners and
store evidence URIs — never invent `status=approved` rows.

| Workstream | Owner | Artifact / evidence | Target date | Status |
|---|---|---|---|---|
| Penetration test + high remediations | Security firm | Private report URI + ticket list | | Open |
| Accounting / ledger model sign-off | Finance auditor | `docs/accounting-signoff-template.md` signed | | Open |
| POPIA / FICA / payment-services advice | Legal | Opinion letter URI | | Open |
| Live SMS provider contract | Product | Contract + staging credentials | | Open |
| Sanctions / PEP provider | Product + Compliance | Contract + callback test | | Open |
| Private KYC storage + malware scan | Platform | Signed URLs + scan worker proof | | Open |
| Audit sink | Platform | Delivery ACK for synthetic event | | Open |
| IR tabletop + on-call roster | Ops | Dated tabletop notes + roster | | Open |
| Host restore drill (RTO/RPO) | Platform | Encrypted restore drill report | | Partial — Neon branch fork 2026-08-21; encrypted dump pending |
| Non-funds merchant pilot (5–10) | Product | Pilot diary; money flags stay false | | Open |
| Funds pilot / single payment route | Product + Legal | Only after production-readiness evidence | | Blocked |

## Infrastructure evidence (partial)

| Check | Evidence | Status |
|---|---|---|
| Neon project `KasiPay` (`purple-unit-69145144`) | Production branch `br-falling-truth-add7cqi1` answered `SELECT NOW()` (2026-08-03) | Proven reachable |
| Neon schema health | 171 public tables; `schema:verify` missing=none (2026-08-21) | Proven |
| Phase 4–9 / commercial tables | Migrations 001–019 applied on production branch `br-falling-truth-add7cqi1` (019 at 2026-08-21T10:18:04Z) | Proven on this DATABASE_URL |
| Render API `https://ekasi-pay-api.onrender.com/health` | `200` `{"ok":true,"service":"ekasi-pay-api","nonFunds":true}` (2026-08-21) | Proven reachable |
| Ops CORS | `OPTIONS /api/admin/overview` from `https://ekasi-ops-dashboard.onrender.com` → `204` + matching `Access-Control-Allow-Origin` (2026-08-12) | Proven |
| Web + ops hosts | `https://ekasi-pay-web.onrender.com/` and `https://ekasi-ops-dashboard.onrender.com/health` returned `200` (2026-08-12) | Proven reachable |
| Render API `DATABASE_URL` → same Neon | Local ops URL is production pooler; API `/health/ready` reports `database: ready`. Worker leases/runs on this DB are empty | API likely same; worker unproven |
| `ekasi-pay-reconcile-worker` live | `reconciliation_job_leases` and `reconciliation_runs` = 0 on Neon (2026-08-21) | Open |
| `MONITORING_DSN` / `ALERT_ROUTING_MARKER` | Unset; `/health/ready` Redis also `configured: false` | Open |
| Gitleaks full-history scan | 103 commits, no leaks (2026-08-21) — `docs/evidence/gitleaks-2026-08-21.txt` | Proven this scan |
| Neon PITR restore drill | Fork `br-cool-heart-adryjyas` readable; encrypted host dump still pending | Partial |
| Ops admin `ivanij` password rotation | `password_changed_at` still 2026-08-07 | Open — rotate with `ops:rotate-operator` |
| Real `VITE_SUPPORT_*` on `ekasi-pay-web` | Help page email `ivanjohnsonijj@gmail.com` (phone/WhatsApp omitted — do not invent numbers) | In repo; confirm after next web deploy |

## Non-funds pilot rehearsal checklist

See `docs/non-funds-pilot-rehearsal.md`.

1. Tip SHA CI green on `main`
2. Help page shows at least one real contact (email is enough)
3. Offline cash sale + restock + new product queue on a physical device
4. Outbox flush after reconnect; stock/sales match server
5. Cash Send / lending / insurance / utilities remain disabled notices
6. Capture diagnostics log sample for support

## Ops live proof

```bash
cd "Ekasi pay/backend"
npm run ops:prove-public   # no secrets; public /health + CORS
# with Render/Neon/monitoring/support env loaded:
npm run ops:verify-live
npm run alerts:verify   # when MONITORING_DSN is set
```

Confirm Render worker logs contain `reconciliation.worker_started`.

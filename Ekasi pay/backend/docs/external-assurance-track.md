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
| Host restore drill (RTO/RPO) | Platform | Encrypted restore drill report | | Open |
| Non-funds merchant pilot (5–10) | Product | Pilot diary; money flags stay false | | Open |
| Funds pilot / single payment route | Product + Legal | Only after production-readiness evidence | | Blocked |

## Non-funds pilot rehearsal checklist

1. Tip SHA CI green on `main`
2. Real `VITE_SUPPORT_*` set on web service
3. Offline cash sale + restock + new product queue on a physical device
4. Outbox flush after reconnect; stock/sales match server
5. Cash Send / lending / insurance / utilities remain disabled notices
6. Capture diagnostics log sample for support

## Ops live proof

```bash
cd "Ekasi pay/backend"
# with Render/Neon/monitoring/support env loaded:
npm run ops:verify-live
npm run alerts:verify   # when MONITORING_DSN is set
```

Confirm Render worker logs contain `reconciliation.worker_started`.

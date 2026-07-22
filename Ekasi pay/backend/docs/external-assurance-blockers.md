# External assurance blockers

These items cannot be completed from the repository alone. They remain required
before enabling regulated products or live customer funds.

| Item | Owner | Status |
|---|---|---|
| External accounting / ledger model review | Named finance auditor | **Blocked** — schedule review against `docs/critical-financial-controls.md` and reconcile script outputs |
| External penetration test + high-severity remediation | Named security firm | **Blocked** — engage after staging with production-like data |
| Certified payment / utility provider integration | Product + provider | **Blocked** — requires contracted credentials and certification evidence |
| Private KYC object storage + malware scanner live wiring | Platform ops | Engineering adapters exist; production credentials and scanner callbacks must be connected |
| Centralized monitoring alert routing proof | Platform ops | Configure `MONITORING_PROVIDER`/`MONITORING_DSN` and verify paging to on-call |
| Settlement end-to-end with live provider statements | Finance ops | Requires contracted settlement files |

Regulated product flags must remain `false` until the matching evidence rows are
approved in `evidence/production-readiness.json`.

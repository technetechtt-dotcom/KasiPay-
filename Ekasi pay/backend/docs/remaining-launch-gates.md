# Remaining launch gates

This list is what software **cannot** close by itself. Code for bank
finality, OTP hardening, float/cash UI, safeguarding sign-off, and schema
fingerprints is in the tree. Live Cash Send still depends on humans.

## Must stay false until contracted rails exist

- `FINANCIAL_POSTING_ENABLED`
- `CASH_SEND_ENABLED`
- lending / insurance / stokvel money movement / live utilities

`NON_FUNDS_PRODUCTION=true` remains the public deploy posture.

## Not a software checkbox

| Gate | Status |
| --- | --- |
| Sponsor bank / payment-institution contract | Open |
| Segregated client-funds account in a real bank | Open |
| Legal opinion (NPS classification, safeguarding, e-money) | Open |
| FICA / AML / PEP / sanctions operating programme | Policy drafts only |
| POPIA Information Officer + live DSAR/breach process | Partial in software |
| Real Stitch / Peach / bank payout adapter + sandbox+prod credentials | Blocked on contract |
| External pentest of merchant app, ops, Cash Send, KYC, webhooks | Not run |
| Independent accounting review of the ledger | Not run |
| VAT treatment of the R9 Cash Send fee | Finance decision |
| Production Redis with TLS + auth | Config required (`RATE_LIMIT_REDIS_URL`) |
| Dedicated Render reconciliation worker + 5-minute heartbeat | Deploy required |
| Encrypted backup restore drill with `BACKUP_ENCRYPTION_PASSPHRASE` | Ops required |
| Migrations **022–024** on production Neon | **Do not apply** while the old API is live |
| 5–10 real spaza shops for a non-funds pilot | Field ops |
| DSBD/SEDFA R600 activation programme | Pilot ops |
| PayShap / Flash / Eezi / Kazang | P2 — after own network works |

## Production origin

Render `autoDeployTrigger: checksPass` is the deploy gate. Do not manually
deploy a SHA whose GitHub `validate` job failed. A GitHub required-status
check on `main` would block the direct-push shipping rule (fresh SHAs have
no CI result yet). Tag a release candidate only after `validate` is green:

```
cd "Ekasi pay/backend"
node scripts/release-candidate.mjs
```

## Schema parity

`GET /health/ready` returns `schemaFingerprint` and the latest reconciliation
worker heartbeat. A fingerprint mismatch means API and worker are not on the
same migration set — do not run money posting.

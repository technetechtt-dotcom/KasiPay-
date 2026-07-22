# Brownfield production database migration sequence

This is the only supported path for an existing database that may still hold
Cash Send plaintext PII. Do **not** rely on a bare `npm run migrate:up` as the
sole production deploy command.

Render `preDeployCommand` is `npm run migrate:deploy`.

## Preconditions

- `FINANCIAL_POSTING_ENABLED=false` and all regulated product flags remain false.
- Disposable Neon branch (or restored clone) available for rehearsal.
- Encryption key and `PII_HASH_PEPPER` configured (distinct secrets).

## Exact sequence

1. **Backup**
   - `BACKUP_BEFORE_PII_DROP=1` (deploy script) or `npm run backup:postgres`
   - Record backup URI / Neon PITR timestamp in evidence.
2. **Restore drill**
   - `RESTORE_MODE=neon_branch` (or `pg_restore`) via `npm run restore:drill`
   - Verify row counts and migration status on the restored copy.
3. **Apply through migration 010**
   - `npm run migrate:up` (or `migrate:deploy` first pass)
   - Confirm `010_encrypt_cash_send_pii` is in `schema_migrations`.
4. **PII backfill**
   - `npm run cash-send:backfill-pii`
   - Confirm every sensitive field has an encrypted copy / hash.
5. **Confirm zero plaintext**
   - Query must return 0 rows with non-empty plaintext PII columns.
6. **Apply migrations 011–014+**
   - `npm run migrate:up` (drops plaintext in 011, journal trigger 012, KYC evidence 013, reconcile queue 014)
7. **Confirm plaintext columns gone**
   - `information_schema.columns` must not list the dropped Cash Send plaintext columns.
8. **Reconcile**
   - `npm run money:reconcile`
   - `npm run ledger:reconcile`
   - `npm run money:drift-inventory` → `money:remediate-drift` (maker-checker) → `money:prove-zero-drift`
9. **Rollback / recovery rehearsal**
   - On a disposable DB only: restore backup, re-run sequence, compare journal hashes.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `011` exception “plaintext PII still present” | Backfill not finished | Run `cash-send:backfill-pii`, then migrate again |
| Wallet/ledger drift | Pre-existing dual-write gaps | Alignment journals via maker-checker — never direct `UPDATE wallets` |
| Deploy used raw `migrate:up` only | Unsafe for brownfield | Switch to `migrate:deploy` |

## Sign-off artifacts

Retain backup URI, restore-drill report, migrate status, backfill counts, drift
remediation JSON, and three consecutive zero-drift proof cycles under
`evidence/production-readiness.json`.

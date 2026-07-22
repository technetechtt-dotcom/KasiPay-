# Brownfield Cash Send PII deployment sequence

Migration `011` refuses to drop plaintext columns while any plaintext remains.
Render previously ran `npm run migrate:up` directly, which could reach `011`
before backfill on an existing database.

## Required sequence

Use `npm run migrate:deploy` (wired as Render `preDeployCommand`):

1. Apply migrations through `010_encrypt_cash_send_pii`.
2. Optional: set `BACKUP_BEFORE_PII_DROP=1` to run `backup:postgres` before drop.
3. Run `cash-send:backfill-pii` when plaintext rows remain.
4. Confirm **zero** plaintext rows.
5. Apply migrations `011`–`013+`.
6. Verify plaintext columns are gone.

Manual equivalent:

```bash
npm run migrate:up          # stops with exception if 011 sees plaintext
npm run cash-send:backfill-pii
npm run migrate:up          # applies 011+
```

CI already mirrors this pattern (`migrate:up` → backfill → `migrate:up`).

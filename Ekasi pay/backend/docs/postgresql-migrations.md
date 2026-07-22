# PostgreSQL migrations and route extraction

## Deployment sequence

PostgreSQL is mandatory whenever `NODE_ENV` is not `development` or `test`.
SQLite is supported only for local development and tests.

Run these commands from `backend/` with the release `DATABASE_URL`:

1. `npm ci`
2. `npm run migrate:validate` (filesystem validation; no database required)
3. `npm run migrate:status` (exit code 2 means pending/unknown versions)
4. `npm run migrate:up`
5. `npm run migrate:status`
6. `npm run build`
7. `npm start`

`node-pg-migrate` owns `public.schema_migrations`, takes a PostgreSQL advisory
lock, checks ordering, and applies all pending forward migrations in one
transaction. Application startup only verifies that migration history exactly
matches the release; it never creates or alters tables.

## Existing databases and the baseline

`001_baseline.js` is the former `dbPg.ts` bootstrap. Its DDL uses
`CREATE ... IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`, so the preferred
cutover for an existing Neon database is:

1. Take and verify a provider backup.
2. Run `npm run migrate:validate`.
3. Run `npm run migrate:up`; this safely reconciles the idempotent baseline and
   records it in `schema_migrations`.
4. Run `npm run migrate:status`, then start the application.

If a DBA has independently verified that all baseline objects already match,
the baseline can be marked without executing domain DDL:

```bash
ALLOW_FAKE_BASELINE=1 npm run migrate:baseline
```

The command refuses to run unless core tables exist. Applying the idempotent
baseline is safer because it also adds any missing optional columns/indexes.
Never fake a later migration.

Every later schema change gets a new monotonically numbered migration. Do not
edit a migration after it has reached a shared environment. Baseline rollback
is intentionally disabled; restore a backup for destructive recovery.

## Paired route extraction pattern

Transfers are the first shared seam:

- `domain/transfers.ts` owns storage-independent policy and errors.
- `repositories/transferPgRepository.ts` owns PostgreSQL queries and the atomic
  posting transaction.
- `routes/transfersPg.ts` owns HTTP validation/authentication and mapping only.

For each later SQLite/PostgreSQL route pair, first capture parity tests, extract
shared policy into `domain/`, implement a typed repository per datastore, then
make both routers thin adapters. Migrate one paired flow at a time. Do not make
the domain layer import Express, `pg`, or SQLite. SQLite adapters remain
development/test-only and can be removed after route parity is complete.

import 'dotenv/config';

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

const { Client } = pg;
const directory = path.resolve(process.cwd(), 'migrations');
const migrationsTable = 'schema_migrations';
const migrationsSchema = 'public';
const lockValue = 6_052_971_151;
const filePattern = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.(?:js|sql)$/;

function databaseConfig() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for database migration commands.');
  }
  const url = new URL(connectionString);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const rejectUnauthorized =
    process.env.PG_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase() !== 'false';
  return {
    connectionString,
    ssl: local ? false : { rejectUnauthorized },
  };
}

async function definitions() {
  const files = (await readdir(directory))
    .filter((file) => !file.startsWith('.'))
    .map((file) => {
      const match = filePattern.exec(file);
      if (!match) {
        throw new Error(`Invalid migration filename "${file}".`);
      }
      return {
        file,
        name: file.replace(/\.(?:js|sql)$/, ''),
        sequence: Number(match[1]),
      };
    })
    .sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));

  if (files.length === 0) throw new Error('No migrations found.');
  const sequences = new Set();
  for (const migration of files) {
    if (!Number.isSafeInteger(migration.sequence)) {
      throw new Error(`Unsafe migration sequence in ${migration.file}.`);
    }
    if (sequences.has(migration.sequence)) {
      throw new Error(`Duplicate migration sequence ${migration.sequence}.`);
    }
    sequences.add(migration.sequence);
    if (migration.file.endsWith('.js')) {
      const module = await import(pathToFileURL(path.join(directory, migration.file)));
      if (typeof module.up !== 'function') {
        throw new Error(`${migration.file} must export an up function.`);
      }
    }
  }
  return files;
}

function runnerOptions(extra = {}) {
  return {
    databaseUrl: databaseConfig(),
    dir: directory,
    migrationsTable,
    migrationsSchema,
    direction: 'up',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
    lockValue,
    ...extra,
  };
}

async function validate() {
  const files = await definitions();
  console.log(`Validated ${files.length} ordered forward migration(s).`);
}

async function appliedMigrationNames() {
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    const table = await client.query(
      'SELECT to_regclass($1)::text AS table_name',
      [`${migrationsSchema}.${migrationsTable}`],
    );
    if (!table.rows[0]?.table_name) return new Set();
    const applied = await client.query(
      `SELECT name FROM "${migrationsSchema}"."${migrationsTable}"`,
    );
    return new Set(applied.rows.map((row) => row.name));
  } finally {
    await client.end();
  }
}

async function up() {
  await validate();
  const appliedNames = await appliedMigrationNames();
  const existingInstall = appliedNames.has('001_baseline');
  if (
    existingInstall &&
    !appliedNames.has('002_expand_integer_money')
  ) {
    throw new Error(
      'Existing database requires the staged money rollout. Run migrate:expand, deploy the cents-only application, reconcile, then run migrate:contract after sign-off.',
    );
  }
  if (
    existingInstall &&
    appliedNames.has('002_expand_integer_money') &&
    !appliedNames.has('003_contract_legacy_money')
  ) {
    throw new Error(
      'Money contract migration is pending. Run money:reconcile and use migrate:contract only after backup and written sign-off.',
    );
  }
  const applied = await runner(runnerOptions());
  console.log(
    applied.length > 0
      ? `Applied ${applied.length} migration(s).`
      : 'Database schema is already current.',
  );
}

async function applyMoneyPhase(phase) {
  await validate();
  const file =
    phase === 'expand'
      ? '002_expand_integer_money'
      : '003_contract_legacy_money';
  if (phase === 'contract' && process.env.ALLOW_MONEY_CONTRACT !== '1') {
    throw new Error(
      'Refusing money contract. Set ALLOW_MONEY_CONTRACT=1 only after backup, reconciliation, observation window, and written sign-off.',
    );
  }
  const applied = await runner(runnerOptions({ file }));
  console.log(
    applied.length > 0
      ? `Applied ${file}.`
      : `${file} is already applied.`,
  );
}

async function status() {
  const files = await definitions();
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    const table = await client.query(
      'SELECT to_regclass($1)::text AS table_name',
      [`${migrationsSchema}.${migrationsTable}`],
    );
    const applied =
      table.rows[0]?.table_name
        ? await client.query(
            `SELECT name, run_on FROM "${migrationsSchema}"."${migrationsTable}" ORDER BY id`,
          )
        : { rows: [] };
    const appliedNames = new Set(applied.rows.map((row) => row.name));
    for (const migration of files) {
      console.log(`${appliedNames.has(migration.name) ? 'up     ' : 'pending'} ${migration.name}`);
    }
    const unknown = applied.rows.filter(
      (row) => !files.some((migration) => migration.name === row.name),
    );
    for (const migration of unknown) console.log(`unknown ${migration.name}`);
    if (
      files.some((migration) => !appliedNames.has(migration.name)) ||
      unknown.length > 0
    ) {
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

async function baseline() {
  if (process.env.ALLOW_FAKE_BASELINE !== '1') {
    throw new Error(
      'Refusing to mark the baseline. Set ALLOW_FAKE_BASELINE=1 after DBA schema verification.',
    );
  }
  const files = await definitions();
  if (files[0]?.name !== '001_baseline') {
    throw new Error('The expected 001_baseline migration is missing.');
  }
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    const result = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['users', 'wallets', 'transactions', 'ledger_entries']],
    );
    if (result.rows[0]?.count !== 4) {
      throw new Error(
        'Existing database does not contain the required baseline tables; run migrate:up instead.',
      );
    }
  } finally {
    await client.end();
  }
  await runner(runnerOptions({ file: '001_baseline', fake: true }));
  console.log('Marked 001_baseline as applied without changing domain tables.');
}

const command = process.argv[2] ?? 'validate';
if (command === 'validate') await validate();
else if (command === 'up') await up();
else if (command === 'status') await status();
else if (command === 'baseline') await baseline();
else if (command === 'expand') await applyMoneyPhase('expand');
else if (command === 'contract') await applyMoneyPhase('contract');
else throw new Error(`Unknown migration command "${command}".`);

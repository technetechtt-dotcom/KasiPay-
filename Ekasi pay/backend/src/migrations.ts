import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Pool } from 'pg';

export const MIGRATIONS_TABLE = 'schema_migrations';
export const MIGRATIONS_SCHEMA = 'public';

const MIGRATION_FILE = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.(?:js|sql)$/;

export interface MigrationDefinition {
  file: string;
  name: string;
  sequence: number;
}

export function parseMigrationFiles(files: readonly string[]): MigrationDefinition[] {
  const migrations = files
    .filter((file) => !file.startsWith('.'))
    .map((file) => {
      const match = MIGRATION_FILE.exec(file);
      if (!match) {
        throw new Error(
          `Invalid migration filename "${file}". Expected <number>_<name>.js or .sql.`,
        );
      }
      return {
        file,
        name: file.replace(/\.(?:js|sql)$/, ''),
        sequence: Number(match[1]),
      };
    })
    .sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));

  const seenSequences = new Set<number>();
  const seenNames = new Set<string>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.sequence)) {
      throw new Error(`Migration sequence is not a safe integer: ${migration.file}`);
    }
    if (seenSequences.has(migration.sequence)) {
      throw new Error(`Duplicate migration sequence: ${migration.sequence}`);
    }
    if (seenNames.has(migration.name)) {
      throw new Error(`Duplicate migration name: ${migration.name}`);
    }
    seenSequences.add(migration.sequence);
    seenNames.add(migration.name);
  }
  if (migrations.length === 0) {
    throw new Error('No migration files were found.');
  }
  return migrations;
}

export async function loadMigrationDefinitions(
  directory = path.resolve(process.cwd(), 'migrations'),
): Promise<MigrationDefinition[]> {
  return parseMigrationFiles(await readdir(directory));
}

export async function validateMigrationSources(
  directory = path.resolve(process.cwd(), 'migrations'),
): Promise<MigrationDefinition[]> {
  const migrations = await loadMigrationDefinitions(directory);
  for (const migration of migrations) {
    if (!migration.file.endsWith('.js')) continue;
    const source = await readFile(path.join(directory, migration.file), 'utf8');
    if (!/\bexport\s+const\s+up\b/.test(source)) {
      throw new Error(`${migration.file} must export an up migration.`);
    }
  }
  return migrations;
}

export async function assertSchemaReady(pool: Pool): Promise<void> {
  const expected = await loadMigrationDefinitions();
  const table = await pool.query<{ table_name: string | null }>(
    `SELECT to_regclass($1)::text AS table_name`,
    [`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`],
  );
  if (!table.rows[0]?.table_name) {
    throw new Error(
      'Database schema history is missing. Run "npm run migrate:up" before starting the API.',
    );
  }

  const applied = await pool.query<{ name: string }>(
    `SELECT name FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ORDER BY id`,
  );
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const pending = expected.filter((migration) => !appliedNames.has(migration.name));
  const unknown = applied.rows.filter(
    (row) => !expected.some((migration) => migration.name === row.name),
  );
  if (pending.length > 0 || unknown.length > 0) {
    const details = [
      pending.length > 0 ? `pending: ${pending.map((item) => item.name).join(', ')}` : '',
      unknown.length > 0 ? `unknown: ${unknown.map((item) => item.name).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `Database schema version does not match this release (${details}). Run migration validation and migrate up.`,
    );
  }

  const ledgerBackfill = await pool.query<{ state: string }>(
    `SELECT state FROM ledger_backfill_status WHERE id = 1`,
  );
  if (ledgerBackfill.rows[0]?.state === 'pending_signoff') {
    throw new Error(
      'Ledger backfill requires operational sign-off. Run ledger reconciliation and the guarded ledger:backfill command before deployment.',
    );
  }
}

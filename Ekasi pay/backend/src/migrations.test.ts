import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  assertSchemaReady,
  parseMigrationFiles,
  validateMigrationSources,
} from './migrations.js';

test('migration files are ordered by numeric sequence', () => {
  assert.deepEqual(
    parseMigrationFiles(['010_add_index.js', '001_baseline.js']).map(
      (migration) => migration.name,
    ),
    ['001_baseline', '010_add_index'],
  );
});

test('migration validation rejects duplicate sequence numbers', () => {
  assert.throws(
    () => parseMigrationFiles(['001_baseline.js', '001_other.js']),
    /Duplicate migration sequence/,
  );
});

test('migration validation rejects unversioned files', () => {
  assert.throws(() => parseMigrationFiles(['baseline.js']), /Invalid migration filename/);
});

test('source validation works without a database', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ekasi-migrations-'));
  await writeFile(
    path.join(directory, '001_baseline.js'),
    'export const up = () => {};\nexport const down = false;\n',
  );
  assert.equal((await validateMigrationSources(directory))[0]?.name, '001_baseline');
});

test('startup readiness fails when schema history is absent', async () => {
  const fakePool = {
    query: async () => ({ rows: [{ table_name: null }] }),
  } as unknown as Pool;
  await assert.rejects(
    () => assertSchemaReady(fakePool),
    /schema history is missing/,
  );
});

/**
 * Rotate historically exposed ops passwords. Writes evidence to gitignored artifacts.
 * Does not print the new passwords.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import dotenv from 'dotenv';

dotenv.config();

const operators = [
  { username: 'ivanij', role: 'admin' },
  { username: 'bakkies', role: 'support' },
];

function password() {
  return randomBytes(18).toString('base64url');
}

const outDir = path.resolve('artifacts');
mkdirSync(outDir, { recursive: true });
const rotatedAt = new Date().toISOString();
const records = operators.map((op) => ({
  ...op,
  password: password(),
  rotatedAt,
}));

const evidencePath = path.join(outDir, `ops-rotate-${Date.now()}.json`);
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      schemaVersion: 'ops.rotate.v1',
      reason: 'Historical ops credentials were exposed in chat and must be treated as burned.',
      rotatedAt,
      operators: records,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

for (const record of records) {
  const result = spawnSync(process.execPath, ['scripts/rotate-ops-operator.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROTATE_CONFIRM: 'ROTATE_OPERATOR',
      ROTATE_OPERATOR_USERNAME: record.username,
      ROTATE_OPERATOR_PASSWORD: record.password,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Wrote gitignored evidence ${evidencePath}`);

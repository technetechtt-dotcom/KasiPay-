import 'dotenv/config';

import { createHash } from 'node:crypto';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const reportPath = path.resolve(root, process.env.READINESS_REPORT || 'artifacts/readiness/report.json');
const evidencePath = path.resolve(
  root,
  process.env.READINESS_EVIDENCE_FILE || 'evidence/production-readiness.json',
);
const releaseSha = (process.env.RELEASE_SHA || process.env.GITHUB_SHA || '').trim();
const now = Date.now();
const failures = [];
const checks = [];

const requiredControls = [
  'migrations',
  'configuration',
  'tests',
  'security_scan',
  'sbom',
  'provenance',
  'legal',
  'provider',
  'backup',
  'restore_drill',
  'failure_drill',
  'smoke',
  'rollback',
];

/** Product env flags that must not be true in production without approved evidence. */
const gatedProductFlags = [
  'CASH_SEND_ENABLED',
  'LENDING_ENABLED',
  'INSURANCE_ENABLED',
  'STOKVEL_MONEY_MOVEMENT_ENABLED',
];

function envFlagTrue(name) {
  return /^(1|true|yes|on)$/iu.test(String(process.env[name] ?? '').trim());
}

function record(control, ok, detail) {
  checks.push({ control, ok, detail });
  if (!ok) failures.push(`${control}: ${detail}`);
}

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args, env = {}) {
  // Do not use shell:true — Windows splits unquoted paths with spaces
  // (e.g. C:\Program Files\nodejs\node.exe) and breaks migrate checks.
  return spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: false,
    timeout: 10 * 60 * 1000,
  });
}

/**
 * Latest passed/approved evidence row for a control or product flag name.
 * @param {unknown[]} entries
 * @param {string} keyField
 * @param {string} keyValue
 */
function latestApprovedEvidence(entries, keyField, keyValue) {
  return entries
    .filter((item) => item && item[keyField] === keyValue)
    .filter((item) => item.status === 'passed' || item.status === 'approved')
    .filter((item) => !item.releaseSha || item.releaseSha === releaseSha)
    .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
    .sort((a, b) => Date.parse(b.recordedAt || 0) - Date.parse(a.recordedAt || 0))[0];
}

async function verifyEvidenceArtifact(label, current) {
  if (!current) {
    record(label, false, 'current passed/approved evidence is absent');
    return;
  }
  const artifact = path.resolve(root, String(current.artifact || ''));
  try {
    await access(artifact);
    const actual = await sha256(artifact);
    record(
      label,
      /^[0-9a-f]{64}$/i.test(current.sha256 || '') && actual === current.sha256,
      actual === current.sha256 ? path.relative(root, artifact) : 'artifact digest mismatch',
    );
  } catch (error) {
    record(label, false, `artifact unavailable: ${error.message}`);
  }
}

let manifest;
try {
  manifest = JSON.parse(await readFile(evidencePath, 'utf8'));
  record('evidence_manifest', true, path.relative(root, evidencePath));
} catch (error) {
  record('evidence_manifest', false, `missing or invalid ${path.relative(root, evidencePath)}: ${error.message}`);
  manifest = { controls: [], productFlags: [] };
}

record('release_sha', /^[0-9a-f]{7,64}$/i.test(releaseSha), 'RELEASE_SHA/GITHUB_SHA must identify the reviewed build');
record('environment', process.env.NODE_ENV === 'production', 'NODE_ENV must be production for a production gate');
record(
  'posting_control',
  process.env.FINANCIAL_POSTING_ENABLED === 'true',
  'FINANCIAL_POSTING_ENABLED must be explicitly true only after all evidence is approved',
);
record(
  'database',
  /^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL || ''),
  'DATABASE_URL must be PostgreSQL',
);

const migrationValidation = run(process.execPath, ['scripts/migrate.mjs', 'validate']);
record(
  'migration_definitions',
  migrationValidation.status === 0,
  (migrationValidation.stdout || migrationValidation.stderr || 'migration validation failed').trim(),
);

if (process.env.DATABASE_URL) {
  const migrationStatus = run(process.execPath, ['scripts/migrate.mjs', 'status']);
  record(
    'migration_status',
    migrationStatus.status === 0,
    (migrationStatus.stdout || migrationStatus.stderr || 'migration status failed').trim(),
  );
} else {
  record('migration_status', false, 'DATABASE_URL is absent; applied migrations cannot be verified');
}

const controlEntries = Array.isArray(manifest.controls) ? manifest.controls : [];
for (const control of requiredControls) {
  await verifyEvidenceArtifact(control, latestApprovedEvidence(controlEntries, 'control', control));
}

/**
 * Fail closed: if a gated product flag is enabled, require matching approved
 * evidence in manifest.productFlags (or controls with control === flag name).
 * Disabled / unset flags do not require evidence.
 */
const productFlagEntries = [
  ...(Array.isArray(manifest.productFlags) ? manifest.productFlags : []),
  ...controlEntries.filter((item) => gatedProductFlags.includes(item?.control)),
].map((item) => ({
  ...item,
  flag: item.flag || item.control,
}));

for (const flag of gatedProductFlags) {
  const enabled = envFlagTrue(flag);
  if (!enabled) {
    record(`product_flag.${flag}`, true, 'disabled (fail-closed default); evidence not required');
    continue;
  }
  await verifyEvidenceArtifact(
    `product_flag.${flag}`,
    latestApprovedEvidence(productFlagEntries, 'flag', flag),
  );
}

const generatedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  gate: 'KasiPay Phase 8 production readiness',
  releaseSha: releaseSha || null,
  generatedAt,
  passed: failures.length === 0,
  checks,
  failures,
  warning: 'A passing repository gate does not replace protected-environment approval or external legal/provider authority.',
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));

if (failures.length) {
  console.error(`Production readiness failed closed with ${failures.length} blocking item(s).`);
  process.exitCode = 1;
} else {
  console.log('Production readiness evidence is complete for this exact release SHA.');
}

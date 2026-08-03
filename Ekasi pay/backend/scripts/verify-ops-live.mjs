/**
 * Verify live ops wiring that cannot be proven from git alone.
 *
 * Usage (from backend/):
 *   node scripts/verify-ops-live.mjs
 *
 * Optional env:
 *   RENDER_API_KEY, RENDER_SERVICE_ID_RECONCILE_WORKER
 *   DATABASE_URL, MONITORING_PROVIDER, MONITORING_DSN, ALERT_ROUTING_MARKER
 *   VITE_SUPPORT_WHATSAPP / VITE_SUPPORT_PHONE / VITE_SUPPORT_EMAIL (or SUPPORT_* mirrors)
 */
import { spawnSync } from 'node:child_process';

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}: ${detail}`);
}

function present(name, aliases = []) {
  const keys = [name, ...aliases];
  for (const key of keys) {
    const value = String(process.env[key] ?? '').trim();
    if (value) return { key, value };
  }
  return null;
}

record(
  'DATABASE_URL',
  Boolean(present('DATABASE_URL')),
  present('DATABASE_URL')
    ? 'set (value redacted)'
    : 'missing — Neon/prod connection not available in this shell',
);

const monitoring = present('MONITORING_DSN');
record(
  'MONITORING_DSN',
  Boolean(monitoring),
  monitoring ? `set via ${monitoring.key}` : 'missing — alerts:verify cannot page on-call',
);

record(
  'MONITORING_PROVIDER',
  Boolean(present('MONITORING_PROVIDER')),
  present('MONITORING_PROVIDER')?.value ?? 'missing',
);

record(
  'ALERT_ROUTING_MARKER',
  Boolean(present('ALERT_ROUTING_MARKER')),
  present('ALERT_ROUTING_MARKER') ? 'set' : 'missing',
);

const support =
  present('VITE_SUPPORT_WHATSAPP', ['SUPPORT_WHATSAPP']) ||
  present('VITE_SUPPORT_PHONE', ['SUPPORT_PHONE']) ||
  present('VITE_SUPPORT_EMAIL', ['SUPPORT_EMAIL']);
record(
  'VITE_SUPPORT_*',
  Boolean(support),
  support
    ? `at least one contact set (${support.key})`
    : 'missing — Help page will hide contact channels',
);

const flags = [
  'FINANCIAL_POSTING_ENABLED',
  'CASH_SEND_ENABLED',
  'LENDING_ENABLED',
  'INSURANCE_ENABLED',
  'STOKVEL_MONEY_MOVEMENT_ENABLED',
  'LIVE_UTILITIES_ENABLED',
];
for (const flag of flags) {
  const raw = String(process.env[flag] ?? 'false').trim().toLowerCase();
  const enabled = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  record(flag, !enabled, enabled ? 'UNEXPECTEDLY TRUE' : 'false (safe)');
}

const renderKey = present('RENDER_API_KEY');
const workerId = present('RENDER_SERVICE_ID_RECONCILE_WORKER');
if (renderKey && workerId) {
  const result = spawnSync(
    'curl',
    [
      '-sS',
      '-H',
      `Authorization: Bearer ${renderKey.value}`,
      `https://api.render.com/v1/services/${workerId.value}`,
    ],
    { encoding: 'utf8' },
  );
  const ok = result.status === 0 && /ekasi-pay-reconcile-worker|"type"\s*:\s*"worker"/i.test(result.stdout || '');
  record(
    'Render reconcile worker',
    ok,
    ok ? 'service reachable via Render API' : (result.stderr || result.stdout || 'lookup failed').slice(0, 200),
  );
} else {
  record(
    'Render reconcile worker',
    false,
    'set RENDER_API_KEY + RENDER_SERVICE_ID_RECONCILE_WORKER to prove live worker, or check Render dashboard logs for reconciliation.worker_started',
  );
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} live checks passed.`);
console.log(
  'This script never invents secrets or approvals. Fill missing env in Render/Neon, then re-run.',
);
process.exitCode = failed ? 1 : 0;

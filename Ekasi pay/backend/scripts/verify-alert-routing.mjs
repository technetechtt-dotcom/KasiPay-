/**
 * Emit a synthetic SEV test event to prove alert routing config is reachable.
 *
 *   MONITORING_PROVIDER=... MONITORING_DSN=... ALERT_ROUTING_MARKER=... \
 *     npm run alerts:verify
 *
 * Without a real DSN this writes local evidence and exits 2 (ops must confirm paging).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const provider = process.env.MONITORING_PROVIDER?.trim() ?? '';
const dsn = process.env.MONITORING_DSN?.trim() ?? '';
const marker = process.env.ALERT_ROUTING_MARKER?.trim() ?? '';
const startedAt = new Date().toISOString();

const assertions = [
  {
    name: 'monitoring_provider_set',
    passed: ['sentry', 'datadog', 'other'].includes(provider.toLowerCase()),
    detail: provider || 'missing',
  },
  {
    name: 'monitoring_dsn_set',
    passed: dsn.length > 0,
  },
  {
    name: 'alert_routing_marker_set',
    passed: marker.length > 0,
    detail: marker || 'missing',
  },
];

let delivery = { attempted: false, ok: false, detail: 'skipped' };
if (dsn && provider.toLowerCase() === 'other' && dsn.startsWith('https://')) {
  delivery.attempted = true;
  try {
    const response = await fetch(dsn, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        severity: 'test',
        event: 'ekasi.alert_routing.verify',
        marker,
        at: startedAt,
      }),
    });
    delivery = {
      attempted: true,
      ok: response.ok,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    delivery = {
      attempted: true,
      ok: false,
      detail: error instanceof Error ? error.message : 'delivery failed',
    };
  }
}

assertions.push({
  name: 'synthetic_event_delivery',
  passed: delivery.attempted ? delivery.ok : false,
  detail:
    delivery.attempted
      ? delivery.detail
      : 'Configure MONITORING_PROVIDER=other with an HTTPS webhook DSN, or confirm Sentry/Datadog paging manually.',
});

const result = {
  schemaVersion: 'phase5.alert_routing.v1',
  startedAt,
  completedAt: new Date().toISOString(),
  provider,
  dsnHost: (() => {
    try {
      return dsn ? new URL(dsn).host : '';
    } catch {
      return 'invalid';
    }
  })(),
  marker,
  delivery,
  ok: assertions.every((a) => a.passed),
  assertions,
};
const outDir = path.resolve('artifacts');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `alert-routing-${Date.now()}.json`);
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, evidenceFile: outFile }));
if (!result.ok) process.exitCode = 2;

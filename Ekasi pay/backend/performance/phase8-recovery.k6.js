import http from 'k6/http';
import { check, fail, sleep } from 'k6';

const baseUrl = (__ENV.PERF_BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const target = new URL(baseUrl);
const local = ['localhost', '127.0.0.1', '::1'].includes(target.hostname);
const staging = /(^|[.-])(staging|sandbox|test|ci)([.-]|$)/i.test(target.hostname);
if ((!local && (!staging || __ENV.ALLOW_NONLOCAL_PERF !== '1')) || /prod(uction)?/i.test(target.hostname)) {
  fail('Recovery tests refuse production and require explicit staging opt-in.');
}

export const options = {
  scenarios: {
    malformed_callback_burst: {
      executor: 'constant-vus',
      vus: Number(__ENV.RECOVERY_VUS || 5),
      duration: __ENV.RECOVERY_DURATION || '30s',
      exec: 'malformedCallbacks',
    },
    readiness_probe: {
      executor: 'constant-vus',
      vus: 1,
      duration: __ENV.RECOVERY_DURATION || '30s',
      exec: 'probeReadiness',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    'http_req_duration{scenario:readiness}': ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export function malformedCallbacks() {
  const response = http.post(
    `${baseUrl}/api/v1/providers/callbacks/recovery-invalid`,
    '{"truncated":',
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Provider-Signature': 'invalid-recovery-signature',
        'X-Performance-Test': 'phase8-staging-only',
      },
      responseCallback: http.expectedStatuses(400, 401, 403, 404),
      tags: { scenario: 'safe-failure' },
    },
  );
  check(response, { 'malformed callback is contained': (r) => r.status < 500 });
  sleep(0.2);
}

export function probeReadiness() {
  const response = http.get(`${baseUrl}/health/ready`, {
    tags: { scenario: 'readiness' },
  });
  check(response, { 'service remains ready': (r) => r.status === 200 });
  sleep(1);
}

export function handleSummary(data) {
  return {
    [__ENV.RECOVERY_REPORT || 'artifacts/performance/phase8-recovery.json']:
      JSON.stringify(data, null, 2),
  };
}

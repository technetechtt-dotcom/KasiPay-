import http from 'k6/http';
import { check, fail, sleep } from 'k6';

const baseUrl = (__ENV.PERF_BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const pilotRps = Number(__ENV.PILOT_RPS || 5);
const multiplier = Number(__ENV.PILOT_MULTIPLIER || 2);
const targetRps = Math.ceil(pilotRps * multiplier);

function assertSafeTarget() {
  const target = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '::1'].includes(target.hostname);
  const explicitlyStaging = /(^|[.-])(staging|sandbox|test|ci)([.-]|$)/i.test(target.hostname);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    fail('PERF_BASE_URL must use http or https.');
  }
  if (!local && (!explicitlyStaging || __ENV.ALLOW_NONLOCAL_PERF !== '1')) {
    fail('Performance tests only allow localhost or an explicitly opted-in staging/sandbox/test/ci host.');
  }
  if (/prod(uction)?/i.test(target.hostname)) {
    fail('Production-like performance target rejected.');
  }
  if (multiplier < 2 || multiplier > 5) {
    fail('PILOT_MULTIPLIER must be between 2 and 5.');
  }
}

assertSafeTarget();

export const options = {
  scenarios: {
    pilot_load: {
      executor: 'constant-arrival-rate',
      rate: targetRps,
      timeUnit: '1s',
      duration: __ENV.PERF_DURATION || '2m',
      preAllocatedVUs: Math.max(10, targetRps),
      maxVUs: Math.max(50, targetRps * 4),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<750'],
    'http_req_duration{journey:auth}': ['p(95)<500'],
    'http_req_duration{journey:balances}': ['p(95)<400'],
    'http_req_duration{journey:transfers}': ['p(95)<900'],
    'http_req_duration{journey:pos}': ['p(95)<900'],
    'http_req_duration{journey:vouchers}': ['p(95)<900'],
    'http_req_duration{journey:ops}': ['p(95)<750'],
    'http_req_duration{journey:audits}': ['p(95)<1000'],
    'http_req_duration{journey:settlements}': ['p(95)<1000'],
    'http_req_duration{journey:webhooks}': ['p(95)<900'],
  },
};

function headers(token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Performance-Test': 'phase8-staging-only',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export function setup() {
  const login = http.post(
    `${baseUrl}/api/v1/login`,
    JSON.stringify({
      phone: __ENV.PERF_USER_PHONE || '27820000001',
      pin: __ENV.PERF_USER_PIN || '246810',
    }),
    { headers: headers(), tags: { journey: 'auth' } },
  );
  check(login, { 'auth responds without server error': (r) => r.status < 500 });
  const body = login.status === 200 ? login.json() : {};
  return {
    userToken: __ENV.PERF_USER_TOKEN || body?.accessToken || '',
    opsToken: __ENV.PERF_OPS_TOKEN || '',
  };
}

export default function (data) {
  const user = headers(data.userToken);
  const ops = headers(data.opsToken);
  const readOnly = [
    ['/api/v1/me', 'balances', user],
    ['/api/v1/wallets/me', 'balances', user],
    ['/api/v1/customer/statements?limit=20', 'transfers', user],
    ['/api/v1/products', 'pos', user],
    ['/api/v1/cash-send/mine', 'vouchers', user],
    ['/api/v1/ops/monitoring', 'ops', ops],
    ['/api/v1/admin/audit-events', 'audits', ops],
    ['/api/v1/ops/settlements', 'settlements', ops],
  ];
  for (const [path, journey, requestHeaders] of readOnly) {
    const response = http.get(`${baseUrl}${path}`, {
      headers: requestHeaders,
      tags: { journey },
    });
    check(response, {
      [`${journey} has no 5xx`]: (r) => r.status < 500,
    });
  }

  // Invalid signatures exercise webhook parsing/authentication without creating
  // provider instructions or financial postings.
  const webhook = http.post(
    `${baseUrl}/api/v1/providers/callbacks/perf-invalid`,
    JSON.stringify({ eventId: `perf-${__VU}-${__ITER}`, state: 'test' }),
    {
      headers: headers('', {
        'X-Provider-Signature': 'invalid-performance-signature',
        'Idempotency-Key': `perf-${__VU}-${__ITER}`,
      }),
      tags: { journey: 'webhooks' },
    },
  );
  check(webhook, { 'invalid webhook rejected safely': (r) => [400, 401, 403, 404].includes(r.status) });
  sleep(0.1);
}

export function handleSummary(data) {
  return {
    [__ENV.PERF_REPORT || 'artifacts/performance/phase8-summary.json']: JSON.stringify(data, null, 2),
    stdout: `Phase 8 performance report: ${JSON.stringify({
      targetRps,
      p95Ms: data.metrics.http_req_duration?.values?.['p(95)'],
      errorRate: data.metrics.http_req_failed?.values?.rate,
    })}\n`,
  };
}

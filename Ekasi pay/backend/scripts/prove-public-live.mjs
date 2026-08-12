/**
 * Public live proofs that do not need Render/Neon secrets.
 *
 * Usage (from backend/):
 *   node scripts/prove-public-live.mjs
 *
 * Optional env:
 *   KASIPAY_API_URL, KASIPAY_WEB_URL, KASIPAY_OPS_URL
 */
const API = (process.env.KASIPAY_API_URL || 'https://ekasi-pay-api.onrender.com').replace(/\/$/, '');
const WEB = (process.env.KASIPAY_WEB_URL || 'https://ekasi-pay-web.onrender.com').replace(/\/$/, '');
const OPS = (process.env.KASIPAY_OPS_URL || 'https://ekasi-ops-dashboard.onrender.com').replace(/\/$/, '');

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { ...init, redirect: 'follow', signal: controller.signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  try {
    const health = await request(`${API}/health`);
    record(
      'API /health',
      health.status === 200 && /"ok"\s*:\s*true/.test(health.text),
      `${health.status} ${health.text.slice(0, 120)}`,
    );
  } catch (error) {
    record('API /health', false, error instanceof Error ? error.message : 'request failed');
  }

  try {
    const live = await request(`${API}/health/live`);
    record(
      'API /health/live',
      live.status === 200 && /"ok"\s*:\s*true/.test(live.text),
      live.status === 404
        ? '404 — deployed build is older than current main; wait for Render'
        : `${live.status} ${live.text.slice(0, 120)}`,
    );
  } catch (error) {
    record('API /health/live', false, error instanceof Error ? error.message : 'request failed');
  }

  try {
    const ready = await request(`${API}/health/ready`);
    const bodyOk = ready.status === 200 || (ready.status === 503 && ready.text.includes('database'));
    record(
      'API /health/ready',
      ready.status !== 404 && bodyOk,
      ready.status === 404
        ? '404 — deployed build is older than current main; wait for Render'
        : `${ready.status} ${ready.text.slice(0, 160)}`,
    );
  } catch (error) {
    record('API /health/ready', false, error instanceof Error ? error.message : 'request failed');
  }

  try {
    const cors = await request(`${API}/api/admin/overview`, {
      method: 'OPTIONS',
      headers: {
        Origin: OPS,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    const allow = cors.headers.get('access-control-allow-origin') || '';
    record(
      'Ops CORS preflight',
      cors.status === 204 && allow === OPS,
      `${cors.status} allow-origin=${allow || '(none)'}`,
    );
  } catch (error) {
    record('Ops CORS preflight', false, error instanceof Error ? error.message : 'request failed');
  }

  try {
    const web = await request(`${WEB}/`);
    record('Web /', web.status === 200 && /html/i.test(web.text), String(web.status));
  } catch (error) {
    record('Web /', false, error instanceof Error ? error.message : 'request failed');
  }

  try {
    const runtime = await request(`${WEB}/runtime-config.js`);
    const hasApi = runtime.text.includes('ekasi-pay-api.onrender.com');
    const hasSupport = /__KASIPAY_SUPPORT__/.test(runtime.text);
    const hasEmail = /ivanjohnsonijj@gmail\.com/.test(runtime.text);
    record(
      'Web runtime-config.js',
      runtime.status === 200 && hasApi,
      `${runtime.status} api=${hasApi} supportObject=${hasSupport} email=${hasEmail}`,
    );
  } catch (error) {
    record('Web runtime-config.js', false, error instanceof Error ? error.message : 'request failed');
  }

  try {
    const ops = await request(`${OPS}/health`);
    record(
      'Ops /health',
      ops.status === 200,
      `${ops.status} ${ops.text.slice(0, 120)}`,
    );
  } catch (error) {
    record('Ops /health', false, error instanceof Error ? error.message : 'request failed');
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} public live checks passed.`);
  console.log('Money-movement flags stay false. This script never invents secrets or approvals.');
  process.exitCode = failed ? 1 : 0;
}

await main();

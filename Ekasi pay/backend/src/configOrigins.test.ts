import assert from 'node:assert/strict';
import test from 'node:test';

import { collectFrontendOrigins } from './config.js';

test('production CORS includes ops dashboard when FRONTEND_ORIGINS omits it', () => {
  const origins = collectFrontendOrigins(
    {
      FRONTEND_ORIGINS: 'https://ekasi-pay-web.onrender.com',
      RENDER_SERVICE_NAME: 'ekasi-pay-api',
    },
    { isLocal: false },
  );
  assert.ok(origins.includes('https://ekasi-pay-web.onrender.com'));
  assert.ok(origins.includes('https://ekasi-ops-dashboard.onrender.com'));
});

test('OPS_DASHBOARD_ORIGIN is merged even off Render', () => {
  const origins = collectFrontendOrigins(
    {
      FRONTEND_ORIGINS: 'https://app.example.com',
      OPS_DASHBOARD_ORIGIN: 'ekasi-ops-dashboard',
    },
    { isLocal: false },
  );
  assert.ok(origins.includes('https://app.example.com'));
  assert.ok(origins.includes('https://ekasi-ops-dashboard.onrender.com'));
});

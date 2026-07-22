import assert from 'node:assert/strict';
import test from 'node:test';

import { DRILL_TYPES } from '../failureDrills.js';
import { runLocalFailureDrill } from './localAdapters.js';

test('local failure drill adapters pass for every drill type', async () => {
  for (const drillType of DRILL_TYPES) {
    const result = await runLocalFailureDrill(drillType, 'test');
    assert.equal(result.outcome, 'passed', `${drillType}: ${JSON.stringify(result.assertions)}`);
    assert.equal(result.drillType, drillType);
  }
});

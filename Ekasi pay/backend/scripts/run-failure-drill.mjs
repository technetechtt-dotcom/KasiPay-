/**
 * Failure drill CLI.
 *
 *   DRILL_ENVIRONMENT=test DRILL_ADAPTER=local npm run drill -- duplicate_webhook
 *
 * Without DRILL_ADAPTER=local the command aborts (safe default).
 */
import { DRILL_TYPES } from '../src/failureDrills.ts';
import { runLocalFailureDrill } from '../src/drills/localAdapters.ts';

const environment = process.env.DRILL_ENVIRONMENT ?? 'test';
if (environment === 'production' || process.env.NODE_ENV === 'production') {
  throw new Error('Failure drills are forbidden in production.');
}

const drillType = process.argv[2];
if (!DRILL_TYPES.includes(drillType)) {
  throw new Error(`Unknown drill type: ${drillType}`);
}

const adapter = (process.env.DRILL_ADAPTER ?? '').trim().toLowerCase();
if (adapter !== 'local') {
  const result = {
    schemaVersion: 'phase5.drill.v1',
    drillType,
    environment,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outcome: 'aborted',
    assertions: [
      {
        name: 'isolated_adapter_configured',
        passed: false,
        detail: 'Set DRILL_ADAPTER=local for in-process adapters, or configure an isolated harness.',
      },
    ],
    evidenceRefs: [],
    runnerVersion: 'phase5-v2',
  };
  console.log(JSON.stringify(result));
  process.exitCode = 3;
} else {
  const result = await runLocalFailureDrill(drillType, environment);
  console.log(JSON.stringify(result));
  if (result.outcome !== 'passed') process.exitCode = result.outcome === 'aborted' ? 3 : 2;
}

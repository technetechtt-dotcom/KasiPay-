const environment = process.env.DRILL_ENVIRONMENT ?? 'test';
if (environment === 'production' || process.env.NODE_ENV === 'production') {
  throw new Error('Failure drills are forbidden in production.');
}
const drillType = process.argv[2];
const allowed = new Set([
  'api_kill_after_commit', 'database_loss', 'provider_timeout',
  'malformed_webhook', 'duplicate_webhook', 'dead_letter_recovery', 'partial_settlement',
]);
if (!allowed.has(drillType)) throw new Error(`Unknown drill type: ${drillType}`);

// The CLI is an orchestration guard. Real fault injection must be supplied by an
// isolated test adapter and evidence must be recorded; it never targets a URL by default.
const result = {
  schemaVersion: 'phase5.drill.v1',
  drillType,
  environment,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  outcome: 'aborted',
  assertions: [{ name: 'isolated_adapter_configured', passed: false, detail: 'Set up the documented isolated adapter before running fault injection.' }],
  evidenceRefs: [],
  runnerVersion: 'phase5-v1',
};
console.log(JSON.stringify(result));
process.exitCode = 3;

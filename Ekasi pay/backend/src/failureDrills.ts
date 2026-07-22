export const DRILL_TYPES = [
  'api_kill_after_commit',
  'database_loss',
  'provider_timeout',
  'malformed_webhook',
  'duplicate_webhook',
  'dead_letter_recovery',
  'partial_settlement',
] as const;

export type DrillType = (typeof DRILL_TYPES)[number];
export type DrillResult = {
  schemaVersion: 'phase5.drill.v1';
  drillType: DrillType;
  environment: 'test' | 'development' | 'staging' | 'isolated';
  startedAt: string;
  completedAt: string;
  outcome: 'passed' | 'failed' | 'aborted';
  assertions: { name: string; passed: boolean; detail?: string }[];
  evidenceRefs: string[];
  runnerVersion: string;
};

export async function runFailureDrill(
  drillType: DrillType,
  environment: DrillResult['environment'],
  execute: () => Promise<{ assertions: DrillResult['assertions']; evidenceRefs?: string[] }>,
): Promise<DrillResult> {
  if (!['test', 'development', 'staging', 'isolated'].includes(environment)) {
    throw new Error('Failure drills may never target production.');
  }
  const startedAt = new Date().toISOString();
  try {
    const result = await execute();
    return {
      schemaVersion: 'phase5.drill.v1',
      drillType,
      environment,
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: result.assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed',
      assertions: result.assertions,
      evidenceRefs: result.evidenceRefs ?? [],
      runnerVersion: 'phase5-v1',
    };
  } catch (error) {
    return {
      schemaVersion: 'phase5.drill.v1',
      drillType,
      environment,
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: 'failed',
      assertions: [{ name: 'harness_completed', passed: false, detail: error instanceof Error ? error.message : 'unknown failure' }],
      evidenceRefs: [],
      runnerVersion: 'phase5-v1',
    };
  }
}

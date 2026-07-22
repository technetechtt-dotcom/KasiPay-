import { spawn } from 'node:child_process';

if (process.env.DRILL_ENVIRONMENT !== 'isolated') {
  throw new Error('DRILL_ENVIRONMENT=isolated is mandatory.');
}
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.RESTORE_DATABASE_URL ?? '')) {
  throw new Error('Restore drills may never target production.');
}
const url = process.env.RESTORE_DATABASE_URL;
const dump = process.env.RESTORE_DUMP_FILE;
if (!url || !dump) throw new Error('RESTORE_DATABASE_URL and RESTORE_DUMP_FILE are required.');

const startedAt = new Date().toISOString();
const code = await new Promise((resolve, reject) => {
  const child = spawn('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', url, dump], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.once('error', reject);
  child.once('exit', resolve);
});
const result = {
  schemaVersion: 'phase5.drill.v1',
  drillType: 'restore_reconcile',
  environment: 'isolated',
  startedAt,
  completedAt: new Date().toISOString(),
  outcome: code === 0 ? 'passed' : 'failed',
  assertions: [{ name: 'pg_restore_completed', passed: code === 0 }],
  evidenceRefs: [],
  runnerVersion: 'phase5-v1',
};
console.log(JSON.stringify(result));
if (code !== 0) process.exitCode = Number(code) || 1;

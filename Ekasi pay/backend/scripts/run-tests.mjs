import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';

const pattern = process.argv[2] ?? 'src/**/*.test.ts';
const includeIntegration = process.argv.includes('--integration');
const files = globSync(pattern, { windowsPathsNoEscape: true })
  .filter((file) => includeIntegration || !file.includes('.integration.test.'))
  .sort();
if (files.length === 0) {
  console.error(`No test files matched ${pattern}`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

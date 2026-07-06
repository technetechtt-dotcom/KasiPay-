import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const requiredTypes = [
  '@types/express',
  '@types/better-sqlite3',
  '@types/cors',
  '@types/bcryptjs',
  '@types/jsonwebtoken',
  '@types/node',
];

const missing = requiredTypes.filter((pkg) => {
  const folder = path.join(root, 'node_modules', ...pkg.split('/'));
  return !fs.existsSync(path.join(folder, 'package.json'));
});

if (missing.length === 0) {
  process.exit(0);
}

console.info(`[build] Installing missing type packages: ${missing.join(', ')}`);
const result = spawnSync(
  'npm',
  ['install', '--no-audit', '--no-fund', '--save', ...missing],
  { cwd: root, stdio: 'inherit', shell: true },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

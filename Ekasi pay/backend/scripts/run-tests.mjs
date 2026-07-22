import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const mode = process.argv[2] ?? 'unit';
const all = walk('src').map((file) => file.split(path.sep).join('/'));

let files;
if (mode === 'unit') {
  files = all.filter(
    (file) => file.endsWith('.test.ts') && !file.includes('.integration.test.'),
  );
} else if (mode === 'integration') {
  files = all.filter((file) => file.endsWith('.integration.test.ts'));
} else if (mode === 'postgres') {
  const allowed = new Set([
    'src/ledgerPg.integration.test.ts',
    'src/phase6Pg.integration.test.ts',
    'src/phase7Pg.integration.test.ts',
    'src/phase8Pg.integration.test.ts',
  ]);
  files = all.filter((file) => allowed.has(file));
} else {
  console.error(`Unknown test mode "${mode}". Use unit|integration|postgres.`);
  process.exit(1);
}

files.sort();
if (files.length === 0) {
  console.error(`No test files found for mode ${mode}`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const url = process.env.DATABASE_URL;
const key = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
if (!url) throw new Error('DATABASE_URL is required.');
if (!key || key.length < 24) throw new Error('BACKUP_ENCRYPTION_PASSPHRASE must be at least 24 characters.');
const outDir = path.resolve(process.env.BACKUP_DIR ?? './backups');
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const plain = path.join(outDir, `ekasi-${stamp}.dump`);
const encrypted = `${plain}.enc`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

try {
  await run('pg_dump', ['--format=custom', '--no-owner', '--file', plain, url]);
  await run('openssl', ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-in', plain, '-out', encrypted, '-pass', 'env:BACKUP_ENCRYPTION_PASSPHRASE']);
  const bytes = await readFile(encrypted);
  const marker = {
    schemaVersion: 'phase5.backup.v1',
    createdAt: new Date().toISOString(),
    encrypted: true,
    pitrCapable: process.env.BACKUP_PITR_MARKER === 'provider-confirmed',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    artifact: path.basename(encrypted),
  };
  await writeFile(`${encrypted}.marker.json`, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(marker));
} finally {
  await rm(plain, { force: true });
}

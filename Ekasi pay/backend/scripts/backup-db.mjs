/**
 * Hot backup of the SQLite database using the native backup API (consistent snapshot).
 *
 * Usage:
 *   cd backend && node scripts/backup-db.mjs
 *   BACKUP_DIR=./backups node scripts/backup-db.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DATABASE_PATH =
  process.env.DATABASE_PATH ??
  path.resolve(__dirname, '..', 'data', 'ekasi-pay.db');
const BACKUP_DIR =
  process.env.BACKUP_DIR ??
  path.resolve(__dirname, '..', 'backups');

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

if (!fs.existsSync(DATABASE_PATH)) {
  console.error(`Database not found: ${DATABASE_PATH}`);
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const dest = path.join(BACKUP_DIR, `ekasi-pay-${stamp()}.db`);

const source = new Database(DATABASE_PATH, { readonly: true });
source.backup(dest)
  .then(() => {
    source.close();
    console.log(`Backup written: ${dest}`);
  })
  .catch((err) => {
    source.close();
    console.error('Backup failed:', err.message);
    process.exit(1);
  });

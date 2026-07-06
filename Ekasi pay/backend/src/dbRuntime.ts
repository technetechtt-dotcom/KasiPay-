import { getDb, closeDb } from './db.js';
import { IS_POSTGRES } from './config.js';
import { closePg, initPg } from './dbPg.js';

export function isPostgresMode(): boolean {
  return IS_POSTGRES;
}

export async function initDataStore(): Promise<void> {
  if (isPostgresMode()) {
    await initPg();
    return;
  }
  getDb();
}

export async function closeDataStore(): Promise<void> {
  if (isPostgresMode()) {
    await closePg();
    return;
  }
  closeDb();
}

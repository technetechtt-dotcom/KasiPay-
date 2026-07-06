import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import {
  clearCollectPinFailures,
  ensureCollectNotLocked,
  recordCollectPinFailure,
} from './security/collectPinAttempts.js';

function bootDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cash_send_collect_failures (
      reference_number TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_attempt_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('collectPinAttempts', () => {
  it('locks a voucher after five consecutive wrong PIN attempts', () => {
    const db = bootDb();
    const ref = 'CS-TEST-001';
    for (let i = 0; i < 5; i++) {
      recordCollectPinFailure(db, ref);
    }
    assert.throws(
      () => ensureCollectNotLocked(db, ref),
      (err: unknown) => {
        const e = err as { status?: number; message?: string };
        return e.status === 423 && /Too many wrong PINs/.test(e.message ?? '');
      },
    );
  });

  it('clears failures after a successful collect', () => {
    const db = bootDb();
    const ref = 'CS-TEST-002';
    recordCollectPinFailure(db, ref);
    recordCollectPinFailure(db, ref);
    clearCollectPinFailures(db, ref);
    assert.doesNotThrow(() => ensureCollectNotLocked(db, ref));
  });
});

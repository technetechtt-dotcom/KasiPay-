import type Database from 'better-sqlite3';

/**
 * Per-voucher failed collect-PIN lockout (4-digit voucher PIN brute-force guard).
 *
 * Policy:
 *   • 5 consecutive failures → lock for 15 min
 *   • 10 consecutive failures → lock for 60 min
 *   • Successful collect (or > 30 min idle) resets the counter
 */
const STEP_LOCKS: { atAttempts: number; lockMs: number }[] = [
  { atAttempts: 10, lockMs: 60 * 60_000 },
  { atAttempts: 5, lockMs: 15 * 60_000 },
];
const INACTIVITY_RESET_MS = 30 * 60_000;

type FailureRow = {
  reference_number: string;
  attempts: number;
  locked_until: string | null;
  last_attempt_at: string;
};

function readRow(
  db: Database.Database,
  referenceNumber: string,
): FailureRow | undefined {
  return db
    .prepare(
      'SELECT * FROM cash_send_collect_failures WHERE reference_number = ?',
    )
    .get(referenceNumber) as FailureRow | undefined;
}

export function ensureCollectNotLocked(
  db: Database.Database,
  referenceNumber: string,
): void {
  const row = readRow(db, referenceNumber);
  if (!row?.locked_until) return;
  if (new Date(row.locked_until).getTime() > Date.now()) {
    const secs = Math.max(
      1,
      Math.ceil(
        (new Date(row.locked_until).getTime() - Date.now()) / 1000,
      ),
    );
    throw Object.assign(
      new Error(
        `Too many wrong PINs for this voucher. Try again in ${Math.ceil(secs / 60)} min.`,
      ),
      { status: 423 },
    );
  }
}

export function recordCollectPinFailure(
  db: Database.Database,
  referenceNumber: string,
): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const existing = readRow(db, referenceNumber);
  let attempts = 1;
  if (existing) {
    const last = new Date(existing.last_attempt_at).getTime();
    attempts =
      now - last > INACTIVITY_RESET_MS ? 1 : existing.attempts + 1;
  }
  let lockedUntil: string | null = null;
  for (const step of STEP_LOCKS) {
    if (attempts >= step.atAttempts) {
      lockedUntil = new Date(now + step.lockMs).toISOString();
      break;
    }
  }
  db.prepare(
    `INSERT INTO cash_send_collect_failures (
       reference_number, attempts, locked_until, last_attempt_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(reference_number) DO UPDATE SET
       attempts = excluded.attempts,
       locked_until = excluded.locked_until,
       last_attempt_at = excluded.last_attempt_at`,
  ).run(referenceNumber, attempts, lockedUntil, nowIso);
}

export function clearCollectPinFailures(
  db: Database.Database,
  referenceNumber: string,
): void {
  db.prepare(
    'DELETE FROM cash_send_collect_failures WHERE reference_number = ?',
  ).run(referenceNumber);
}

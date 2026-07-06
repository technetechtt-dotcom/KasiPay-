import type Database from 'better-sqlite3';

/**
 * Per-user failed-PIN lockout. Independent of the IP-wide rate limiter — this
 * stops a slow / distributed brute-force that wouldn't trip the IP bucket.
 *
 * Policy:
 *   • 5 consecutive failures → lock for 5 min
 *   • 10 consecutive failures → lock for 30 min
 *   • A successful login (or > 30 min of inactivity) resets the counter
 */
const STEP_LOCKS: { atAttempts: number; lockMs: number }[] = [
  { atAttempts: 10, lockMs: 30 * 60_000 },
  { atAttempts: 5, lockMs: 5 * 60_000 },
];
const INACTIVITY_RESET_MS = 30 * 60_000;

type FailureRow = {
  user_id: string;
  attempts: number;
  locked_until: string | null;
  last_attempt_at: string;
};

function readRow(
  db: Database.Database,
  userId: string,
): FailureRow | undefined {
  return db
    .prepare('SELECT * FROM pin_login_failures WHERE user_id = ?')
    .get(userId) as FailureRow | undefined;
}

/** Throw a 423-style error if the user is currently locked out. */
export function ensureNotLocked(db: Database.Database, userId: string): void {
  const row = readRow(db, userId);
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
        `Too many wrong PINs. Try again in ${Math.ceil(secs / 60)} min.`,
      ),
      { status: 423 },
    );
  }
}

/** Record a failed PIN attempt and apply step-wise lockouts. */
export function recordPinFailure(
  db: Database.Database,
  userId: string,
): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const existing = readRow(db, userId);
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
    `INSERT INTO pin_login_failures (user_id, attempts, locked_until, last_attempt_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       attempts = excluded.attempts,
       locked_until = excluded.locked_until,
       last_attempt_at = excluded.last_attempt_at`,
  ).run(userId, attempts, lockedUntil, nowIso);
}

/** Reset the counter on successful login. */
export function clearPinFailures(
  db: Database.Database,
  userId: string,
): void {
  db.prepare('DELETE FROM pin_login_failures WHERE user_id = ?').run(userId);
}

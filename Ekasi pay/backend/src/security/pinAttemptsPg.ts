import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;

/**
 * Per-user failed-PIN lockout for Postgres mode.
 */
const STEP_LOCKS: { atAttempts: number; lockMs: number }[] = [
  { atAttempts: 10, lockMs: 30 * 60_000 },
  { atAttempts: 5, lockMs: 5 * 60_000 },
];
const INACTIVITY_RESET_MS = 30 * 60_000;

type FailureRow = {
  attempts: number;
  locked_until: string | null;
  last_attempt_at: string;
};

async function readRow(db: DbClient, userId: string): Promise<FailureRow | null> {
  const r = await db.query<FailureRow>(
    `SELECT attempts, locked_until, last_attempt_at
       FROM pin_login_failures
      WHERE user_id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

export async function ensureNotLockedPg(pool: Pool, userId: string): Promise<void> {
  const row = await readRow(pool, userId);
  if (!row?.locked_until) return;
  const lockedUntil = new Date(row.locked_until).getTime();
  if (lockedUntil > Date.now()) {
    const secs = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
    throw Object.assign(
      new Error(
        `Too many wrong PINs. Try again in ${Math.ceil(secs / 60)} min.`,
      ),
      { status: 423 },
    );
  }
}

export async function recordPinFailurePg(pool: Pool, userId: string): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const existing = await readRow(pool, userId);

  let attempts = 1;
  if (existing) {
    const last = new Date(existing.last_attempt_at).getTime();
    attempts = now - last > INACTIVITY_RESET_MS ? 1 : existing.attempts + 1;
  }

  let lockedUntil: string | null = null;
  for (const step of STEP_LOCKS) {
    if (attempts >= step.atAttempts) {
      lockedUntil = new Date(now + step.lockMs).toISOString();
      break;
    }
  }

  await pool.query(
    `INSERT INTO pin_login_failures (user_id, attempts, locked_until, last_attempt_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       attempts = EXCLUDED.attempts,
       locked_until = EXCLUDED.locked_until,
       last_attempt_at = EXCLUDED.last_attempt_at`,
    [userId, attempts, lockedUntil, nowIso],
  );
}

export async function clearPinFailuresPg(db: DbClient, userId: string): Promise<void> {
  await db.query(`DELETE FROM pin_login_failures WHERE user_id = $1`, [userId]);
}

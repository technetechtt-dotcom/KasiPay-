import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;

const STEP_LOCKS: { atAttempts: number; lockMs: number }[] = [
  { atAttempts: 10, lockMs: 60 * 60_000 },
  { atAttempts: 5, lockMs: 15 * 60_000 },
];
const INACTIVITY_RESET_MS = 30 * 60_000;

type FailureRow = {
  attempts: number;
  locked_until: string | null;
  last_attempt_at: string;
};

async function readRow(
  db: DbClient,
  referenceNumber: string,
): Promise<FailureRow | null> {
  const r = await db.query<FailureRow>(
    `SELECT attempts, locked_until, last_attempt_at
       FROM cash_send_collect_failures
      WHERE reference_number = $1`,
    [referenceNumber],
  );
  return r.rows[0] ?? null;
}

export async function ensureCollectNotLockedPg(
  pool: Pool,
  referenceNumber: string,
): Promise<void> {
  const row = await readRow(pool, referenceNumber);
  if (!row?.locked_until) return;
  const lockedUntil = new Date(row.locked_until).getTime();
  if (lockedUntil > Date.now()) {
    const secs = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
    throw Object.assign(
      new Error(
        `Too many wrong PINs for this voucher. Try again in ${Math.ceil(secs / 60)} min.`,
      ),
      { status: 423 },
    );
  }
}

export async function recordCollectPinFailurePg(
  pool: Pool,
  referenceNumber: string,
): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const existing = await readRow(pool, referenceNumber);

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
    `INSERT INTO cash_send_collect_failures (
       reference_number, attempts, locked_until, last_attempt_at
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (reference_number) DO UPDATE SET
       attempts = EXCLUDED.attempts,
       locked_until = EXCLUDED.locked_until,
       last_attempt_at = EXCLUDED.last_attempt_at`,
    [referenceNumber, attempts, lockedUntil, nowIso],
  );
}

export async function clearCollectPinFailuresPg(
  db: DbClient,
  referenceNumber: string,
): Promise<void> {
  await db.query(
    `DELETE FROM cash_send_collect_failures WHERE reference_number = $1`,
    [referenceNumber],
  );
}

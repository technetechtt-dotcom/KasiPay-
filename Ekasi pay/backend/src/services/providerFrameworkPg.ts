import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;
export type ProviderState =
  | 'created'
  | 'submitted'
  | 'accepted'
  | 'fulfilled'
  | 'failed'
  | 'unknown'
  | 'reversed';

export type ProviderResult = {
  state: Exclude<ProviderState, 'created' | 'submitted' | 'reversed'>;
  providerReference?: string;
  response: unknown;
  token?: string;
};

export interface ProviderAdapter {
  submit(input: {
    instructionId: string;
    idempotencyKey: string;
    payload: unknown;
    signature: string;
    timestamp: string;
  }): Promise<ProviderResult>;
  query(providerReference: string): Promise<ProviderResult>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

export function providerPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function signProviderRequest(
  secret: string,
  timestamp: string,
  payloadHash: string,
): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payloadHash}`).digest('hex');
}

export function verifyProviderCallback(input: {
  secret: string;
  timestamp: string;
  payload: unknown;
  signature: string;
  now?: Date;
  toleranceMs?: number;
}): boolean {
  const at = Date.parse(input.timestamp);
  if (!Number.isFinite(at)) return false;
  if (Math.abs((input.now ?? new Date()).getTime() - at) > (input.toleranceMs ?? 300_000)) {
    return false;
  }
  const expected = signProviderRequest(
    input.secret,
    input.timestamp,
    providerPayloadHash(input.payload),
  );
  const actualBuffer = Buffer.from(input.signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

export function boundedRetryDelayMs(attempt: number, entropy = Math.random()): number {
  const base = Math.min(30_000, 250 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(base * (0.75 + Math.max(0, Math.min(1, entropy)) * 0.5));
}

export async function createProviderInstructionPg(
  database: DbClient,
  input: {
    endpointId: string;
    instructionType: string;
    idempotencyKey: string;
    financialReference: string;
    journalTransactionId?: string;
    payload: unknown;
  },
): Promise<string> {
  const id = randomUUID();
  const hash = providerPayloadHash(input.payload);
  const result = await database.query<{ id: string }>(
    `INSERT INTO provider_instructions
       (id, endpoint_id, instruction_type, idempotency_key, financial_reference,
        journal_transaction_id, request_payload, request_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (endpoint_id, idempotency_key) DO UPDATE
       SET request_sha256 = provider_instructions.request_sha256
       WHERE provider_instructions.request_sha256 = EXCLUDED.request_sha256
     RETURNING id`,
    [
      id,
      input.endpointId,
      input.instructionType,
      input.idempotencyKey,
      input.financialReference,
      input.journalTransactionId ?? null,
      JSON.stringify(input.payload),
      hash,
    ],
  );
  if (!result.rows[0]) throw Object.assign(new Error('Idempotency key payload conflict'), { status: 409 });
  return result.rows[0].id;
}

export async function dispatchProviderInstructionPg(
  database: DbClient,
  input: {
    instructionId: string;
    signingSecret: string;
    adapter: ProviderAdapter;
    timeoutMs: number;
    maxAttempts: number;
  },
): Promise<ProviderResult> {
  const locked = await database.query<{
    id: string;
    idempotency_key: string;
    request_payload: unknown;
    request_sha256: string;
    state: ProviderState;
    attempts: number;
    provider_reference: string | null;
  }>(
    `SELECT id, idempotency_key, request_payload, request_sha256, state, attempts,
            provider_reference
       FROM provider_instructions WHERE id = $1 FOR UPDATE`,
    [input.instructionId],
  );
  const row = locked.rows[0];
  if (!row) throw Object.assign(new Error('Provider instruction not found'), { status: 404 });
  if (row.state === 'fulfilled' || row.state === 'reversed') {
    return { state: row.state === 'fulfilled' ? 'fulfilled' : 'failed', response: { replay: true }, providerReference: row.provider_reference ?? undefined };
  }
  if (row.attempts >= input.maxAttempts) throw new Error('Provider instruction exhausted retries');

  const timestamp = new Date().toISOString();
  const signature = signProviderRequest(input.signingSecret, timestamp, row.request_sha256);
  const started = Date.now();
  let result: ProviderResult;
  try {
    const call =
      row.state === 'unknown' && row.provider_reference
        ? input.adapter.query(row.provider_reference)
        : input.adapter.submit({
            instructionId: row.id,
            idempotencyKey: row.idempotency_key,
            payload: row.request_payload,
            signature,
            timestamp,
          });
    result = await Promise.race([
      call,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('Provider timeout'), { code: 'TIMEOUT' })), input.timeoutMs),
      ),
    ]);
  } catch (error) {
    const attempt = row.attempts + 1;
    const unknown = (error as { code?: string }).code === 'TIMEOUT';
    await database.query(
      `UPDATE provider_instructions
          SET state = $2, attempts = $3, unknown_since = CASE WHEN $2 = 'unknown'
               THEN COALESCE(unknown_since, clock_timestamp()) ELSE unknown_since END,
              next_attempt_at = clock_timestamp() + ($4 * interval '1 millisecond'),
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [row.id, unknown ? 'unknown' : 'failed', attempt, boundedRetryDelayMs(attempt)],
    );
    await database.query(
      `INSERT INTO provider_attempts
         (id, instruction_id, attempt_number, request_sha256, outcome, error_code, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        row.id,
        attempt,
        row.request_sha256,
        unknown ? 'timeout' : 'failed',
        (error as { code?: string }).code ?? 'ADAPTER_ERROR',
        Date.now() - started,
      ],
    );
    throw error;
  }

  const attempt = row.attempts + 1;
  const responseHash = providerPayloadHash(result.response);
  await database.query(
    `UPDATE provider_instructions
        SET state = $2, attempts = $3, response_sha256 = $4,
            provider_reference = COALESCE($5, provider_reference),
            token_fingerprint = COALESCE($6, token_fingerprint),
            fulfilled_at = CASE WHEN $2 = 'fulfilled' THEN clock_timestamp() ELSE fulfilled_at END,
            updated_at = clock_timestamp()
      WHERE id = $1`,
    [
      row.id,
      result.state,
      attempt,
      responseHash,
      result.providerReference ?? null,
      result.token ? providerPayloadHash(result.token) : null,
    ],
  );
  await database.query(
    `INSERT INTO provider_attempts
       (id, instruction_id, attempt_number, request_sha256, response_sha256,
        outcome, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), row.id, attempt, row.request_sha256, responseHash, result.state, Date.now() - started],
  );
  return result;
}

/** Deterministic simulator for contract and failure-recovery tests only. */
export class ProviderSimulator implements ProviderAdapter {
  readonly submissions = new Map<string, ProviderResult>();

  constructor(
    private readonly behavior: 'fulfilled' | 'failed' | 'timeout' | 'unknown_then_fulfilled' = 'fulfilled',
  ) {}

  async submit(input: { idempotencyKey: string }): Promise<ProviderResult> {
    const existing = this.submissions.get(input.idempotencyKey);
    if (existing) return existing;
    if (this.behavior === 'timeout') {
      return new Promise(() => undefined);
    }
    const providerReference = `SIM-${providerPayloadHash(input.idempotencyKey).slice(0, 16)}`;
    const result: ProviderResult =
      this.behavior === 'failed'
        ? { state: 'failed', providerReference, response: { code: 'SIM_REJECTED' } }
        : this.behavior === 'unknown_then_fulfilled'
          ? { state: 'unknown', providerReference, response: { code: 'SIM_UNKNOWN' } }
          : {
              state: 'fulfilled',
              providerReference,
              response: { code: 'SIM_OK' },
              token: `TOKEN-${providerPayloadHash(input.idempotencyKey).slice(0, 12)}`,
            };
    this.submissions.set(input.idempotencyKey, result);
    return result;
  }

  async query(providerReference: string): Promise<ProviderResult> {
    const found = [...this.submissions.values()].find(
      (result) => result.providerReference === providerReference,
    );
    if (!found) return { state: 'unknown', providerReference, response: { code: 'SIM_NOT_FOUND' } };
    if (found.state === 'unknown') {
      const fulfilled: ProviderResult = {
        state: 'fulfilled',
        providerReference,
        response: { code: 'SIM_RECOVERED' },
        token: `TOKEN-${providerPayloadHash(providerReference).slice(0, 12)}`,
      };
      for (const [key, value] of this.submissions) {
        if (value.providerReference === providerReference) this.submissions.set(key, fulfilled);
      }
      return fulfilled;
    }
    return found;
  }
}

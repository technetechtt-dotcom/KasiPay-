import { createHash, randomUUID } from 'node:crypto';

const SECRET_KEY = /(authorization|cookie|password|pin|otp|token|secret|api[-_]?key|id[_-]?document)/i;
const PII_KEY = /(phone|email|address|full[_-]?name|recipient|beneficiary)/i;

export function hashSensitive(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (PII_KEY.test(key) && typeof value === 'string') return `[HASH:${hashSensitive(value).slice(0, 12)}]`;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redact(child, childKey),
      ]),
    );
  }
  if (typeof value === 'string') {
    return value.replace(/\b\d{13}\b/g, '[REDACTED_ID]');
  }
  return value;
}

export function structuredLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redact(fields) as Record<string, unknown>,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

type Metric = { count: number; total: number; max: number };
const metrics = new Map<string, Metric>();

export function observeMetric(name: string, value = 1): void {
  const current = metrics.get(name) ?? { count: 0, total: 0, max: 0 };
  current.count += 1;
  current.total += value;
  current.max = Math.max(current.max, value);
  metrics.set(name, current);
}

export function metricsSnapshot(): Record<string, Metric> {
  return Object.fromEntries(metrics.entries());
}

export type TraceHook = (span: {
  traceId: string;
  name: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  safeAttributes: Record<string, unknown>;
}) => void;

let traceHook: TraceHook | undefined;
export function registerTraceHook(hook: TraceHook): void {
  traceHook = hook;
}

export async function traced<T>(
  name: string,
  attributes: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const traceId = randomUUID();
  try {
    const result = await work();
    traceHook?.({ traceId, name, startedAt, durationMs: Date.now() - startedAt, status: 'ok', safeAttributes: redact(attributes) as Record<string, unknown> });
    return result;
  } catch (error) {
    traceHook?.({ traceId, name, startedAt, durationMs: Date.now() - startedAt, status: 'error', safeAttributes: redact(attributes) as Record<string, unknown> });
    throw error;
  }
}

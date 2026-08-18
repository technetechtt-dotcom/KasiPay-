import { toast } from 'sonner';

import {
  ApiError,
  apiCreateExpense,
  apiCreateSale,
  apiStockIntake,
  apiUpdateProduct,
  type StockIntakeLine,
} from '../services/api';
import type { Expense } from '../types';
import type { MoneyInput } from '../money';

/**
 * Tiny offline outbox for "loss is unacceptable" mutations. We queue sales,
 * expenses, and stock mutations — money movement (`/transfers`, `/cash-send`)
 * goes straight to the network so the user gets immediate confirmation that
 * money actually left their wallet. The outbox cooperates with the
 * server-side `Idempotency-Key` middleware: each queued entry has a stable
 * key, so a replay that *did* succeed last time is short-circuited.
 *
 * Persistence is `localStorage` v2 (`kasiPay.outbox.v2`) with attempt backoff,
 * a short multi-tab lock, and 409 treated as idempotent success. v1 queues are
 * migrated on read. Per-device and per-origin on purpose.
 */
const OUTBOX_KEY = 'kasiPay.outbox.v2';
const OUTBOX_LEGACY_KEY = 'kasiPay.outbox.v1';
const OUTBOX_LOCK_KEY = 'kasiPay.outbox.lock';
const FLUSH_DEBOUNCE_MS = 250;
const LOCK_TTL_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export type StockIntakePayload = {
  supplierName?: string;
  slipReference?: string;
  slipTotal?: MoneyInput;
  notes?: string;
  recordExpense?: boolean;
  lines: StockIntakeLine[];
};

export type OutboxEntry =
  | {
      id: string;
      kind: 'sale';
      idempotencyKey: string;
      enqueuedAt: string;
      attempts?: number;
      nextAttemptAt?: string;
      payload: Parameters<typeof apiCreateSale>[0];
    }
  | {
      id: string;
      kind: 'expense';
      idempotencyKey: string;
      enqueuedAt: string;
      attempts?: number;
      nextAttemptAt?: string;
      payload: Omit<Expense, 'id' | 'merchantId' | 'createdAt'>;
    }
  | {
      id: string;
      kind: 'stock_intake';
      idempotencyKey: string;
      enqueuedAt: string;
      attempts?: number;
      nextAttemptAt?: string;
      payload: StockIntakePayload;
    }
  | {
      id: string;
      kind: 'stock_patch';
      idempotencyKey: string;
      enqueuedAt: string;
      attempts?: number;
      nextAttemptAt?: string;
      payload: { productId: string; stock: number };
    };

function parseEntries(raw: string | null): OutboxEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

function readOutbox(): OutboxEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const current = parseEntries(window.localStorage.getItem(OUTBOX_KEY));
    if (current.length > 0) return current;
    const legacy = parseEntries(window.localStorage.getItem(OUTBOX_LEGACY_KEY));
    if (legacy.length > 0) {
      writeOutbox(legacy);
      window.localStorage.removeItem(OUTBOX_LEGACY_KEY);
      return legacy;
    }
    return [];
  } catch {
    return [];
  }
}

function writeOutbox(entries: OutboxEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(OUTBOX_KEY);
    } else {
      window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
    }
  } catch {
    /* ignore quota / private-mode errors */
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `out_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function outboxSize(): number {
  return readOutbox().length;
}

export function enqueueSale(payload: Parameters<typeof apiCreateSale>[0]): OutboxEntry {
  const entry: OutboxEntry = {
    id: newId(),
    kind: 'sale',
    idempotencyKey: newId(),
    enqueuedAt: new Date().toISOString(),
    payload,
  };
  writeOutbox([...readOutbox(), entry]);
  return entry;
}

export function enqueueExpense(
  payload: Omit<Expense, 'id' | 'merchantId' | 'createdAt'>,
): OutboxEntry {
  const entry: OutboxEntry = {
    id: newId(),
    kind: 'expense',
    idempotencyKey: newId(),
    enqueuedAt: new Date().toISOString(),
    payload,
  };
  writeOutbox([...readOutbox(), entry]);
  return entry;
}

export function enqueueStockIntake(payload: StockIntakePayload): OutboxEntry {
  const entry: OutboxEntry = {
    id: newId(),
    kind: 'stock_intake',
    idempotencyKey: newId(),
    enqueuedAt: new Date().toISOString(),
    payload,
  };
  writeOutbox([...readOutbox(), entry]);
  return entry;
}

export function enqueueStockPatch(productId: string, stock: number): OutboxEntry {
  const entry: OutboxEntry = {
    id: newId(),
    kind: 'stock_patch',
    idempotencyKey: newId(),
    enqueuedAt: new Date().toISOString(),
    payload: { productId, stock },
  };
  writeOutbox([...readOutbox(), entry]);
  return entry;
}

async function attemptFlushOnce(entry: OutboxEntry): Promise<'sent' | 'retry' | 'drop'> {
  try {
    if (entry.kind === 'sale') {
      await apiCreateSale(entry.payload, entry.idempotencyKey);
    } else if (entry.kind === 'expense') {
      await apiCreateExpense(entry.payload, entry.idempotencyKey);
    } else if (entry.kind === 'stock_intake') {
      await apiStockIntake(entry.payload, entry.idempotencyKey);
    } else {
      await apiUpdateProduct(
        entry.payload.productId,
        { stock: entry.payload.stock },
        entry.idempotencyKey,
      );
    }
    return 'sent';
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) return 'sent';
      if (e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429) {
        toast.error(`Queued ${entry.kind} dropped: ${e.message}`);
        return 'drop';
      }
    }
    return 'retry';
  }
}

function acquireFlushLock(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(OUTBOX_LOCK_KEY);
    const now = Date.now();
    if (raw) {
      const heldAt = Number(raw);
      if (Number.isFinite(heldAt) && now - heldAt < LOCK_TTL_MS) return false;
    }
    window.localStorage.setItem(OUTBOX_LOCK_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}

function releaseFlushLock(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(OUTBOX_LOCK_KEY);
  } catch {
    /* ignore */
  }
}

let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Drain the queue from the oldest entry. We process serially so a sale
 * that depends on stock from the previous sale doesn't race. Returns the
 * number of entries successfully sent.
 */
export async function flushOutbox(): Promise<number> {
  if (flushing) return 0;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
  if (!acquireFlushLock()) return 0;
  flushing = true;
  let sent = 0;
  try {
    let queue = readOutbox();
    while (queue.length > 0) {
      const head = queue[0];
      const notBefore = head.nextAttemptAt ? Date.parse(head.nextAttemptAt) : 0;
      if (Number.isFinite(notBefore) && notBefore > Date.now()) break;
      const result = await attemptFlushOnce(head);
      if (result === 'retry') {
        const attempts = (head.attempts ?? 0) + 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 8));
        queue[0] = {
          ...head,
          attempts,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
        };
        writeOutbox(queue);
        break;
      }
      queue = queue.slice(1);
      writeOutbox(queue);
      if (result === 'sent') sent += 1;
    }
  } finally {
    flushing = false;
    releaseFlushLock();
  }
  if (sent > 0) toast.success(`${sent} queued item(s) synced.`);
  return sent;
}

/** Coalesce rapid online/visibility events into a single flush. */
export function scheduleFlush(onFlushed?: (sent: number) => void): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOutbox().then((sent) => {
      if (onFlushed) onFlushed(sent);
    });
  }, FLUSH_DEBOUNCE_MS);
}

/** Attach window listeners once. Returns a cleanup function. */
export function installOutboxAutoFlush(
  onFlushed?: (sent: number) => void,
): () => void {
  if (typeof window === 'undefined') {
    return function noopCleanup() {
      /* no-op when running outside the browser (SSR / tests) */
    };
  }
  const run = () => scheduleFlush(onFlushed);
  const onOnline = () => run();
  const onFocus = () => run();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') run();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  run();
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    if (flushTimer) clearTimeout(flushTimer);
  };
}

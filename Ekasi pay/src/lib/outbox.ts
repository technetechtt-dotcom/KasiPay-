import { toast } from 'sonner';

import {
  ApiError,
  apiCreateExpense,
  apiCreateSale,
} from '../services/api';
import type { Expense } from '../types';

/**
 * Tiny offline outbox for "loss is unacceptable" mutations. We only queue
 * sales and expenses — money movement (`/transfers`, `/cash-send`) goes
 * straight to the network so the user gets immediate confirmation that
 * money actually left their wallet. The outbox cooperates with the
 * server-side `Idempotency-Key` middleware: each queued entry has a stable
 * key, so a replay that *did* succeed last time is short-circuited.
 *
 * Persistence is `localStorage` — survives a tab close, but is per-device
 * and per-origin (deliberate; an outbox shouldn't follow you to a kiosk).
 */
const OUTBOX_KEY = 'kasiPay.outbox.v1';
const FLUSH_DEBOUNCE_MS = 250;

export type OutboxEntry =
  | {
      id: string;
      kind: 'sale';
      idempotencyKey: string;
      enqueuedAt: string;
      payload: Parameters<typeof apiCreateSale>[0];
    }
  | {
      id: string;
      kind: 'expense';
      idempotencyKey: string;
      enqueuedAt: string;
      payload: Omit<Expense, 'id' | 'merchantId' | 'createdAt'>;
    };

function readOutbox(): OutboxEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
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

async function attemptFlushOnce(entry: OutboxEntry): Promise<'sent' | 'retry' | 'drop'> {
  try {
    if (entry.kind === 'sale') {
      await apiCreateSale(entry.payload, entry.idempotencyKey);
    } else {
      await apiCreateExpense(entry.payload, entry.idempotencyKey);
    }
    return 'sent';
  } catch (e) {
    // 4xx other than 401 means the request will never succeed (validation,
    // insufficient stock, etc.) — drop with a toast so the merchant knows.
    if (e instanceof ApiError) {
      if (e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429) {
        toast.error(`Queued ${entry.kind} dropped: ${e.message}`);
        return 'drop';
      }
    }
    return 'retry';
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
  flushing = true;
  let sent = 0;
  try {
    let queue = readOutbox();
    while (queue.length > 0) {
      const head = queue[0];
      const result = await attemptFlushOnce(head);
      if (result === 'retry') {
        // Network or server hiccup — keep entry, stop trying (we'll re-arm).
        break;
      }
      // 'sent' or 'drop' — pop from queue.
      queue = queue.slice(1);
      writeOutbox(queue);
      if (result === 'sent') sent += 1;
    }
  } finally {
    flushing = false;
  }
  if (sent > 0) toast.success(`${sent} queued item(s) synced.`);
  return sent;
}

/** Coalesce rapid online/visibility events into a single flush. */
export function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOutbox();
  }, FLUSH_DEBOUNCE_MS);
}

/** Attach window listeners once. Returns a cleanup function. */
export function installOutboxAutoFlush(): () => void {
  if (typeof window === 'undefined') {
    return function noopCleanup() {
      /* no-op when running outside the browser (SSR / tests) */
    };
  }
  const onOnline = () => scheduleFlush();
  const onFocus = () => scheduleFlush();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') scheduleFlush();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  scheduleFlush();
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    if (flushTimer) clearTimeout(flushTimer);
  };
}

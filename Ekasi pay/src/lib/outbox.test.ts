import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enqueueExpense,
  enqueueSale,
  enqueueStockIntake,
  enqueueStockPatch,
  flushOutbox,
  outboxSize,
} from './outbox';

vi.mock('../services/api', async () => {
  const calls: {
    sale: unknown[];
    expense: unknown[];
    stockIntake: unknown[];
    stockPatch: unknown[];
  } = {
    sale: [],
    expense: [],
    stockIntake: [],
    stockPatch: [],
  };
  const failures = { sale: 0, expense: 0, stockIntake: 0, stockPatch: 0, saleConflict: 0 };
  class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError: FakeApiError,
    __reset: () => {
      calls.sale.length = 0;
      calls.expense.length = 0;
      calls.stockIntake.length = 0;
      calls.stockPatch.length = 0;
      failures.sale = 0;
      failures.expense = 0;
      failures.stockIntake = 0;
      failures.stockPatch = 0;
      failures.saleConflict = 0;
    },
    __setFailures: (kind: keyof typeof failures, n: number) => {
      failures[kind] = n;
    },
    __calls: calls,
    apiCreateSale: vi.fn(async (payload: unknown, key?: string) => {
      if (failures.sale > 0) {
        failures.sale -= 1;
        throw new FakeApiError(503, 'flaky network');
      }
      if (failures.saleConflict > 0) {
        failures.saleConflict -= 1;
        throw new FakeApiError(409, 'duplicate');
      }
      calls.sale.push({ payload, key });
      return { sale: { id: `sale-${calls.sale.length}` } };
    }),
    apiCreateExpense: vi.fn(async (payload: unknown, key?: string) => {
      if (failures.expense > 0) {
        failures.expense -= 1;
        throw new FakeApiError(503, 'flaky network');
      }
      calls.expense.push({ payload, key });
      return { expense: { id: `expense-${calls.expense.length}` } };
    }),
    apiStockIntake: vi.fn(async (payload: unknown, key?: string) => {
      if (failures.stockIntake > 0) {
        failures.stockIntake -= 1;
        throw new FakeApiError(503, 'flaky network');
      }
      calls.stockIntake.push({ payload, key });
      return { products: [], slip: { id: 'slip-1' }, movementIds: [] };
    }),
    apiUpdateProduct: vi.fn(async (id: string, body: unknown, key?: string) => {
      if (failures.stockPatch > 0) {
        failures.stockPatch -= 1;
        throw new FakeApiError(503, 'flaky network');
      }
      calls.stockPatch.push({ id, body, key });
      return { product: { id, stock: (body as { stock: number }).stock } };
    }),
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

async function resetApiMock(): Promise<void> {
  const mod = await import('../services/api');
  (mod as unknown as { __reset: () => void }).__reset();
}

async function setFailures(
  kind: 'sale' | 'expense' | 'stockIntake' | 'stockPatch' | 'saleConflict',
  n: number,
): Promise<void> {
  const mod = await import('../services/api');
  (
    mod as unknown as {
      __setFailures: (k: typeof kind, n: number) => void;
    }
  ).__setFailures(kind, n);
}

async function calls() {
  const mod = await import('../services/api');
  return (
    mod as unknown as {
      __calls: {
        sale: unknown[];
        expense: unknown[];
        stockIntake: unknown[];
        stockPatch: unknown[];
      };
    }
  ).__calls;
}

describe('outbox', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await resetApiMock();
  });

  it('queues sales and expenses', () => {
    enqueueSale({
      items: [{ productId: 'p1', quantity: 1, price: 10 }],
      paymentMethod: 'cash',
    });
    enqueueExpense({
      category: 'electricity',
      description: 'Token',
      amount: 30,
    });
    expect(outboxSize()).toBe(2);
  });

  it('queues stock intake and stock patches', () => {
    enqueueStockIntake({
      recordExpense: false,
      lines: [{ productId: 'p1', quantity: 3, costPrice: '10.00' }],
    });
    enqueueStockPatch('p1', 7);
    expect(outboxSize()).toBe(2);
  });

  it('drains the queue in FIFO order with stable idempotency keys', async () => {
    const sale1 = enqueueSale({
      items: [{ productId: 'p1', quantity: 1, price: 10 }],
      paymentMethod: 'cash',
    });
    const sale2 = enqueueSale({
      items: [{ productId: 'p2', quantity: 2, price: 20 }],
      paymentMethod: 'cash',
    });
    await flushOutbox();
    const seen = (await calls()).sale as Array<{ key?: string }>;
    expect(seen.map((c) => c.key)).toEqual([
      sale1.idempotencyKey,
      sale2.idempotencyKey,
    ]);
    expect(outboxSize()).toBe(0);
  });

  it('flushes stock mutations with their idempotency keys', async () => {
    const intake = enqueueStockIntake({
      lines: [{ productId: 'p1', quantity: 2, costPrice: '5.00' }],
    });
    const patch = enqueueStockPatch('p1', 9);
    await flushOutbox();
    const seen = await calls();
    expect((seen.stockIntake[0] as { key?: string }).key).toBe(intake.idempotencyKey);
    expect((seen.stockPatch[0] as { key?: string }).key).toBe(patch.idempotencyKey);
    expect(outboxSize()).toBe(0);
  });

  it('stops draining after a 5xx and resumes on the next flush', async () => {
    vi.useFakeTimers();
    await setFailures('sale', 1);
    enqueueSale({
      items: [{ productId: 'p1', quantity: 1, price: 10 }],
      paymentMethod: 'cash',
    });
    enqueueSale({
      items: [{ productId: 'p2', quantity: 1, price: 10 }],
      paymentMethod: 'cash',
    });

    const sentFirst = await flushOutbox();
    expect(sentFirst).toBe(0);
    expect(outboxSize()).toBe(2);

    // Advance time past the exponential backoff (2 seconds for attempt 1)
    await vi.advanceTimersByTimeAsync(2500);

    const sentSecond = await flushOutbox();
    expect(sentSecond).toBe(2);
    expect(outboxSize()).toBe(0);
    vi.useRealTimers();
  });

  it('treats idempotent 409 as success so the queue can drain', async () => {
    await setFailures('saleConflict', 1);
    enqueueSale({
      items: [{ productId: 'p1', quantity: 1, price: 10 }],
      paymentMethod: 'cash',
    });
    const sent = await flushOutbox();
    expect(sent).toBe(1);
    expect(outboxSize()).toBe(0);
  });
});

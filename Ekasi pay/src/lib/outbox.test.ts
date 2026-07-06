import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enqueueExpense,
  enqueueSale,
  flushOutbox,
  outboxSize,
} from './outbox';

// `apiCreateSale` / `apiCreateExpense` live in services/api. The outbox only
// touches them through the module boundary, so we mock them globally.
vi.mock('../services/api', async () => {
  const calls: { sale: unknown[]; expense: unknown[] } = {
    sale: [],
    expense: [],
  };
  const failures = { sale: 0, expense: 0 };
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
      failures.sale = 0;
      failures.expense = 0;
    },
    __setFailures: (kind: 'sale' | 'expense', n: number) => {
      failures[kind] = n;
    },
    __calls: calls,
    apiCreateSale: vi.fn(
      async (payload: unknown, key?: string) => {
        if (failures.sale > 0) {
          failures.sale -= 1;
          throw new FakeApiError(503, 'flaky network');
        }
        calls.sale.push({ payload, key });
        return { sale: { id: `sale-${calls.sale.length}` } };
      },
    ),
    apiCreateExpense: vi.fn(
      async (payload: unknown, key?: string) => {
        if (failures.expense > 0) {
          failures.expense -= 1;
          throw new FakeApiError(503, 'flaky network');
        }
        calls.expense.push({ payload, key });
        return { expense: { id: `expense-${calls.expense.length}` } };
      },
    ),
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

async function setFailures(kind: 'sale' | 'expense', n: number): Promise<void> {
  const mod = await import('../services/api');
  (
    mod as unknown as {
      __setFailures: (k: 'sale' | 'expense', n: number) => void;
    }
  ).__setFailures(kind, n);
}

async function calls() {
  const mod = await import('../services/api');
  return (mod as unknown as { __calls: { sale: unknown[]; expense: unknown[] } })
    .__calls;
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

  it('stops draining after a 5xx and resumes on the next flush', async () => {
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

    const sentSecond = await flushOutbox();
    expect(sentSecond).toBe(2);
    expect(outboxSize()).toBe(0);
  });
});

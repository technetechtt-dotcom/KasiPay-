import { createHash } from 'node:crypto';

export type LoanScheduleInput = {
  principalCents: bigint;
  interestBps: number;
  initiationFeeCents: bigint;
  serviceFeeCents: bigint;
  termCount: number;
  firstDueDate: string;
  termUnit: 'week' | 'month';
};

export type LoanScheduleItem = {
  sequence: number;
  dueDate: string;
  principalCents: bigint;
  interestCents: bigint;
  feeCents: bigint;
  totalCents: bigint;
};

function allocate(total: bigint, count: number): bigint[] {
  if (total < 0n || !Number.isSafeInteger(count) || count <= 0) {
    throw new Error('Allocation requires a non-negative total and positive term count.');
  }
  const divisor = BigInt(count);
  const base = total / divisor;
  const remainder = Number(total % divisor);
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1n : 0n));
}

function addTerm(date: Date, sequence: number, unit: 'week' | 'month'): Date {
  const next = new Date(date);
  if (unit === 'week') {
    next.setUTCDate(next.getUTCDate() + sequence * 7);
    return next;
  }
  const originalDay = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + sequence);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(originalDay, lastDay));
  return next;
}

export function calculateLoanSchedule(input: LoanScheduleInput): {
  items: LoanScheduleItem[];
  interestCents: bigint;
  feeCents: bigint;
  totalCents: bigint;
} {
  if (input.principalCents <= 0n) throw new Error('Principal must be positive.');
  if (!Number.isInteger(input.interestBps) || input.interestBps < 0 || input.interestBps > 10_000) {
    throw new Error('Interest basis points must be between 0 and 10000.');
  }
  const firstDue = new Date(`${input.firstDueDate}T00:00:00.000Z`);
  if (Number.isNaN(firstDue.getTime())) throw new Error('firstDueDate must be YYYY-MM-DD.');
  const interestCents =
    (input.principalCents * BigInt(input.interestBps) + 5_000n) / 10_000n;
  const feeCents =
    input.initiationFeeCents + input.serviceFeeCents * BigInt(input.termCount);
  const principal = allocate(input.principalCents, input.termCount);
  const interest = allocate(interestCents, input.termCount);
  const serviceFees = allocate(
    input.serviceFeeCents * BigInt(input.termCount),
    input.termCount,
  );
  const items = principal.map((principalCents, index) => {
    const itemFee = serviceFees[index] + (index === 0 ? input.initiationFeeCents : 0n);
    const due = addTerm(firstDue, index, input.termUnit);
    return {
      sequence: index + 1,
      dueDate: due.toISOString().slice(0, 10),
      principalCents,
      interestCents: interest[index],
      feeCents: itemFee,
      totalCents: principalCents + interest[index] + itemFee,
    };
  });
  return {
    items,
    interestCents,
    feeCents,
    totalCents: input.principalCents + interestCents + feeCents,
  };
}

export function allocateLoanRepayment(input: {
  paymentCents: bigint;
  feeOutstandingCents: bigint;
  interestOutstandingCents: bigint;
  principalOutstandingCents: bigint;
}) {
  if (input.paymentCents <= 0n) throw new Error('Payment must be positive.');
  const balances = [
    ['fee', input.feeOutstandingCents],
    ['interest', input.interestOutstandingCents],
    ['principal', input.principalOutstandingCents],
  ] as const;
  let remaining = input.paymentCents;
  const allocations: Array<{
    component: 'fee' | 'interest' | 'principal';
    amountCents: bigint;
    sequence: number;
  }> = [];
  for (const [component, balance] of balances) {
    if (balance < 0n) throw new Error('Outstanding balances cannot be negative.');
    const amountCents = remaining < balance ? remaining : balance;
    if (amountCents > 0n) {
      allocations.push({ component, amountCents, sequence: allocations.length + 1 });
      remaining -= amountCents;
    }
  }
  return { allocations, unappliedCents: remaining };
}

export function assessAffordability(input: {
  incomeCents: bigint;
  expenseCents: bigint;
  existingDebtCents: bigint;
  proposedInstallmentCents: bigint;
  minimumBufferCents: bigint;
}) {
  const disposableCents =
    input.incomeCents - input.expenseCents - input.existingDebtCents;
  return {
    disposableCents,
    eligible:
      disposableCents >= input.proposedInstallmentCents + input.minimumBufferCents,
  };
}

export function stableJsonSha256(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return typeof item === 'bigint' ? item.toString() : item;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

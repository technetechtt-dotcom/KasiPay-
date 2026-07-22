export type Money = string;
export type MoneyInput = string | number;

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u;

export function moneyToCents(value: MoneyInput): bigint {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  if (/[eE]/u.test(unsigned)) throw new Error('Exponent notation is not allowed');
  const match = DECIMAL.exec(unsigned);
  if (!match) throw new Error('Enter a valid amount with at most 2 decimals');
  const cents =
    BigInt(match[1]) * 100n +
    BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return negative ? -cents : cents;
}

export function centsToMoney(cents: bigint): Money {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, '0')}`;
}

export function canonicalMoney(value: MoneyInput): Money {
  return centsToMoney(moneyToCents(value));
}

export function tryCanonicalMoney(value: MoneyInput): Money | null {
  try {
    return canonicalMoney(value);
  } catch {
    return null;
  }
}

export function formatMoney(value: MoneyInput): string {
  return canonicalMoney(value);
}

export function addMoney(...values: MoneyInput[]): Money {
  return centsToMoney(values.reduce((sum, value) => sum + moneyToCents(value), 0n));
}

export function subtractMoney(left: MoneyInput, right: MoneyInput): Money {
  return centsToMoney(moneyToCents(left) - moneyToCents(right));
}

export function multiplyMoney(value: MoneyInput, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) throw new Error('Invalid quantity');
  return centsToMoney(moneyToCents(value) * BigInt(quantity));
}

export function absMoney(value: MoneyInput): Money {
  const cents = moneyToCents(value);
  return centsToMoney(cents < 0n ? -cents : cents);
}

export function compareMoney(left: MoneyInput, right: MoneyInput): number {
  const l = moneyToCents(left);
  const r = moneyToCents(right);
  return l === r ? 0 : l < r ? -1 : 1;
}

export function minMoney(left: MoneyInput, right: MoneyInput): Money {
  return compareMoney(left, right) <= 0
    ? canonicalMoney(left)
    : canonicalMoney(right);
}

export function moneyRatioPercent(
  numerator: MoneyInput,
  denominator: MoneyInput,
): number {
  const denominatorCents = moneyToCents(denominator);
  if (denominatorCents === 0n) return 0;
  return (
    Number((moneyToCents(numerator) * 10_000n) / denominatorCents) / 100
  );
}

export function moneyFromRate(
  value: MoneyInput,
  numerator: bigint,
  denominator: bigint,
): Money {
  const product = moneyToCents(value) * numerator;
  const rounded = (product + denominator / 2n) / denominator;
  return centsToMoney(rounded);
}

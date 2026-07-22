export type Money = string;

const MONEY = /^-?(0|[1-9]\d*)(?:\.\d{1,2})?$/u;

export function moneyToCents(value: Money): bigint {
  if (!MONEY.test(value)) throw new Error(`Invalid money value: ${value}`);
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return negative ? -cents : cents;
}

export function formatMoney(value: Money): string {
  const cents = moneyToCents(value);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `R${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, '0')}`;
}

export function addMoney(left: Money, right: Money): Money {
  const cents = moneyToCents(left) + moneyToCents(right);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, '0')}`;
}

import { z } from 'zod';

export type Cents = bigint & { readonly __cents: unique symbol };
export type FixedRate = {
  units: bigint;
  scale: bigint;
};

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u;
const RATE = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u;
const MAX_CENTS = 9_223_372_036_854_775_807n;

function inputText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Money must be finite');
    return String(value);
  }
  throw new Error('Money must be a canonical decimal string or number');
}

export function parseZarToCents(
  value: unknown,
  options: { allowZero?: boolean; allowNegative?: boolean } = {},
): Cents {
  const text = inputText(value);
  if (/[eE]/u.test(text)) throw new Error('Exponent notation is not allowed');
  if (text.startsWith('-')) {
    if (!options.allowNegative) throw new Error('Money cannot be negative');
    return (-parseZarToCents(text.slice(1), {
      ...options,
      allowNegative: false,
      allowZero: true,
    })) as Cents;
  }
  const match = DECIMAL.exec(text);
  if (!match) {
    throw new Error(
      'Money must be a canonical decimal with at most 2 decimal places',
    );
  }
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = whole * 100n + BigInt(fraction || '0');
  if (cents > MAX_CENTS) throw new Error('Money exceeds BIGINT range');
  if (cents === 0n && !options.allowZero) {
    throw new Error('Money must be greater than zero');
  }
  return cents as Cents;
}

export function parseIntegerCents(
  value: unknown,
  options: { allowZero?: boolean; allowNegative?: boolean } = {},
): Cents {
  let cents: bigint;
  if (typeof value === 'bigint') cents = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    cents = BigInt(value);
  } else if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/u.test(value)) {
    cents = BigInt(value);
  } else {
    throw new Error('Cents must be a safe canonical integer');
  }
  if (cents < 0n && !options.allowNegative) {
    throw new Error('Cents cannot be negative');
  }
  if (cents === 0n && !options.allowZero) {
    throw new Error('Cents must be greater than zero');
  }
  if (cents > MAX_CENTS || cents < -MAX_CENTS) {
    throw new Error('Cents exceed BIGINT range');
  }
  return cents as Cents;
}

export function formatCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function parseFixedRate(value: unknown): FixedRate {
  const text = inputText(value);
  if (/[eE]/u.test(text)) throw new Error('Exponent notation is not allowed');
  const match = RATE.exec(text);
  if (!match) {
    throw new Error('Rate must have at most 6 decimal places');
  }
  const decimals = match[2]?.length ?? 0;
  const scale = 10n ** BigInt(decimals);
  return {
    units: BigInt(match[1]) * scale + BigInt(match[2] ?? '0'),
    scale,
  };
}

/** Explicit half-up rounding at the final cent boundary. */
export function multiplyCentsByRate(cents: Cents, rate: FixedRate): Cents {
  const numerator = cents * rate.units;
  const rounded = (numerator + rate.scale / 2n) / rate.scale;
  return parseIntegerCents(rounded, {
    allowZero: true,
    allowNegative: true,
  });
}

export function multiplyCentsByQuantity(cents: Cents, quantity: number): Cents {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error('Quantity must be a nonnegative safe integer');
  }
  return parseIntegerCents(cents * BigInt(quantity), {
    allowZero: true,
    allowNegative: true,
  });
}

export const positiveMoneyInput = z
  .union([z.string(), z.number()])
  .superRefine((value, ctx) => {
    try {
      parseZarToCents(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid money',
      });
    }
  });

export const nonnegativeMoneyInput = z
  .union([z.string(), z.number()])
  .superRefine((value, ctx) => {
    try {
      parseZarToCents(value, { allowZero: true });
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid money',
      });
    }
  });

/** Compatibility schemas for handlers not yet converted to a bigint contract. */
export const positiveMoneyNumber = positiveMoneyInput.transform((value) =>
  Number(value),
);
export const nonnegativeMoneyNumber = nonnegativeMoneyInput.transform((value) =>
  Number(value),
);

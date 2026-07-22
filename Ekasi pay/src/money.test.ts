import { describe, expect, it } from 'vitest';

import {
  addMoney,
  canonicalMoney,
  moneyFromRate,
  moneyToCents,
  multiplyMoney,
} from './money';

describe('client money helpers', () => {
  it('normalizes cents without binary floating point', () => {
    expect(canonicalMoney('0.01')).toBe('0.01');
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(multiplyMoney('12.34', 3)).toBe('37.02');
    expect(moneyFromRate('100.00', 7n, 10n)).toBe('70.00');
  });

  it.each(['0.001', '1e2', '01.00', 'NaN', 'Infinity'])(
    'rejects noncanonical input %s',
    (value) => {
      expect(() => moneyToCents(value)).toThrow();
    },
  );

  it('supports the maximum safe API decimal as bigint', () => {
    expect(moneyToCents('9007199254740991.00')).toBe(
      900719925474099100n,
    );
  });
});

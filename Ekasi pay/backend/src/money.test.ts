import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCents,
  multiplyCentsByQuantity,
  multiplyCentsByRate,
  parseFixedRate,
  parseIntegerCents,
  parseZarToCents,
} from './money.js';

test('parses and formats canonical ZAR without floating point', () => {
  const cases: Array<[string | number, bigint, string]> = [
    ['0.01', 1n, '0.01'],
    ['1', 100n, '1.00'],
    ['1.2', 120n, '1.20'],
    [12.34, 1234n, '12.34'],
    ['92233720368547758.07', 9_223_372_036_854_775_807n, '92233720368547758.07'],
  ];
  for (const [input, cents, formatted] of cases) {
    const parsed = parseZarToCents(input);
    assert.equal(parsed, cents);
    assert.equal(formatCents(parsed), formatted);
  }
});

test('rejects unsupported money representations and precision', () => {
  for (const input of [
    '0.001',
    '1e2',
    'NaN',
    'Infinity',
    -1,
    0,
    '01.00',
    '0001.20',
    '92233720368547758.08',
  ]) {
    assert.throws(() => parseZarToCents(input));
  }
  assert.equal(parseZarToCents('0.00', { allowZero: true }), 0n);
  assert.equal(parseZarToCents('-1.23', { allowNegative: true }), -123n);
});

test('accepts only safe integer minor units', () => {
  assert.equal(parseIntegerCents(123), 123n);
  assert.equal(parseIntegerCents('123'), 123n);
  assert.throws(() => parseIntegerCents(1.2));
  assert.throws(() => parseIntegerCents(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => parseIntegerCents('01'));
});

test('performs totals and fixed-rate arithmetic with bigint', () => {
  const price = parseZarToCents('19.99');
  assert.equal(multiplyCentsByQuantity(price, 3), 5997n);
  assert.equal(multiplyCentsByRate(price, parseFixedRate('0.5')), 1000n);
  assert.equal(
    multiplyCentsByRate(parseZarToCents('100.00'), parseFixedRate('0.075')),
    750n,
  );
  assert.throws(() => parseFixedRate('0.0000001'));
  assert.throws(() => parseFixedRate('1e-2'));
});

test('round trips a broad deterministic cent range', () => {
  for (let cents = 1n; cents <= 100_000n; cents += 97n) {
    assert.equal(parseZarToCents(formatCents(cents)), cents);
  }
});

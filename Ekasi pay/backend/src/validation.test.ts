import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  expenseCreateSchema,
  cashSendVoucherPin,
  isWeakPin,
  saleCreateSchema,
  strongMoneyPin,
  transferBodySchema,
} from './validation.js';

describe('isWeakPin', () => {
  it('flags short PINs as weak', () => {
    assert.equal(isWeakPin('123'), true);
    assert.equal(isWeakPin(''), true);
  });

  it('flags repeated digits', () => {
    assert.equal(isWeakPin('0000'), true);
    assert.equal(isWeakPin('111111'), true);
  });

  it('flags ascending and descending sequences', () => {
    assert.equal(isWeakPin('1234'), true);
    assert.equal(isWeakPin('4321'), true);
    assert.equal(isWeakPin('98765'), true);
  });

  it('accepts strong PINs', () => {
    assert.equal(isWeakPin('19273'), false);
    assert.equal(isWeakPin('8024691'), false);
  });
});

describe('cashSendVoucherPin schema', () => {
  it('accepts a non-trivial 4-digit voucher PIN', () => {
    assert.equal(cashSendVoucherPin.safeParse('1927').success, true);
  });

  it('rejects PINs shorter or longer than 4 digits', () => {
    assert.equal(cashSendVoucherPin.safeParse('123').success, false);
    assert.equal(cashSendVoucherPin.safeParse('12345').success, false);
  });

  it('rejects weak 4-digit patterns', () => {
    assert.equal(cashSendVoucherPin.safeParse('1234').success, false);
    assert.equal(cashSendVoucherPin.safeParse('0000').success, false);
  });
});

describe('strongMoneyPin schema', () => {
  it('rejects PINs shorter than 5 digits', () => {
    assert.equal(strongMoneyPin.safeParse('1234').success, false);
  });

  it('rejects non-digit characters', () => {
    assert.equal(strongMoneyPin.safeParse('12a45').success, false);
  });

  it('rejects weak patterns inside the length window', () => {
    assert.equal(strongMoneyPin.safeParse('11111').success, false);
    assert.equal(strongMoneyPin.safeParse('12345').success, false);
  });

  it('accepts a non-trivial 5-digit PIN', () => {
    const parsed = strongMoneyPin.safeParse('19273');
    assert.equal(parsed.success, true);
  });
});

describe('transferBodySchema', () => {
  it('strips whitespace from the phone field', () => {
    const r = transferBodySchema.safeParse({
      toPhone: '082 123 4567',
      amount: '50.25',
      description: 'lunch',
    });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.toPhone, '0821234567');
      assert.equal(r.data.amount, 50.25);
    }
  });

  it('rejects zero and negative amounts', () => {
    assert.equal(
      transferBodySchema.safeParse({
        toPhone: '0821234567',
        amount: 0,
        description: 'x',
      }).success,
      false,
    );
    assert.equal(
      transferBodySchema.safeParse({
        toPhone: '0821234567',
        amount: -1,
        description: 'x',
      }).success,
      false,
    );
  });

  it('rejects exponent notation and sub-cent precision', () => {
    for (const amount of ['0.001', '1e2', 'NaN', 'Infinity']) {
      assert.equal(
        transferBodySchema.safeParse({
          toPhone: '0821234567',
          amount,
          description: 'test',
        }).success,
        false,
      );
    }
  });

  it('rejects empty descriptions', () => {
    assert.equal(
      transferBodySchema.safeParse({
        toPhone: '0821234567',
        amount: 10,
        description: '',
      }).success,
      false,
    );
  });
});

describe('saleCreateSchema', () => {
  it('requires at least one line item', () => {
    assert.equal(
      saleCreateSchema.safeParse({
        items: [],
        paymentMethod: 'cash',
      }).success,
      false,
    );
  });

  it('rejects fractional quantities', () => {
    assert.equal(
      saleCreateSchema.safeParse({
        items: [{ productId: 'p1', quantity: 0.5, price: 10 }],
        paymentMethod: 'cash',
      }).success,
      false,
    );
  });

  it('rejects negative prices', () => {
    assert.equal(
      saleCreateSchema.safeParse({
        items: [{ productId: 'p1', quantity: 1, price: -1 }],
        paymentMethod: 'cash',
      }).success,
      false,
    );
  });

  it('accepts a valid cash sale and coerces numeric fields', () => {
    const r = saleCreateSchema.safeParse({
      items: [{ productId: 'p1', quantity: '2', price: '15.50' }],
      paymentMethod: 'cash',
    });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.items[0].quantity, 2);
      assert.equal(r.data.items[0].price, 15.5);
    }
  });
});

describe('expenseCreateSchema', () => {
  it('rejects unknown categories', () => {
    assert.equal(
      expenseCreateSchema.safeParse({
        category: 'crypto',
        description: 'x',
        amount: 10,
      }).success,
      false,
    );
  });

  it('accepts the canonical electricity category', () => {
    assert.equal(
      expenseCreateSchema.safeParse({
        category: 'electricity',
        description: 'prepaid',
        amount: 50,
      }).success,
      true,
    );
  });
});

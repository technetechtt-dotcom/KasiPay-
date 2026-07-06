import { describe, expect, it } from 'vitest';

import type { Product } from '../../types';
import { findExistingMatch } from './findExistingMatch';

const products: Product[] = [
  {
    id: 'p1',
    merchantId: 'm1',
    name: 'Albany Bread',
    costPrice: 14,
    price: 18,
    stock: 5,
    category: 'Food',
    barcode: '6001234567890',
  },
  {
    id: 'p2',
    merchantId: 'm1',
    name: 'Coke 500ml',
    costPrice: 10,
    price: 16,
    stock: 20,
    category: 'Drinks',
  },
];

describe('findExistingMatch', () => {
  it('returns null when both name and barcode are empty', () => {
    expect(findExistingMatch(products, '', '')).toBeNull();
  });

  it('matches by barcode first (even if name differs)', () => {
    const match = findExistingMatch(products, 'A Misspelled Name', '6001234567890');
    expect(match?.id).toBe('p1');
  });

  it('matches when scan includes spaces', () => {
    const match = findExistingMatch(products, '', '600 1234 5678 90');
    expect(match?.id).toBe('p1');
  });

  it('matches by case-insensitive trimmed name when no barcode', () => {
    expect(findExistingMatch(products, '  albany bread  ', '')?.id).toBe('p1');
    expect(findExistingMatch(products, 'COKE 500ML', '')?.id).toBe('p2');
  });

  it('does not match an unrelated SKU', () => {
    expect(findExistingMatch(products, 'Albany Brown Bread', '')).toBeNull();
  });

  it('falls through to name match when the barcode does not match any SKU', () => {
    // Forgiving for typos — if the merchant typed/scanned a barcode that's
    // not in the catalogue but the name is, prefer the existing SKU.
    const match = findExistingMatch(products, 'Albany Bread', '0000');
    expect(match?.id).toBe('p1');
  });
});

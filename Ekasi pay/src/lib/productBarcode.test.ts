import { describe, expect, it } from 'vitest';

import {
  barcodesMatch,
  findProductByBarcode,
  groceryLookupCode,
  groceryScanDetail,
  gtin14ToEan13,
  normalizeProductBarcode,
  parseGroceryScan,
} from './productBarcode';
import type { Product } from '../types';

const products: Product[] = [
  {
    id: 'p1',
    merchantId: 'm1',
    name: 'White Bread',
    costPrice: 12,
    price: 18,
    stock: 5,
    category: 'Food',
    barcode: '6001234567890',
  },
  {
    id: 'p2',
    merchantId: 'm1',
    name: 'Counter Ham',
    costPrice: 80,
    price: 120,
    stock: 10,
    category: 'Food',
    barcode: '2012340000000',
  },
];

describe('normalizeProductBarcode', () => {
  it('pads 12-digit UPC-A to EAN-13', () => {
    expect(normalizeProductBarcode('012345678905')).toBe('0012345678905');
  });

  it('pads EAN-8 to EAN-13 with six leading zeros', () => {
    expect(normalizeProductBarcode('96385074')).toBe('00000096385074');
  });

  it('converts GTIN-14 / ITF-14 to EAN-13', () => {
    expect(normalizeProductBarcode('06001234567890')).toBe('6001234567890');
  });
});

describe('parseGroceryScan', () => {
  it('parses standard EAN-13', () => {
    const parsed = parseGroceryScan('6001234567890');
    expect(parsed.format).toBe('ean13');
    expect(parsed.lookupCode).toBe('6001234567890');
  });

  it('parses UPC-A (12 digits)', () => {
    const parsed = parseGroceryScan('012345678905');
    expect(parsed.format).toBe('upca');
  });

  it('parses EAN-8', () => {
    const parsed = parseGroceryScan('96385074');
    expect(parsed.format).toBe('ean8');
  });

  it('parses weighed deli label (prefix 2) with weight in grams', () => {
    const parsed = parseGroceryScan('2012340567890');
    expect(parsed.format).toBe('weighted_ean13');
    expect(parsed.weightedPlu).toBe('201234');
    expect(parsed.weightKg).toBeCloseTo(5.678, 3);
  });

  it('parses ITF-14 carton code', () => {
    const parsed = parseGroceryScan('06001234567890');
    expect(parsed.format).toBe('itf14');
    expect(parsed.lookupCode).toBe('6001234567890');
  });

  it('parses GS1 DataBar parentheses format', () => {
    const parsed = parseGroceryScan('(01)06001234567890(3103)000500(17)251231');
    expect(parsed.format).toBe('gs1_databar');
    expect(parsed.lookupCode).toBe('6001234567890');
    expect(parsed.weightKg).toBe(0.5);
  });

  it('flags HTTPS QR as digital link', () => {
    expect(parseGroceryScan('https://coupon.example.com/abc').isDigitalLink).toBe(
      true,
    );
  });
});

describe('findProductByBarcode', () => {
  it('finds packaged EAN-13', () => {
    expect(findProductByBarcode(products, '6001234567890')?.id).toBe('p1');
  });

  it('finds weighed item by PLU prefix', () => {
    expect(findProductByBarcode(products, '2012340567890')?.id).toBe('p2');
  });

  it('finds product from ITF-14 carton scan', () => {
    expect(
      findProductByBarcode(products, '06001234567890')?.id,
    ).toBe('p1');
  });

  it('ignores digital coupon links', () => {
    expect(findProductByBarcode(products, 'https://x.com/coupon')).toBeUndefined();
  });
});

describe('groceryScanDetail', () => {
  it('shows weight for weighed labels', () => {
    const parsed = parseGroceryScan('2012341234567');
    expect(groceryScanDetail(parsed)).toContain('kg');
  });
});

describe('gtin14ToEan13', () => {
  it('drops packaging indicator digit', () => {
    expect(gtin14ToEan13('06001234567890')).toBe('6001234567890');
  });
});

describe('barcodesMatch', () => {
  it('matches EAN-13 and ITF-14 variants', () => {
    expect(barcodesMatch('6001234567890', '06001234567890')).toBe(true);
  });
});

describe('groceryLookupCode', () => {
  it('extracts EAN from GS1 sticker', () => {
    expect(groceryLookupCode('(01)06001234567890(3103)000500')).toBe(
      '6001234567890',
    );
  });
});

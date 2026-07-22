import type { Product } from '../types';
import {
  centsToMoney,
  compareMoney,
  formatMoney,
  type Money,
} from '../money';

export type GroceryBarcodeFormat =
  | 'ean13'
  | 'ean8'
  | 'upca'
  | 'weighted_ean13'
  | 'itf14'
  | 'gs1_databar'
  | 'gs1_128'
  | 'qr'
  | 'data_matrix'
  | 'other';

export type ParsedGroceryScan = {
  raw: string;
  format: GroceryBarcodeFormat;
  /** Normalised code for inventory / Open Food Facts lookup (usually EAN-13). */
  lookupCode: string;
  gtin14?: string;
  /** PLU prefix for weighed items (`2` + 5-digit item code). */
  weightedPlu?: string;
  /** Embedded weight from scales or GS1 AI 310x (kilograms). */
  weightKg?: number;
  /** Embedded price from price-embedded weighed labels (ZAR). */
  priceZar?: Money;
  expiryYYMMDD?: string;
  batch?: string;
  /** QR/Data Matrix that looks like a URL or coupon — not a retail GTIN. */
  isDigitalLink?: boolean;
};

/**
 * Normalise retail barcodes for lookup.
 * - EAN-8 → zero-padded EAN-13 (`000000` + 8 digits)
 * - UPC-A (12) → leading-zero EAN-13
 * - GTIN-14 / ITF-14 → drop packaging indicator → EAN-13
 */
export function normalizeProductBarcode(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return trimmed;
  if (digits.length === 8) return `000000${digits}`;
  if (digits.length === 12) return `0${digits}`;
  if (digits.length === 14) return digits.slice(1);
  if (digits.length > 0 && digits.length < 13) {
    return digits.padStart(13, '0');
  }
  return digits;
}

/** GTIN-14 (AI 01 or ITF-14) → EAN-13 lookup key (drops packaging indicator digit). */
export function gtin14ToEan13(gtin14: string): string {
  const d = gtin14.replace(/\D/g, '');
  if (d.length === 14) return d.slice(1);
  if (d.length === 13) return d;
  if (d.length === 12) return `0${d}`;
  return normalizeProductBarcode(d);
}

/**
 * Variable-weight EAN-13 (prefix `2`) used at SA deli/bakery/produce scales.
 * Layout: `2` + 5-digit PLU + 5-digit value (grams or cents) + check digit.
 */
function parseWeightedEan13(digits: string): Partial<ParsedGroceryScan> | null {
  if (digits.length !== 13 || digits[0] !== '2') return null;

  const itemCode = digits.slice(1, 6);
  const valueField = digits.slice(6, 11);
  const valueNum = Number(valueField);
  if (!Number.isFinite(valueNum)) return null;

  const weightedPlu = `2${itemCode}`;
  const lookupCode = `${weightedPlu}${'0'.repeat(7)}`.slice(0, 13);

  const weightKg = valueNum / 1000;
  if (weightKg > 0 && weightKg <= 50) {
    return {
      format: 'weighted_ean13',
      lookupCode,
      weightedPlu,
      weightKg,
    };
  }

  const priceZar = centsToMoney(BigInt(valueField));
  if (valueNum > 0 && valueNum <= 1_000_000) {
    return {
      format: 'weighted_ean13',
      lookupCode,
      weightedPlu,
      priceZar,
    };
  }

  return {
    format: 'weighted_ean13',
    lookupCode,
    weightedPlu,
    weightKg: weightKg > 0 ? weightKg : undefined,
  };
}

function parseGs1ParenthesesPayload(raw: string): Partial<ParsedGroceryScan> | null {
  const gtin = raw.match(/\(01\)(\d{14})/);
  if (!gtin) return null;
  const gtin14 = gtin[1];
  const out: Partial<ParsedGroceryScan> = {
    format: 'gs1_databar',
    gtin14,
    lookupCode: gtin14ToEan13(gtin14),
  };
  const exp = raw.match(/\(17\)(\d{6})/);
  if (exp) out.expiryYYMMDD = exp[1];
  const lot = raw.match(/\(10\)([^(]+)/);
  if (lot) out.batch = lot[1].trim();
  const w3103 = raw.match(/\(3103\)(\d{6})/);
  if (w3103) out.weightKg = Number(w3103[1]) / 1000;
  const w3102 = raw.match(/\(3102\)(\d{6})/);
  if (w3102) out.weightKg = Number(w3102[1]) / 100;
  const w3101 = raw.match(/\(3101\)(\d{6})/);
  if (w3101) out.weightKg = Number(w3101[1]) / 10;
  const w3100 = raw.match(/\(3100\)(\d{6})/);
  if (w3100) out.weightKg = Number(w3100[1]);
  return out;
}

function parseGs1Concatenated(raw: string): Partial<ParsedGroceryScan> | null {
  const cleaned = raw
    .split(String.fromCharCode(29))
    .join('')
    .replace(/\|/g, '')
    .trim();
  const digits = cleaned.replace(/\D/g, '');
  if (!digits.startsWith('01') || digits.length < 16) return null;

  const gtin14 = digits.slice(2, 16);
  const out: Partial<ParsedGroceryScan> = {
    format: 'gs1_databar',
    gtin14,
    lookupCode: gtin14ToEan13(gtin14),
  };

  let i = 16;
  while (i < digits.length - 1) {
    const ai = digits.slice(i, i + 2);
    if (ai === '17' && digits.length >= i + 8) {
      out.expiryYYMMDD = digits.slice(i + 2, i + 8);
      i += 8;
      continue;
    }
    if (ai === '10') {
      const nextAi = digits.slice(i + 2).search(/0[0-9]{1}/);
      const lotEnd = nextAi === -1 ? digits.length : i + 2 + nextAi;
      out.batch = digits.slice(i + 2, lotEnd);
      i = lotEnd;
      continue;
    }
    if (digits.slice(i, i + 4) === '3103' && digits.length >= i + 10) {
      out.weightKg = Number(digits.slice(i + 4, i + 10)) / 1000;
      i += 10;
      continue;
    }
    if (digits.slice(i, i + 4) === '3102' && digits.length >= i + 10) {
      out.weightKg = Number(digits.slice(i + 4, i + 10)) / 100;
      i += 10;
      continue;
    }
    break;
  }
  return out;
}

function parseItf14(digits: string): Partial<ParsedGroceryScan> | null {
  if (digits.length !== 14) return null;
  return {
    format: 'itf14',
    gtin14: digits,
    lookupCode: gtin14ToEan13(digits),
  };
}

/**
 * Interpret a raw camera / wedge scan for grocery workflows.
 */
export function parseGroceryScan(raw: string): ParsedGroceryScan {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { raw, format: 'other', lookupCode: '' };
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return {
      raw: trimmed,
      format: 'qr',
      lookupCode: trimmed,
      isDigitalLink: true,
    };
  }

  const parenGs1 = parseGs1ParenthesesPayload(trimmed);
  if (parenGs1?.lookupCode) {
    return { raw: trimmed, ...parenGs1 } as ParsedGroceryScan;
  }

  const concatGs1 = parseGs1Concatenated(trimmed);
  if (concatGs1?.lookupCode) {
    return { raw: trimmed, ...concatGs1 } as ParsedGroceryScan;
  }

  const digits = trimmed.replace(/\D/g, '');

  const weighted = digits.length === 13 ? parseWeightedEan13(digits) : null;
  if (weighted?.lookupCode) {
    return { raw: trimmed, ...weighted } as ParsedGroceryScan;
  }

  const itf = parseItf14(digits);
  if (itf?.lookupCode) {
    return { raw: trimmed, ...itf } as ParsedGroceryScan;
  }

  if (digits.length === 12) {
    return {
      raw: trimmed,
      format: 'upca',
      lookupCode: normalizeProductBarcode(digits),
    };
  }
  if (digits.length === 8) {
    return {
      raw: trimmed,
      format: 'ean8',
      lookupCode: normalizeProductBarcode(digits),
    };
  }
  if (digits.length === 13) {
    return {
      raw: trimmed,
      format: 'ean13',
      lookupCode: normalizeProductBarcode(digits),
    };
  }

  if (/[A-Za-z]/.test(trimmed) && digits.length >= 8) {
    return {
      raw: trimmed,
      format: 'gs1_128',
      lookupCode: normalizeProductBarcode(digits),
    };
  }

  if (trimmed.length > 20 && /[^0-9]/.test(trimmed)) {
    return {
      raw: trimmed,
      format: 'qr',
      lookupCode: digits.length >= 8 ? normalizeProductBarcode(digits) : trimmed,
      isDigitalLink: !digits.startsWith('01'),
    };
  }

  return {
    raw: trimmed,
    format: 'other',
    lookupCode: digits.length > 0 ? normalizeProductBarcode(digits) : trimmed,
  };
}

function productMatchesScan(
  storedBarcode: string,
  parsed: ParsedGroceryScan,
): boolean {
  if (barcodesMatch(storedBarcode, parsed.lookupCode)) return true;
  if (parsed.weightedPlu) {
    const stored = storedBarcode.replace(/\D/g, '');
    const plu = parsed.weightedPlu.replace(/\D/g, '');
    if (stored.startsWith(plu) || plu.startsWith(stored.slice(0, 6))) return true;
    if (barcodesMatch(storedBarcode, parsed.weightedPlu)) return true;
  }
  if (parsed.gtin14 && barcodesMatch(storedBarcode, parsed.gtin14)) return true;
  if (barcodesMatch(storedBarcode, parsed.raw)) return true;
  return false;
}

/** Compare two barcodes after normalisation (ignores leading-zero / EAN-8 padding variants). */
export function barcodesMatch(a: string, b: string): boolean {
  const na = normalizeProductBarcode(a);
  const nb = normalizeProductBarcode(b);
  if (na === nb) return true;
  const stripLead = (s: string) => s.replace(/^0+/, '') || '0';
  return stripLead(na) === stripLead(nb);
}

export function findProductByBarcode(
  products: Product[],
  code: string,
): Product | undefined {
  const parsed = parseGroceryScan(code);
  if (parsed.isDigitalLink) return undefined;
  return products.find(
    (p) => !!p.barcode && productMatchesScan(p.barcode, parsed),
  );
}

export function groceryLookupCode(raw: string): string {
  const parsed = parseGroceryScan(raw);
  return parsed.isDigitalLink ? parsed.raw : parsed.lookupCode;
}

/** Human-readable suffix for toasts (weight or embedded price). */
export function groceryScanDetail(parsed: ParsedGroceryScan): string {
  if (parsed.weightKg != null && parsed.weightKg > 0) {
    return ` (${parsed.weightKg.toFixed(3)} kg)`;
  }
  if (parsed.priceZar != null && compareMoney(parsed.priceZar, 0) > 0) {
    return ` (R${formatMoney(parsed.priceZar)})`;
  }
  return '';
}

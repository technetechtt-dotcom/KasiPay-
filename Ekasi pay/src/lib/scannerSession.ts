export type ScannerCaptureKind =
  | 'product'
  | 'sender-id'
  | 'beneficiary-id'
  | 'collect-id';

/** Inventory: add stock. Shop / sale mode: subtract via cart or stock-out. */
export type StockScanMode = 'restock' | 'sale';

export type ScannerSessionPayload = {
  returnPage: string;
  capture: ScannerCaptureKind;
  /** Continuous scan until user taps Done (inventory / shop). */
  continuous?: boolean;
  stockMode?: StockScanMode;
};

const CONTEXT_KEY = 'ekasi.scannerSession';
const PENDING_SENDER = 'ekasi.saId.scan.sender';
const PENDING_BEN = 'ekasi.saId.scan.beneficiary';
const PENDING_COLLECT = 'ekasi.saId.scan.collect';
const SHOP_QUEUE_KEY = 'ekasi.shop.scan.queue';
const PENDING_PRODUCT_CATALOG_HIT = 'ekasi.product.scan.catalogHit';

export { normalizeProductBarcode } from './productBarcode';

import { isValidSaIdChecksum, scoreSaIdCandidate } from './saIdValidation';

export function writeScannerSession(p: ScannerSessionPayload): void {
  sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(p));
}

export function updateScannerSession(patch: Partial<ScannerSessionPayload>): void {
  const current = readScannerSession();
  if (!current) return;
  writeScannerSession({ ...current, ...patch });
}

export function readScannerSession(): ScannerSessionPayload | null {
  try {
    const r = sessionStorage.getItem(CONTEXT_KEY);
    if (!r) return null;
    return JSON.parse(r) as ScannerSessionPayload;
  } catch {
    return null;
  }
}

export function clearScannerSession(): void {
  sessionStorage.removeItem(CONTEXT_KEY);
}

export function isContinuousProductScan(ctx: ScannerSessionPayload | null): boolean {
  if (!ctx || ctx.capture !== 'product') return false;
  if (ctx.continuous === false) return false;
  return ctx.returnPage === 'inventory' || ctx.returnPage === 'shop';
}

export function defaultStockMode(
  ctx: ScannerSessionPayload | null,
): StockScanMode {
  if (ctx?.stockMode) return ctx.stockMode;
  if (ctx?.returnPage === 'shop') return 'sale';
  return 'restock';
}

/** Collect every 13-digit run from decoded barcode text (PDF417 often embeds extra fields). */
function saIdCandidatesFromRaw(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string) => {
    if (value.length !== 13 || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  const compact = raw.replace(/\s/g, '');
  const embedded = compact.match(/\d{13}/g);
  if (embedded) embedded.forEach(push);

  const digitsOnly = raw.replace(/\D/g, '');
  for (let i = 0; i <= digitsOnly.length - 13; i++) {
    push(digitsOnly.slice(i, i + 13));
  }
  return out;
}

/** Pick the best checksum-valid SA ID candidate from decoded barcode text. */
function pickBestSaIdCandidate(candidates: string[]): string | null {
  const valid = candidates.filter((c) => isValidSaIdChecksum(c));
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  return valid.reduce((best, cur) => {
    const bestScore = scoreSaIdCandidate(best);
    const curScore = scoreSaIdCandidate(cur);
    return curScore > bestScore ? cur : best;
  });
}

/** Strip formatting; prefer a checksum-valid 13-digit SA ID from PDF417 / Code128 payloads. */
export function digitsFromBarcodeForSaId(raw: string): string {
  const candidates = saIdCandidatesFromRaw(raw);
  const bestValid = pickBestSaIdCandidate(candidates);
  if (bestValid) return bestValid;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const dobLike = candidates.find((c) => {
      const yy = Number(c.slice(0, 2));
      const mm = Number(c.slice(2, 4));
      const dd = Number(c.slice(4, 6));
      return yy <= 99 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
    });
    if (dobLike) return dobLike;
    return candidates[0];
  }
  return raw.replace(/\D/g, '').slice(0, 13);
}

export function storeScannedSaId(
  kind: Exclude<ScannerCaptureKind, 'product'>,
  digits13: string,
): void {
  const v = digits13.replace(/\D/g, '').slice(0, 13);
  switch (kind) {
    case 'sender-id':
      sessionStorage.setItem(PENDING_SENDER, v);
      return;
    case 'beneficiary-id':
      sessionStorage.setItem(PENDING_BEN, v);
      return;
    case 'collect-id':
      sessionStorage.setItem(PENDING_COLLECT, v);
      return;
    default:
      return;
  }
}

export function consumePendingSenderSaId(): string | null {
  const v = sessionStorage.getItem(PENDING_SENDER);
  if (v) sessionStorage.removeItem(PENDING_SENDER);
  return v;
}

export function consumePendingBeneficiarySaId(): string | null {
  const v = sessionStorage.getItem(PENDING_BEN);
  if (v) sessionStorage.removeItem(PENDING_BEN);
  return v;
}

export function consumePendingCollectSaId(): string | null {
  const v = sessionStorage.getItem(PENDING_COLLECT);
  if (v) sessionStorage.removeItem(PENDING_COLLECT);
  return v;
}

export type PendingShopScan = {
  productId?: string;
  barcode?: string;
};

/** @deprecated Use enqueueShopScan for continuous mode. */
export function storePendingShopScan(payload: PendingShopScan): void {
  enqueueShopScan(payload);
}

export function consumePendingShopScan(): PendingShopScan | null {
  const q = drainShopScanQueue();
  return q[0] ?? null;
}

export function enqueueShopScan(payload: PendingShopScan): void {
  const raw = sessionStorage.getItem(SHOP_QUEUE_KEY);
  let q: PendingShopScan[] = [];
  if (raw) {
    try {
      q = JSON.parse(raw) as PendingShopScan[];
    } catch {
      q = [];
    }
  }
  q.push(payload);
  sessionStorage.setItem(SHOP_QUEUE_KEY, JSON.stringify(q));
}

export function drainShopScanQueue(): PendingShopScan[] {
  try {
    const raw = sessionStorage.getItem(SHOP_QUEUE_KEY);
    if (!raw) return [];
    sessionStorage.removeItem(SHOP_QUEUE_KEY);
    const q = JSON.parse(raw) as PendingShopScan[];
    return Array.isArray(q) ? q : [];
  } catch {
    sessionStorage.removeItem(SHOP_QUEUE_KEY);
    return [];
  }
}

export function openProductScanner(
  navigate: (page: string) => void,
  opts: {
    returnPage: 'inventory' | 'shop';
    stockMode?: StockScanMode;
  },
): void {
  writeScannerSession({
    capture: 'product',
    returnPage: opts.returnPage,
    continuous: true,
    stockMode: opts.stockMode ?? (opts.returnPage === 'shop' ? 'sale' : 'restock'),
  });
  navigate('scanner');
}

export type PendingProductCatalogHit = {
  code: string;
  found: boolean;
  name?: string;
  brand?: string;
  imageUrl?: string;
  category?: 'Food' | 'Drinks' | 'Household' | 'Airtime';
  source: 'openfoodfacts' | 'none';
};

export function storePendingProductCatalogHit(hit: PendingProductCatalogHit): void {
  sessionStorage.setItem(PENDING_PRODUCT_CATALOG_HIT, JSON.stringify(hit));
}

export function consumePendingProductCatalogHit(): PendingProductCatalogHit | null {
  try {
    const raw = sessionStorage.getItem(PENDING_PRODUCT_CATALOG_HIT);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_PRODUCT_CATALOG_HIT);
    const parsed = JSON.parse(raw) as PendingProductCatalogHit;
    if (!parsed || typeof parsed.code !== 'string') return null;
    if (typeof parsed.found !== 'boolean') return null;
    if (parsed.source !== 'openfoodfacts' && parsed.source !== 'none') return null;
    return parsed;
  } catch {
    sessionStorage.removeItem(PENDING_PRODUCT_CATALOG_HIT);
    return null;
  }
}

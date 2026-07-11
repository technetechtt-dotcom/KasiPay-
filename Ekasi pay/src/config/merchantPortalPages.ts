/**
 * Routes that require merchant workspace (only visible in merchant mode).
 * `scanner` is intentionally omitted — Cash Send ID scans in wallet mode also
 * navigate there; the session payload selects product vs ID capture.
 */
export const MERCHANT_PORTAL_PAGE_IDS = new Set([
  'shop',
  'inventory',
  'stock-value',
  'add-stock',
  'record-purchase-slip',
  'expenses',
  'analytics',
  'reports',
  'credit-book',
  'supplier-orders',
  'layby',
  'business-health',
  'price-comparison',
  'voice-notes',
  'food-safety',
]);

/**
 * Routes that only make sense in wallet mode. Money services (Cash Send /
 * send / receive) plus community money tools (stokvel + micro-insurance) which
 * are personal wallet features rather than shop dashboards.
 */
export const WALLET_ONLY_PAGE_IDS = new Set([
  'services',
  'send',
  'transfer',
  'receive',
  'stokvel',
  'insurance',
  'loadshedding',
]);

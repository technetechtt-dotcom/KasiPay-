import type {
  ComplianceFlag,
  ExpiryItem,
  FoodSafetyAlert,
  Product,
} from '../../types';

/** Below this stock level a product is treated as low-stock for the bell badge. */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Count signals that should light up the home bell:
 *   - Unread food-safety alerts
 *   - Open / pending compliance flags
 *   - Expiry items expiring within 7 days (or already expired)
 *   - Products at or below `LOW_STOCK_THRESHOLD`
 *
 * Keeping this in a plain `.ts` file (not a `.tsx` component module) lets the
 * Home screen import the count without the `react-refresh/only-export-components`
 * warning that would otherwise fire on `NotificationsPage.tsx`.
 */
export function countUnreadNotifications({
  alerts,
  flags,
  expiry,
  products,
}: {
  alerts: FoodSafetyAlert[];
  flags: ComplianceFlag[];
  expiry: ExpiryItem[];
  products: Product[];
}): number {
  let n = 0;
  for (const a of alerts) if (!a.isRead) n += 1;
  for (const f of flags) if (f.status === 'open' || f.status === 'pending') n += 1;
  const now = Date.now();
  for (const e of expiry) {
    const ts = new Date(e.expiryDate).getTime();
    if (Number.isFinite(ts) && (ts - now) / 86400000 <= 7) n += 1;
  }
  for (const p of products) if (p.stock <= LOW_STOCK_THRESHOLD) n += 1;
  return n;
}

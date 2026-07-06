import { describe, expect, it } from 'vitest';

import type {
  ComplianceFlag,
  ExpiryItem,
  FoodSafetyAlert,
  Product,
} from '../../types';
import { countUnreadNotifications } from './notificationCount';

const baseProduct: Product = {
  id: 'p1',
  merchantId: 'm1',
  name: 'Bread',
  costPrice: 10,
  price: 18,
  stock: 4,
  category: 'Bakery',
};

const baseAlert: FoodSafetyAlert = {
  id: 'a1',
  type: 'recall',
  title: 'Recall',
  description: 'Batch recall',
  severity: 'warning',
  createdAt: new Date().toISOString(),
  isRead: false,
};

const baseFlag: ComplianceFlag = {
  id: 'f1',
  userId: 'u1',
  reason: 'Unusual pattern',
  severity: 'medium',
  status: 'open',
  createdAt: new Date().toISOString(),
};

function expiryItem(daysOut: number, overrides: Partial<ExpiryItem> = {}): ExpiryItem {
  return {
    id: `e-${daysOut}`,
    productName: 'Milk',
    batchNumber: 'B1',
    quantity: 2,
    category: 'Dairy',
    supplierId: 's1',
    status: daysOut < 0 ? 'expired' : 'expiring-soon',
    expiryDate: new Date(Date.now() + daysOut * 86400000).toISOString(),
    ...overrides,
  };
}

describe('countUnreadNotifications', () => {
  it('counts unread alerts, open flags, near-expiry items, and low stock', () => {
    const count = countUnreadNotifications({
      alerts: [baseAlert, { ...baseAlert, id: 'a2', isRead: true }],
      flags: [baseFlag, { ...baseFlag, id: 'f2', status: 'resolved' }],
      expiry: [expiryItem(3), expiryItem(30)],
      products: [baseProduct, { ...baseProduct, id: 'p2', stock: 50 }],
    });
    // 1 unread alert + 1 open flag + 1 item expiring in 3 days + 1 low-stock product
    expect(count).toBe(4);
  });

  it('returns zero when everything is healthy', () => {
    const count = countUnreadNotifications({
      alerts: [{ ...baseAlert, isRead: true }],
      flags: [{ ...baseFlag, status: 'resolved' }],
      expiry: [expiryItem(30)],
      products: [{ ...baseProduct, stock: 100 }],
    });
    expect(count).toBe(0);
  });

  it('flags expired and same-day items as unread', () => {
    const expired = expiryItem(-2);
    const today = expiryItem(0);
    const count = countUnreadNotifications({
      alerts: [],
      flags: [],
      expiry: [expired, today],
      products: [],
    });
    expect(count).toBe(2);
  });
});

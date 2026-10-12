import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_PRODUCT_PAGES,
  DISABLED_RUNTIME_CONTROLS,
  isCustomerProductPageVisible,
  resolveCustomerProductVisibility,
} from './productVisibility';
import type { ProductReadinessStatus, RuntimeProductControls } from '../services/api';

const allReady: ProductReadinessStatus[] = [
  'stokvel',
  'lending',
  'merchant_credit',
  'insurance',
  'utilities',
].map((product) => ({
  product: product as ProductReadinessStatus['product'],
  environment: 'sandbox',
  enabled: true,
  databaseApproved: true,
  configEnabled: true,
  missing: [],
}));

const allOn: RuntimeProductControls = {
  financialPosting: true,
  lending: true,
  insurance: true,
  stokvelMoneyMovement: true,
  cashSend: true,
  liveUtilities: true,
};

describe('resolveCustomerProductVisibility', () => {
  it('hides everything when controls and readiness are off', () => {
    const visibility = resolveCustomerProductVisibility(
      DISABLED_RUNTIME_CONTROLS,
      [],
    );
    expect(visibility.cashSend).toBe(false);
    expect(visibility.stokvel).toBe(false);
    expect(visibility.insurance).toBe(false);
    expect(visibility.utilities).toBe(false);
    expect(visibility.merchantCredit).toBe(false);
    expect(visibility.lending).toBe(false);
  });

  it('requires both runtime flag and readiness for regulated products', () => {
    const visibility = resolveCustomerProductVisibility(allOn, allReady);
    expect(visibility.cashSend).toBe(true);
    expect(visibility.stokvel).toBe(true);
    expect(visibility.insurance).toBe(true);
    expect(visibility.utilities).toBe(true);
    expect(visibility.merchantCredit).toBe(true);
    expect(visibility.lending).toBe(true);
  });

  it('hides cash send when only the cash-send flag is off', () => {
    const visibility = resolveCustomerProductVisibility(
      { ...allOn, cashSend: false },
      allReady,
    );
    expect(visibility.cashSend).toBe(false);
    expect(visibility.utilities).toBe(true);
  });

  it('hides utilities when readiness fails even if liveUtilities is on', () => {
    const visibility = resolveCustomerProductVisibility(
      allOn,
      allReady.map((item) =>
        item.product === 'utilities' ? { ...item, enabled: false } : item,
      ),
    );
    expect(visibility.utilities).toBe(false);
  });

  it('fails closed when readiness is null', () => {
    const visibility = resolveCustomerProductVisibility(allOn, null);
    expect(visibility.cashSend).toBe(true);
    expect(visibility.stokvel).toBe(false);
    expect(visibility.insurance).toBe(false);
    expect(visibility.utilities).toBe(false);
    expect(visibility.merchantCredit).toBe(false);
  });
});

describe('isCustomerProductPageVisible', () => {
  it('maps customer routes to product gates', () => {
    expect(CUSTOMER_PRODUCT_PAGES.send).toBe('cashSend');
    expect(CUSTOMER_PRODUCT_PAGES.buy).toBe('utilities');
    const visibility = resolveCustomerProductVisibility(
      { ...allOn, cashSend: false, liveUtilities: false },
      allReady,
    );
    expect(isCustomerProductPageVisible('send', visibility)).toBe(false);
    expect(isCustomerProductPageVisible('buy', visibility)).toBe(false);
    expect(isCustomerProductPageVisible('home', visibility)).toBe(true);
  });
});

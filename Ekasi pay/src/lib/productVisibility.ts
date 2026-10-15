import type { ProductReadinessStatus, RuntimeProductControls } from '../services/api';

/** Fail-closed defaults while controls are loading or the API is unreachable. */
export const DISABLED_RUNTIME_CONTROLS: RuntimeProductControls = {
  financialPosting: false,
  lending: false,
  insurance: false,
  stokvelMoneyMovement: false,
  cashSend: false,
  liveUtilities: false,
};

export type CustomerProductVisibility = {
  cashSend: boolean;
  walletTransfer: boolean;
  stokvel: boolean;
  insurance: boolean;
  utilities: boolean;
  merchantCredit: boolean;
  lending: boolean;
};

export const HIDDEN_CUSTOMER_PRODUCTS: CustomerProductVisibility = {
  cashSend: false,
  walletTransfer: false,
  stokvel: false,
  insurance: false,
  utilities: false,
  merchantCredit: false,
  lending: false,
};

/** Customer routes that must stay hidden when the matching product is disabled. */
export const CUSTOMER_PRODUCT_PAGES: Record<string, keyof CustomerProductVisibility> = {
  services: 'cashSend',
  send: 'cashSend',
  receive: 'cashSend',
  transfer: 'walletTransfer',
  stokvel: 'stokvel',
  insurance: 'insurance',
  buy: 'utilities',
  'credit-book': 'merchantCredit',
};

function readinessEnabled(
  products: ProductReadinessStatus[] | null,
  product: ProductReadinessStatus['product'],
): boolean {
  if (!products) return false;
  return products.find((item) => item.product === product)?.enabled === true;
}

/**
 * Resolve which money/community products customers may see.
 * Runtime env flags and Phase-7 readiness both must pass (fail-closed).
 */
export function resolveCustomerProductVisibility(
  controls: RuntimeProductControls,
  readiness: ProductReadinessStatus[] | null,
): CustomerProductVisibility {
  return {
    cashSend: controls.cashSend === true,
    walletTransfer: controls.financialPosting === true,
    stokvel:
      controls.stokvelMoneyMovement === true &&
      readinessEnabled(readiness, 'stokvel'),
    insurance:
      controls.insurance === true && readinessEnabled(readiness, 'insurance'),
    utilities:
      controls.liveUtilities === true &&
      readinessEnabled(readiness, 'utilities'),
    merchantCredit: readinessEnabled(readiness, 'merchant_credit'),
    lending:
      controls.lending === true && readinessEnabled(readiness, 'lending'),
  };
}

export function isCustomerProductPageVisible(
  page: string,
  visibility: CustomerProductVisibility,
): boolean {
  const key = CUSTOMER_PRODUCT_PAGES[page];
  if (!key) return true;
  return visibility[key] === true;
}

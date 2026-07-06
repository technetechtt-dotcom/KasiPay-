import {
  NODE_ENV,
  UTILITY_MAX_AMOUNT,
  UTILITY_PROVIDER,
  UTILITY_VENDOR_API_KEY,
  UTILITY_VENDOR_WEBHOOK_URL,
} from '../config.js';

export type UtilityPurchaseInput = {
  category: 'airtime' | 'data' | 'electricity' | 'dstv';
  provider: string;
  beneficiary: string;
  amount: number;
  reference: string;
  userId: string;
};

export type UtilityPurchaseResult = {
  voucherCode: string;
  providerReference?: string;
  mocked: boolean;
};

export type UtilityProviderStatus = {
  available: boolean;
  mode: 'mock' | 'http' | 'disabled';
  maxAmount: number;
  mocked: boolean;
};

export function getUtilityProviderStatus(): UtilityProviderStatus {
  const mode = UTILITY_PROVIDER;
  return {
    available: mode !== 'disabled',
    mode,
    maxAmount: UTILITY_MAX_AMOUNT,
    mocked: mode === 'mock',
  };
}

function fakeVoucher(category: string): string {
  if (category === 'electricity') {
    return Array.from({ length: 5 }, () =>
      Math.floor(1000 + Math.random() * 9000).toString(),
    ).join('-');
  }
  if (category === 'dstv') {
    return `DSTV-${Math.floor(100000 + Math.random() * 900000)}`;
  }
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('');
}

async function purchaseViaHttp(
  input: UtilityPurchaseInput,
): Promise<UtilityPurchaseResult> {
  if (!UTILITY_VENDOR_WEBHOOK_URL) {
    throw Object.assign(
      new Error('UTILITY_VENDOR_WEBHOOK_URL is not configured'),
      { status: 503 },
    );
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (UTILITY_VENDOR_API_KEY) {
    headers.Authorization = `Bearer ${UTILITY_VENDOR_API_KEY}`;
  }
  const res = await fetch(UTILITY_VENDOR_WEBHOOK_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      category: input.category,
      provider: input.provider,
      beneficiary: input.beneficiary,
      amount: input.amount,
      reference: input.reference,
      userId: input.userId,
    }),
  });
  const text = await res.text();
  let body: {
    voucherCode?: string;
    providerReference?: string;
    error?: string;
  } | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as {
        voucherCode?: string;
        providerReference?: string;
        error?: string;
      };
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(body?.error ?? `Utility vendor returned ${res.status}`),
      { status: res.status >= 500 ? 503 : res.status },
    );
  }
  if (!body?.voucherCode) {
    throw Object.assign(
      new Error('Utility vendor response missing voucherCode'),
      { status: 502 },
    );
  }
  return {
    voucherCode: body.voucherCode,
    providerReference: body.providerReference,
    mocked: false,
  };
}

/**
 * Fulfill a utility purchase through the configured provider.
 * Throws objects with optional `status` for HTTP mapping.
 */
export async function fulfillUtilityPurchase(
  input: UtilityPurchaseInput,
): Promise<UtilityPurchaseResult> {
  if (input.amount > UTILITY_MAX_AMOUNT) {
    throw Object.assign(
      new Error(`Amount exceeds maximum of R${UTILITY_MAX_AMOUNT}`),
      { status: 400 },
    );
  }

  switch (UTILITY_PROVIDER) {
    case 'disabled':
      throw Object.assign(
        new Error('Utility purchases are not available on this deployment'),
        { status: 503 },
      );
    case 'mock': {
      if (NODE_ENV === 'production') {
        throw Object.assign(
          new Error('Mock utility provider is disabled in production'),
          { status: 503 },
        );
      }
      return {
        voucherCode: fakeVoucher(input.category),
        mocked: true,
      };
    }
    case 'http':
      return purchaseViaHttp(input);
    default:
      throw Object.assign(
        new Error(`Unknown UTILITY_PROVIDER "${UTILITY_PROVIDER}"`),
        { status: 500 },
      );
  }
}

import type { Page } from '@playwright/test';

const MERCHANT = {
  id: 'm-e2e',
  userId: 'u-e2e',
  businessName: 'E2E Spaza',
  location: 'Soweto',
  category: 'Retail',
  approvalStatus: 'approved',
};

export let lastCreateSaleBody: Record<string, unknown> | null = null;

const PRODUCT = {
  id: 'p-bread',
  merchantId: 'm-e2e',
  name: 'Bread',
  costPrice: '8.00',
  price: '12.00',
  stock: 20,
  category: 'Food',
};

export async function seedMerchantSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'kasiPay.prefs.v1',
      JSON.stringify({
        language: 'en',
        hasSeenOnboarding: true,
        workspaceMode: 'merchant',
      }),
    );
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();

    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (url.includes('/api/login') && method === 'POST') {
      return json({
        token: 'e2e-token',
        refreshToken: 'e2e-refresh',
        user: {
          id: 'u-e2e',
          name: 'E2E Merchant',
          phone: '0821234567',
          role: 'merchant',
          kycStatus: 'verified',
          accountTier: 'Basic',
          countryCode: 'ZA',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      });
    }
    if (url.includes('/api/wallets/me')) {
      return json({
        wallet: {
          id: 'w-e2e',
          userId: 'u-e2e',
          balance: '250.00',
          currency: 'ZAR',
          status: 'active',
          poolId: 'ZA',
          walletKind: 'user',
        },
      });
    }
    if (url.includes('/api/merchants/me')) {
      return json({ merchant: MERCHANT });
    }
    if (url.includes('/api/products')) {
      return json({ products: [PRODUCT] });
    }
    if (url.includes('/api/sales') && method === 'POST') {
      lastCreateSaleBody = request.postDataJSON() as Record<string, unknown>;
      const discount = lastCreateSaleBody.discount;
      return json(
        {
          sale: {
            id: 'sale-e2e',
            merchantId: 'm-e2e',
            items: [{ productId: PRODUCT.id, name: PRODUCT.name, quantity: 1, price: '12.00', subtotal: '12.00' }],
            total: discount ? '10.80' : '12.00',
            gross: '12.00',
            discount: discount ?? '0.00',
            paymentMethod: lastCreateSaleBody.paymentMethod ?? 'cash',
            createdAt: new Date().toISOString(),
            receiptNumber: 'KP-E2E-TEST',
          },
        },
        201,
      );
    }
    if (url.includes('/api/sales')) return json({ sales: [] });
    if (url.includes('/api/transactions')) return json({ transactions: [] });
    if (url.includes('/api/ledger')) return json({ ledger: [] });
    if (url.includes('/api/expenses')) return json({ expenses: [] });
    if (url.includes('/api/credit')) return json({ customers: [], transactions: [] });
    if (url.includes('/api/load-shedding')) return json({ slots: [] });
    if (url.includes('/api/suppliers')) return json({ suppliers: [], verifications: [] });
    if (url.includes('/api/loans')) return json({ loans: [] });
    if (url.includes('/api/compliance')) return json({ flags: [] });
    if (url.includes('/api/cash-send')) return json({ vouchers: [] });
    if (url.includes('/api/supplier-orders')) return json({ orders: [] });
    if (url.includes('/api/stokvel')) return json({ groups: [] });
    if (url.includes('/api/layby')) return json({ orders: [] });
    if (url.includes('/api/price-comparisons')) return json({ comparisons: [] });
    if (url.includes('/api/insurance')) return json({ policies: [] });
    if (url.includes('/api/voice-notes')) return json({ notes: [] });
    if (url.includes('/api/expiry')) return json({ items: [] });
    if (url.includes('/api/food-safety')) return json({ alerts: [] });
    if (url.includes('/api/stock-movements')) return json({ movements: [] });
    if (url.includes('/api/runtime-controls') || url.includes('/api/product-readiness')) {
      return json({ flags: {}, cashSendEnabled: false });
    }
    return json({ ok: true });
  });
}

export async function loginAsMerchant(page: Page) {
  await page.goto('/');
  const phone = page.locator('input[type="tel"]').first();
  await phone.fill('0821234567');
  await page.getByRole('button', { name: /continue/i }).click();
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  for (const digit of ['1', '2', '3', '4']) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /home/i }).first().waitFor({ timeout: 15_000 });
}

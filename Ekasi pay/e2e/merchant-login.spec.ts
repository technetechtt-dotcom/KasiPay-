import { test, expect } from '@playwright/test';

import { loginAsMerchant, seedMerchantSession } from './helpers/mockApi';

test.describe('Merchant login', () => {
  test('logs in with phone and PIN against a mocked API', async ({ page }) => {
    await seedMerchantSession(page);
    await loginAsMerchant(page);
    await expect(page.getByRole('button', { name: /shop/i }).first()).toBeVisible();
  });
});

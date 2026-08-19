import { test, expect } from '@playwright/test';

import { loginAsMerchant, seedMerchantSession } from './helpers/mockApi';

test.describe('Cash Send entry', () => {
  test('merchant can open Cash Send after switching to wallet mode', async ({ page }) => {
    await seedMerchantSession(page);
    await loginAsMerchant(page);
    await page.getByRole('button', { name: /more/i }).first().click();
    await page.getByRole('button', { name: /switch to wallet mode/i }).click();
    await expect(page.getByText('Cash Send').first()).toBeVisible();
    await page.getByText('Cash Send').first().click();
    await expect(page.getByText(/Cash Send/i).first()).toBeVisible();
  });
});

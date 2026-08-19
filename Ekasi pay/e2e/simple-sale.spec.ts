import { test, expect } from '@playwright/test';

import { loginAsMerchant, seedMerchantSession } from './helpers/mockApi';

test.describe('POS sale', () => {
  test('checks out a cash sale with a discount', async ({ page }) => {
    await seedMerchantSession(page);
    await loginAsMerchant(page);
    await page.getByRole('button', { name: /shop/i }).first().click();
    await page.getByRole('button', { name: /Bread R 12\.00/i }).first().click();
    await page.getByTestId('add-discount').click();
    await page.locator('input[type="number"]').fill('10');
    await page.getByTestId('shop-checkout').click();
    await page.getByTestId('complete-sale').click();
    await expect(page.getByRole('heading', { name: 'Sale Complete' })).toBeVisible();
    await expect(page.getByText(/Total:/i)).toBeVisible();
  });
});

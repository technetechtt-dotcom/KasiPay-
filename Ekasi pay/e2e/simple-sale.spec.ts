import { test, expect } from '@playwright/test';

import { loginAsMerchant, seedMerchantSession } from './helpers/mockApi';

test.describe('POS sale', () => {
  test('checks out a cash sale with a discount', async ({ page }) => {
    await seedMerchantSession(page);
    await loginAsMerchant(page);
    await page.getByRole('button', { name: /shop/i }).first().click();
    await expect(page.getByText('Bread')).toBeVisible();
    await page.getByText('Bread').first().click();
    await page.getByTestId('shop-checkout').click();
    await page.getByTestId('add-discount').click();
    await page.getByPlaceholder(/e.g. 10/i).fill('10');
    await page.getByTestId('complete-sale').click();
    await expect(page.getByText('Sale Complete')).toBeVisible();
    await expect(page.getByText(/Total:/i)).toBeVisible();
  });
});

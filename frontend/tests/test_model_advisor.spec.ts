import { test, expect } from '@playwright/test';

test('visit create-agent and check model advisor panel', async ({ page }) => {
  await page.goto('http://localhost:3000/create-agent');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('span', { hasText: /^Model Advisor$/ }).first()).toBeVisible();
});

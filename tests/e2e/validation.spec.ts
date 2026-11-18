import { expect, test } from '@playwright/test';

test('required login fields show themed inline messages and clear after correction', async ({ page }) => {
  await page.goto('/#/login');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const username = page.getByLabel('账号', { exact: true });
  const password = page.getByLabel('密码', { exact: true });
  await expect(username).toHaveAttribute('aria-invalid', 'true');
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.form-field').first()).toHaveAttribute('data-validation-message', '请填写账号');
  await username.fill('demo_buyer');
  await expect(username).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.form-field').first()).not.toHaveAttribute('data-validation-message');
});

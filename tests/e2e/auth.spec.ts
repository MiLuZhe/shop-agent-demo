import { submitLogin, openAccount, logoutFromMenu } from './login.ts';
import { expect, test as base, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import { DEFAULT_SHOP_ID } from '../../packages/contracts/src/common.ts';
const buyerPassword = 'AuthUi123!', sellerPassword = 'AuthUi123!';
const test = base.extend<{ accounts: { buyer: string; seller: string } }>({
  accounts: async ({}, use) => {
    const db = createDatabase(), prefix = `auth_ui_${randomUUID().slice(0,8)}`, ids = [randomUUID(), randomUUID()];
    const buyer = `${prefix}_buyer`, seller = `${prefix}_seller`;
    try {
      const password_hash = await hashPassword(buyerPassword);
      await db.user.createMany({ data: [{ id: ids[0]!, username: buyer, display_name: '测试买家', password_hash }, { id: ids[1]!, username: seller, display_name: '测试店长', password_hash }] });
      await db.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: ids[1]!, role: 'owner' } });
      await use({ buyer, seller });
    } finally {
      await db.shopMember.deleteMany({ where: { user_id: { in: ids } } }); await db.user.deleteMany({ where: { id: { in: ids } } }); await db.$disconnect();
    }
  },
});
async function login(page: Page, username: string, password: string) {
  await page.goto('/#/login');
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await submitLogin(page);
}

test('buyer can log in, reload, view own account and logout; seller APIs reject buyer', async ({ page, accounts }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, accounts.buyer, 'wrong-password');
  await expect(page.getByText('账号或密码错误，或账号不可用')).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill(buyerPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的账号', exact: true })).toBeVisible();
  await expect(page.locator('.account-card').getByText(accounts.buyer, { exact: true })).toBeVisible();
  await expect(page.locator('.store-nav').getByRole('link', { name: '卖家工作台' })).toHaveCount(0);
  expect((await page.context().cookies()).find((c) => c.name === 'shop_session')?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie.includes('shop_session'))).toBe(false);
  await page.reload();
  await expect(page.locator('.account-card').getByText(accounts.buyer, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath('buyer-account.png'), fullPage: true });
  await page.goto('/#/seller');
  await expect(page.getByRole('heading', { name: '此功能需要店铺授权' })).toBeVisible();
  const forbidden = await page.request.get('/api/seller/overview');
  expect(forbidden.status()).toBe(403);
  await logoutFromMenu(page);
  await expect(page.locator('.auth-actions').getByRole('link', { name: '登录', exact: true })).toBeVisible();
  expect((await page.request.get('/api/account')).status()).toBe(401);
  await page.goto('/#/account');
  await expect(page.getByRole('heading', { name: '请先登录', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('seller lands in protected workspace and can navigate account and shop', async ({ page, accounts }, testInfo) => {
  await login(page, accounts.seller, sellerPassword);
  await expect(page.getByRole('heading', { name: '卖家工作台', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '商店管理' })).toBeVisible();
  await expect(page.locator('.manage-inline-stats')).toContainText('全部商品');
  await expect(page.locator('.overview-card')).toHaveCount(0);
  const response = await page.request.get('/api/seller/overview');
  expect(response.status()).toBe(200);
  const overview = await response.json();
  expect(overview.productCount).toBeGreaterThan(0);
  await expect(page.locator('.manage-inline-stats span').filter({ hasText: '全部商品' }).locator('b')).toHaveText(String(overview.productCount));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath('seller-workspace.png'), fullPage: true });
  await openAccount(page);
  await expect(page.locator('.account-card').getByText(accounts.seller, { exact: true })).toBeVisible();
  await page.locator('.store-nav').getByRole('link', { name: '发现好物' }).click();
  const catalog = await page.request.get('/api/products?pageSize=12');
  expect(catalog.status()).toBe(200);
  await expect(page.locator('.product-card')).toHaveCount((await catalog.json()).items.length);
  await expect(page.getByRole('button', { name: '账号菜单', exact: true })).toBeVisible();
  await logoutFromMenu(page);
  await expect(page.locator('.auth-actions').getByRole('link', { name: '登录', exact: true })).toBeVisible();
});

test('guest protected page and failed login request have recoverable UI', async ({ page, accounts }, testInfo) => {
  await page.goto('/#/seller');
  await expect(page.getByRole('heading', { name: '请先登录', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '前往登录' }).click();
  await page.getByLabel('账号', { exact: true }).fill(accounts.buyer);
  await page.getByLabel('密码', { exact: true }).fill(buyerPassword);
  await page.route('**/api/auth/login', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '登录服务暂时不可用' } }) }));
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('登录服务暂时不可用', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true });
  await page.unroute('**/api/auth/login');
  await page.route('**/api/auth/login', (route) => route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }));
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('服务暂时无法响应，请稍后重试', { exact: true })).toBeVisible();
  await page.unroute('**/api/auth/login');
  await page.route('**/api/auth/login', (route) => route.abort());
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('网络连接失败，请检查服务是否运行后重试', { exact: true })).toBeVisible();
  await page.unroute('**/api/auth/login');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.account-card').getByText(accounts.buyer, { exact: true })).toBeVisible();
  await logoutFromMenu(page);
  await expect(page.locator('.auth-actions').getByRole('link', { name: '登录', exact: true })).toBeVisible();
});

test('expired server session clears account view and returns to login', async ({ page, accounts }) => {
  await login(page, accounts.buyer, buyerPassword);
  await expect(page.locator('.account-card').getByText(accounts.buyer, { exact: true })).toBeVisible();
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByRole('heading', { name: '请先登录', exact: true })).toBeVisible();
  await expect(page.locator('.account-card')).toHaveCount(0);
  await expect(page.locator('.auth-actions').getByRole('link', { name: '登录', exact: true })).toBeVisible();
});

import { DEFAULT_SHOP_ID } from '../../packages/contracts/src/common.ts';
import { submitLogin } from './login.ts';
import { randomUUID } from 'node:crypto';
import { expect, test as base, type Page } from '@playwright/test';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
const test = base.extend<{ fixture: { name: string; userId: string; skuIds: string[]; login: () => Promise<void> } }>({
  fixture: async ({ page }, use) => {
    const db = createDatabase(), name = `购物车_${randomUUID().slice(0, 8)}`, username = `cart_ui_${randomUUID().slice(0, 8)}`;
    const userId = randomUUID(), productId = randomUUID(), skuIds = [randomUUID(), randomUUID()];
    try {
      await db.user.create({ data: { id: userId, username, display_name: '购物车体验账号', password_hash: await hashPassword('CartUi123!') } });
      await db.product.create({ data: { shop_id: DEFAULT_SHOP_ID, id: productId, name, status: 'active', skus: { create: skuIds.map((id, i) => ({ id, sku_code: `${username}_${i}`, name: i ? '大号规格' : '小号规格', price: i ? '0.20' : '0.10', stock_quantity: 10 })) } } });
      await use({ name, userId, skuIds, login: async () => {
        await page.goto('/#/login');
        await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill('CartUi123!');
        await submitLogin(page);
        await expect(page.getByRole('heading', { name: '我的账号', exact: true })).toBeVisible();
      } });
    } finally {
      await db.cartItem.deleteMany({ where: { user_id: userId } });
      await db.sku.deleteMany({ where: { product_id: productId } });
      await db.product.deleteMany({ where: { id: productId } }); await db.user.deleteMany({ where: { id: userId } }); await db.$disconnect();
    }
  },
});
async function detail(page: Page, name: string) {
  await page.goto('/#catalog'); await page.getByRole('textbox', { name: '顶部商品搜索', exact: true }).fill(name); await page.locator('.header-search').getByRole('button', { name: '找商品', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(1); await page.locator('.product-card').click(); await expect(page.getByRole('region', { name: '商品详情', exact: true })).toBeVisible();
}
async function changeStock(id: string, data: { stock_quantity?: number; price?: string; is_active?: boolean }) {
  const db = createDatabase(); try { await db.sku.update({ where: { id }, data }); } finally { await db.$disconnect(); }
}
test('buyer adds and merges specifications, updates quantities, previews a partial selection and deletes entries', async ({ page, fixture }, info) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await fixture.login(); await detail(page, fixture.name);
  const small = page.getByRole('region', { name: '商品详情', exact: true });
  await small.getByLabel('小号规格购买数量').fill('2'); await small.getByRole('button', { name: '加入购物车', exact: true }).click();
  await expect(small.getByText('已加入购物车', { exact: false })).toBeVisible();
  await small.getByLabel('小号规格购买数量').fill('1'); await small.getByRole('button', { name: '加入购物车', exact: true }).click();
  await expect(small.getByRole('button', { name: '加入购物车', exact: true })).toBeEnabled();
  await page.getByRole('radio', { name: /大号规格/ }).click();
  const large = page.getByRole('region', { name: '商品详情', exact: true });
  await large.getByRole('button', { name: '加入购物车', exact: true }).click(); await expect(large.getByText('已加入购物车', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: '返回商店', exact: true }).click(); await page.locator('.store-nav').getByRole('link', { name: '购物车', exact: true }).click();
  await expect(page.locator('.cart-row')).toHaveCount(2); await expect(page.getByLabel('小号规格数量', { exact: true })).toHaveValue('3');
  const cartData = await (await page.request.get('/api/cart')).json();
  const visibleCart = (await page.locator('.cart-row').allTextContents()).join(' ');
  for (const item of cartData.items as { skuCode: string }[]) expect(visibleCart).not.toContain(item.skuCode);
  const row = page.locator('.cart-row').filter({ hasText: '小号规格' });
  await row.getByLabel('小号规格数量', { exact: true }).fill('4'); await row.getByRole('button', { name: '更新数量' }).click(); await expect(page.getByText('数量已更新', { exact: true })).toBeVisible();
  await page.getByLabel('勾选小号规格', { exact: true }).check(); await expect(page.getByLabel('已选合计', { exact: true })).toHaveText('¥0.40');
  await page.getByRole('button', { name: '查看结算清单' }).click();
  const preview = page.getByRole('region', { name: '结算清单', exact: true });
  await expect(preview).toContainText('小号规格 × 4'); await expect(preview).not.toContainText('大号规格');
  await expect(preview.getByRole('button', { name: '填写收货信息并提交订单', exact: true })).toBeVisible();
  const orders = await page.request.get('/api/orders'); expect(orders.status()).toBe(200); expect((await orders.json()).items).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath('cart-preview.png'), fullPage: true });
  await page.reload(); await expect(page.locator('.cart-row')).toHaveCount(2); await expect(page.getByLabel('勾选小号规格', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('小号规格数量', { exact: true })).toHaveValue('4');
  await page.getByLabel('全选可售条目').check(); await expect(page.getByLabel('已选合计', { exact: true })).toHaveText('¥0.60');
  await row.getByRole('button', { name: '删除', exact: true }).click(); await expect(page.locator('.cart-row')).toHaveCount(1);
  await page.locator('.cart-row').getByRole('button', { name: '删除', exact: true }).click(); await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible(); expect(errors).toEqual([]);
});
test('cart refresh exposes live price and stock, invalid rows cannot be selected and can still be removed', async ({ page, fixture }, info) => {
  await fixture.login(); expect((await page.request.post('/api/cart/items', { data: { skuId: fixture.skuIds[0], quantity: 5 } })).status()).toBe(201);
  await page.goto('/#/cart'); await expect(page.locator('.cart-row')).toHaveCount(1); await page.getByLabel('全选可售条目').check();
  await changeStock(fixture.skuIds[0]!, { price: '1.23', stock_quantity: 2 });
  await page.getByRole('button', { name: '查看结算清单' }).click(); await expect(page.getByRole('alert')).toContainText('库存不足');
  await page.getByRole('button', { name: '刷新购物车', exact: true }).first().click();
  await expect(page.locator('.cart-row')).toContainText('当前单价 ¥1.23'); await expect(page.getByLabel('勾选小号规格', { exact: true })).toBeDisabled();
  await page.getByLabel('小号规格数量', { exact: true }).fill('2'); await page.getByRole('button', { name: '更新数量' }).click(); await expect(page.getByText('数量已更新', { exact: true })).toBeVisible();
  await expect(page.getByLabel('勾选小号规格', { exact: true })).toBeEnabled();
  await changeStock(fixture.skuIds[0]!, { is_active: false }); await page.getByRole('button', { name: '刷新购物车', exact: true }).click();
  await expect(page.locator('.cart-row')).toContainText('规格已停用'); await expect(page.getByLabel('勾选小号规格', { exact: true })).toBeDisabled();
  await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath('cart-invalid.png'), fullPage: true });
  await page.getByRole('button', { name: '删除', exact: true }).click(); await expect(page.getByRole('heading', { name: '购物车还是空的' })).toBeVisible();
});
test('guest login prompt, loading retry and stale quantity conflict recover without losing cart data', async ({ page, fixture }) => {
  await page.goto('/#/cart'); await expect(page.getByRole('link', { name: '前往登录' })).toBeVisible();
  await detail(page, fixture.name); await expect(page.getByRole('region', { name: '商品详情', exact: true }).getByRole('link', { name: '登录后加入购物车' })).toHaveCount(1);
  await page.getByRole('link', { name: '返回商店', exact: true }).click(); await fixture.login();
  expect((await page.request.post('/api/cart/items', { data: { skuId: fixture.skuIds[0], quantity: 1 } })).status()).toBe(201);
  await page.route('**/api/cart', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '购物车读取失败' } }) }));
  await page.goto('/#/cart'); await expect(page.getByRole('alert')).toContainText('购物车读取失败'); await page.unroute('**/api/cart'); await page.getByRole('button', { name: '刷新购物车' }).click(); await expect(page.locator('.cart-row')).toHaveCount(1);
  const db = createDatabase(); try { await db.cartItem.updateMany({ where: { user_id: fixture.userId }, data: { quantity: 3, updated_at: new Date(Date.now() + 1000) } }); } finally { await db.$disconnect(); }
  await page.getByLabel('小号规格数量', { exact: true }).fill('2'); await page.getByRole('button', { name: '更新数量' }).click(); await expect(page.getByRole('alert')).toContainText('购物车已被修改');
  await page.getByRole('button', { name: '刷新购物车', exact: true }).first().click(); await expect(page.getByLabel('小号规格数量', { exact: true })).toHaveValue('3');
});

import { DEFAULT_SHOP_ID } from '../../packages/contracts/src/common.ts';
import { submitLogin } from './login.ts';
import { randomUUID } from 'node:crypto';
import { expect, test as base, type Page } from '@playwright/test';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import type { CartItemDto, OrderDetailDto } from '../../packages/contracts/src/index.ts';
const test = base.extend<{ fixture: { name: string; userId: string; sellerId: string; skuIds: string[]; productId: string; login: (seller?: boolean) => Promise<void> } }>({
  fixture: async ({ page }, use) => {
    const db = createDatabase(), prefix = `order_ui_${randomUUID().slice(0, 8)}`, name = `订单验收_${randomUUID().slice(0, 8)}`, userId = randomUUID(), sellerId = randomUUID(), productId = randomUUID(), skuIds = [randomUUID(), randomUUID()];
    try {
      const password_hash = await hashPassword('OrderUi123!');
      await db.user.createMany({ data: [{ id: userId, username: `${prefix}_buyer`, display_name: '订单测试买家', password_hash }, { id: sellerId, username: `${prefix}_seller`, display_name: '订单测试卖家', password_hash }] });
      await db.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: sellerId } });
      await db.product.create({ data: { shop_id: DEFAULT_SHOP_ID, id: productId, name, status: 'active', skus: { create: skuIds.map((id, i) => ({ id, sku_code: `${prefix}_${i}`, name: i ? '大号' : '小号', price: i ? '25.00' : '12.30', stock_quantity: 10 })) } } });
      await use({ name, userId, sellerId, skuIds, productId, login: async (seller = false) => {
        await page.goto('/#/login'); await page.getByLabel('账号', { exact: true }).fill(`${prefix}_${seller ? 'seller' : 'buyer'}`); await page.getByLabel('密码', { exact: true }).fill('OrderUi123!'); await submitLogin(page);
        await expect(page.getByRole('heading', { name: seller ? '卖家工作台' : '我的账号', exact: true })).toBeVisible();
      } });
    } finally {
      const rows = await db.order.findMany({ where: { buyer_id: userId }, select: { id: true } });
      await db.orderItem.deleteMany({ where: { order_id: { in: rows.map((row) => row.id) } } }); await db.order.deleteMany({ where: { buyer_id: userId } });
      await db.cartItem.deleteMany({ where: { user_id: userId } }); await db.sku.deleteMany({ where: { product_id: productId } }); await db.product.deleteMany({ where: { id: productId } }); await db.shopMember.deleteMany({ where: { user_id: { in: [userId, sellerId] } } }); await db.user.deleteMany({ where: { id: { in: [userId, sellerId] } } }); await db.$disconnect();
    }
  },
});
async function add(page: Page, skuId: string, quantity = 1): Promise<CartItemDto> { const r = await page.request.post('/api/cart/items', { data: { skuId, quantity } }); expect(r.status()).toBe(201); return r.json() as Promise<CartItemDto>; }
async function preview(page: Page) {
  await page.goto('/#/cart'); await expect(page.locator('.cart-row')).not.toHaveCount(0); await page.getByLabel('勾选小号', { exact: true }).check(); await page.getByRole('button', { name: '查看结算清单' }).click(); await page.getByRole('button', { name: '填写收货信息并提交订单', exact: true }).click(); await expect(page.getByRole('form', { name: '提交订单', exact: true })).toBeVisible();
}
async function recipient(page: Page) {
  const form = page.getByRole('form', { name: '提交订单', exact: true }); await form.getByLabel('收货人', { exact: true }).fill('测试买家'); await form.getByLabel('联系电话', { exact: true }).fill('13800000000'); await form.getByLabel('完整收货地址', { exact: true }).fill('测试省测试市测试街道 1 号'); await form.getByLabel('买家备注（可选）', { exact: true }).fill('请先联系');
}
async function confirm(page: Page, name: string) { await page.getByRole('button', { name, exact: true }).click(); await page.locator('dialog[open].order-confirm-dialog').getByRole('button', { name: '确认操作', exact: true }).click(); }
test('buyer submits a partial cart, pays and seller ships; both can read immutable snapshots', async ({ page, fixture }, info) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await fixture.login(); await add(page, fixture.skuIds[0]!, 2); await add(page, fixture.skuIds[1]!); await preview(page); await recipient(page);
  await page.getByRole('button', { name: '确认并提交订单', exact: true }).click(); await expect(page.getByRole('region', { name: '订单详情', exact: true }).getByRole('heading', { name: '待支付', exact: true })).toBeVisible();
  const id = page.url().split('/').at(-1)!; const own = await page.request.get(`/api/orders/${id}`); expect(own.status()).toBe(200); const ownData = await own.json() as OrderDetailDto; expect(ownData.totalAmount).toBe('24.60');
  await expect(page.locator('.order-lines')).not.toContainText(ownData.items[0]!.skuCode);
  const cart = await page.request.get('/api/cart'); expect((await cart.json()).items).toHaveLength(1);
  await expect(page.locator('.order-recipient')).toContainText('收货人'); await expect(page.locator('.order-recipient')).toContainText('13800000000'); await confirm(page, '模拟支付'); await expect(page.getByRole('heading', { name: '待发货', exact: true })).toBeVisible();
  const db = createDatabase(); try { await db.product.update({ where: { id: fixture.productId }, data: { name: `${fixture.name}_新名称` } }); await db.sku.update({ where: { id: fixture.skuIds[0] }, data: { price: '99.00' } }); } finally { await db.$disconnect(); }
  await page.getByRole('button', { name: '刷新订单' }).click(); await expect(page.locator('.order-lines')).toContainText(fixture.name); await expect(page.locator('.order-lines')).toContainText('成交单价 ¥12.30 × 2');
  await page.locator('.store-nav').getByRole('link', { name: '我的订单', exact: true }).click(); await expect(page.locator('.order-list article')).toHaveCount(1); await page.getByRole('link', { name: '查看订单' }).click(); await expect(page.getByRole('heading', { name: '待发货', exact: true })).toBeVisible();
  await fixture.login(true); await page.locator('.store-nav').getByRole('link', { name: '订单管理', exact: true }).click(); await page.getByLabel('订单状态', { exact: true }).selectOption('pending_shipment');
  await page.goto(`/#/seller/orders/${id}`); await expect(page.locator('.order-recipient')).toContainText('测试省测试市'); await expect(page.locator('.order-lines')).toContainText(`商家货号：${ownData.items[0]!.skuCode}`); await confirm(page, '标记已发货'); await expect(page.getByRole('heading', { name: '已发货', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath('seller-shipped.png'), fullPage: true });
  await page.route(`**/api/seller/orders/${id}`, async (route) => {
    const response = await route.fetch(); const detail = await response.json() as OrderDetailDto;
    await route.fulfill({ response, json: { ...detail, items: detail.items.map((item) => ({ ...item, skuCode: `sku_${'a'.repeat(32)}` })) } });
  });
  await page.getByRole('button', { name: '刷新订单' }).click(); await expect(page.locator('.order-lines')).not.toContainText('商家货号：');
  await page.unroute(`**/api/seller/orders/${id}`);
  await fixture.login(); await page.goto(`/#/orders/${id}`); await expect(page.getByRole('heading', { name: '已发货', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '取消订单', exact: true })).toHaveCount(0); expect(errors).toEqual([]);
});
test('buyer cancels a pending order and inventory is restored; list filtering and errors recover', async ({ page, fixture }, info) => {
  await fixture.login(); await add(page, fixture.skuIds[0]!, 3); await preview(page); await recipient(page); await page.getByRole('button', { name: '确认并提交订单', exact: true }).click(); await expect(page.getByRole('heading', { name: '待支付', exact: true })).toBeVisible();
  await confirm(page, '取消订单'); await expect(page.getByRole('heading', { name: '已取消', exact: true })).toBeVisible(); await expect(page.getByText(/库存已恢复/)).toBeVisible();
  const db = createDatabase(); try { expect((await db.sku.findUniqueOrThrow({ where: { id: fixture.skuIds[0] } })).stock_quantity).toBe(10); } finally { await db.$disconnect(); }
  await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath('buyer-cancelled.png'), fullPage: true });
  await page.goto('/#/orders'); await page.getByLabel('订单状态', { exact: true }).selectOption('pending_payment'); await expect(page.getByRole('heading', { name: '暂无符合条件的订单' })).toBeVisible();
  await page.route('**/api/orders?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '订单读取失败' } }) })); await page.getByRole('button', { name: '重新加载订单' }).click(); await expect(page.getByRole('alert')).toContainText('订单读取失败'); await page.unroute('**/api/orders?*');
  await page.getByLabel('订单状态', { exact: true }).selectOption('cancelled'); await expect(page.locator('.order-list article')).toHaveCount(1);
});
test('checkout validates recipient and refuses changed prices until buyer previews again', async ({ page, fixture }) => {
  await fixture.login(); await add(page, fixture.skuIds[0]!); await preview(page);
  await page.getByRole('button', { name: '确认并提交订单', exact: true }).click(); await expect(page).toHaveURL(/#\/cart$/);
  await expect(page.getByLabel('收货人', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await recipient(page); await page.getByLabel('联系电话', { exact: true }).fill('abcdefghi'); await page.getByRole('button', { name: '确认并提交订单', exact: true }).click(); await expect(page.getByLabel('联系电话', { exact: true })).toHaveAttribute('aria-invalid', 'true'); await expect(page.locator('.checkout-form .form-field').filter({ hasText: '联系电话' })).toHaveAttribute('data-validation-message', /有效联系电话/);
  await page.getByLabel('联系电话', { exact: true }).fill('13800000000');
  const db = createDatabase(); try { await db.sku.update({ where: { id: fixture.skuIds[0] }, data: { price: '15.50' } }); } finally { await db.$disconnect(); }
  await page.getByRole('button', { name: '确认并提交订单', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('价格已变化');
  await page.getByRole('button', { name: '返回修改商品', exact: true }).click(); await page.getByRole('button', { name: '查看结算清单' }).click(); await expect(page.getByRole('region', { name: '结算清单' })).toContainText('¥15.50'); await page.getByRole('button', { name: '填写收货信息并提交订单', exact: true }).click(); await page.getByRole('button', { name: '确认并提交订单', exact: true }).click(); await expect(page.getByRole('heading', { name: '待支付', exact: true })).toBeVisible(); await expect(page.locator('.order-total')).toContainText('¥15.50');
});
test('a lost checkout response retries the same request and yields one order', async ({ page, fixture }) => {
  await fixture.login(); await add(page, fixture.skuIds[0]!); await preview(page); await recipient(page);
  let lost = false; const keys: string[] = [];
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    keys.push((route.request().postDataJSON() as { checkoutKey: string }).checkoutKey);
    if (!lost) { lost = true; const committed = await route.fetch(); expect(committed.status()).toBe(201); await route.abort(); }
    else await route.continue();
  });
  await page.getByRole('button', { name: '确认并提交订单', exact: true }).click(); await expect(page.getByRole('button', { name: '重试原订单提交', exact: true })).toBeVisible(); await expect(page.getByLabel('收货人', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重试原订单提交', exact: true }).click(); await expect(page.getByRole('heading', { name: '待支付', exact: true })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  const db = createDatabase(); try { expect(await db.order.count({ where: { buyer_id: fixture.userId } })).toBe(1); expect((await db.sku.findUniqueOrThrow({ where: { id: fixture.skuIds[0] } })).stock_quantity).toBe(9); } finally { await db.$disconnect(); }
});

test('account address forms and checkout dialog save, reuse and edit addresses without changing order snapshots', async ({ page, fixture }, info) => {
  await fixture.login();
  const book = page.getByRole('region', { name: '常用地址', exact: true });
  await book.getByRole('button', { name: '新增地址', exact: true }).click();
  let editor = page.getByRole('dialog', { name: '新增常用地址', exact: true });
  await editor.getByRole('button', { name: '保存地址', exact: true }).click();
  await expect(editor.getByLabel('收货人', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await editor.getByLabel('收货人', { exact: true }).fill('常用收件人');
  await editor.getByLabel('联系电话', { exact: true }).fill('13800000000');
  await editor.getByLabel('完整收货地址', { exact: true }).fill('常用省常用市常用街道 10 号');
  await editor.getByRole('button', { name: '保存地址', exact: true }).click();
  await expect(editor).toHaveCount(0); await expect(book.locator('.address-card')).toHaveCount(1);
  await add(page, fixture.skuIds[0]!); await preview(page);
  const checkout = page.getByRole('dialog', { name: '确认订单与收货信息', exact: true });
  await expect(checkout).toBeVisible();
  await page.keyboard.press('Escape'); await expect(checkout).toHaveCount(0);
  await page.getByRole('button', { name: '填写收货信息并提交订单', exact: true }).click();
  await checkout.getByRole('button', { name: '编辑地址', exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑常用地址', exact: true });
  await editor.getByLabel('收货人', { exact: true }).fill('修改后的常用收件人');
  await editor.getByRole('button', { name: '保存地址', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await checkout.getByRole('button', { name: '使用此地址', exact: true }).click();
  const form = checkout.getByRole('form', { name: '提交订单', exact: true });
  await expect(form.getByLabel('收货人', { exact: true })).toHaveValue('修改后的常用收件人');
  await form.getByLabel('完整收货地址', { exact: true }).fill('新填省新填市新填街道 20 号');
  await form.getByRole('button', { name: '保存本次地址为常用地址', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('已保存到常用地址');
  await expect(checkout.locator('.address-card')).toHaveCount(2);
  await expect(form.getByRole('button', { name: '已保存为常用地址', exact: true })).toBeDisabled();
  await expect(checkout.getByText('最多保存三个地址，下单时可快速填写。修改地址不影响已有订单。')).toHaveCount(0);
  await form.getByLabel('收货人', { exact: true }).fill('第三个收件人');
  await form.getByLabel('完整收货地址', { exact: true }).fill('第三省第三市第三街道 30 号');
  await form.getByRole('button', { name: '保存本次地址为常用地址', exact: true }).click();
  await expect(checkout.locator('.address-card')).toHaveCount(3);
  await form.getByLabel('完整收货地址', { exact: true }).fill('第四省第四市第四街道 40 号');
  await expect(form.getByRole('button', { name: '常用地址已满（3/3）', exact: true })).toBeDisabled();
  await expect(form.getByRole('button', { name: '确认并提交订单', exact: true })).toBeEnabled();
  await checkout.getByRole('button', { name: '删除地址', exact: true }).last().click();
  await page.getByRole('dialog', { name: '删除常用地址', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(checkout.locator('.address-card')).toHaveCount(2);
  await expect(form.getByRole('button', { name: '保存本次地址为常用地址', exact: true })).toBeEnabled();
  await form.getByLabel('收货人', { exact: true }).fill('修改后的常用收件人');
  await form.getByLabel('完整收货地址', { exact: true }).fill('新填省新填市新填街道 20 号');
  await expect(form.getByRole('button', { name: '已保存为常用地址', exact: true })).toBeDisabled();
  expect(await checkout.evaluate((el) => el.getBoundingClientRect().width <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('checkout-address-dialog.png') });
  await form.getByRole('button', { name: '确认并提交订单', exact: true }).click();
  await expect(page.getByRole('heading', { name: '待支付', exact: true })).toBeVisible();
  const orderUrl = page.url();
  await expect(page.locator('.order-recipient dt')).toHaveText(['收货人', '联系电话', '收货地址']);
  await page.goto('/#/account');
  await expect(book.locator('.address-card')).toHaveCount(2);
  await book.getByRole('button', { name: '删除地址', exact: true }).last().click();
  await page.getByRole('dialog', { name: '删除常用地址', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(book.locator('.address-card')).toHaveCount(1);
  await page.goto(orderUrl); await expect(page.locator('.order-recipient')).toContainText('新填省新填市新填街道 20 号');
});

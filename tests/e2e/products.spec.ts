import { randomUUID } from 'node:crypto';
import { expect, test as base, type Page } from '@playwright/test';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import { DEFAULT_SHOP_ID, type ProductDto } from '../../packages/contracts/src/index.ts';
import { submitLogin } from './login.ts';

const test = base.extend<{ product: { id: string; userId: string; skuIds: string[]; login: () => Promise<void> } }>({
  product: async ({ page }, use) => {
    const db = createDatabase(), id = randomUUID(), userId = randomUUID(), skuIds = [randomUUID(), randomUUID(), randomUUID()], username = `product_ui_${randomUUID().slice(0, 8)}`;
    // Gallery layout tests own their image fixtures. Production demo media is
    // private TOS now, so tests must not depend on removed local photo files.
    const pictures = await page.evaluate(() => [[640, 480], [800, 400], [480, 640]].map(([width, height]) => {
      const canvas = document.createElement('canvas'); canvas.width = width!; canvas.height = height!;
      const context = canvas.getContext('2d')!; context.fillStyle = '#e6e9ee'; context.fillRect(0, 0, width!, height!);
      context.fillStyle = '#86a4c4'; context.fillRect(width! / 4, height! / 4, width! / 2, height! / 2);
      return canvas.toDataURL('image/jpeg').split(',')[1]!;
    }));
    await page.route('**/demo-media/pexels-*.jpg', route => {
      const index = [7265965, 13211073, 8250832].findIndex(value => route.request().url().endsWith(`pexels-${value}.jpg`));
      return index < 0 ? route.continue() : route.fulfill({ contentType: 'image/jpeg', body: Buffer.from(pictures[index]!, 'base64') });
    });
    try {
      await db.user.create({ data: { id: userId, username, display_name: '商品页测试', password_hash: await hashPassword('ProductUi123!') } });
      await db.product.create({ data: { id, shop_id: DEFAULT_SHOP_ID, name: username, status: 'active', description: '商品详情与轮播演示', image_urls: [7265965,13211073,8250832].map((value) => `/demo-media/pexels-${value}.jpg`), skus: { create: skuIds.map((skuId, index) => ({ id: skuId, name: ['标准版','缺货版','旅行版'][index]!, sku_code: `${username}_${index}`, price: ['0.10','0.20','0.30'][index]!, stock_quantity: index === 1 ? 0 : 10 })) } } });
      await use({ id, userId, skuIds, login: async () => {
        await page.goto('/#/login'); await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill('ProductUi123!'); await submitLogin(page);
        await expect(page.getByRole('heading', { name: '我的账号', exact: true })).toBeVisible();
      } });
    } finally {
      await db.orderItem.deleteMany({ where: { order: { buyer_id: userId } } }); await db.order.deleteMany({ where: { buyer_id: userId } }); await db.cartItem.deleteMany({ where: { user_id: userId } });
      await db.sku.deleteMany({ where: { product_id: id } }); await db.product.deleteMany({ where: { id } }); await db.user.deleteMany({ where: { id: userId } }); await db.$disconnect();
    }
  },
});
const details = (page: Page) => page.getByRole('region', { name: '商品详情', exact: true });

test('recommended SKU links select the exact public SKU and safely recover from invalid or unavailable choices', async ({ page, product }) => {
  await page.goto(`/#/products/${product.id}?sku=${product.skuIds[2]}`);
  await expect(page.getByRole('radio', { name: '旅行版 ¥0.30', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(page.getByRole('radio', { name: '旅行版 ¥0.30', exact: true })).toHaveAttribute('aria-checked', 'true');
  await product.login();
  await page.goto(`/#/products/${product.id}?sku=${product.skuIds[1]}`);
  await expect(page.getByRole('radio', { name: '缺货版 ¥0.20 · 暂时缺货', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: '加入购物车', exact: true })).toBeDisabled();
  for (const invalid of ['not-a-sku', randomUUID()]) {
    await page.goto(`/#/products/${product.id}?sku=${invalid}`);
    await expect(page.getByRole('radio', { name: '标准版 ¥0.10', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: '加入购物车', exact: true })).toBeEnabled();
  }
});

test('product URL reloads; mixed-shape pictures share a stable stage and only change manually', async ({ page, product }, info) => {
  await page.clock.install();
  await page.goto(`/#/products/${product.id}`);
  await expect(details(page)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const counter = page.getByLabel('图片序号');
  await expect(counter).toHaveText('1 / 3');
  await expect.poll(() => page.locator('.gallery-stage>img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.clock.runFor(16000); await expect(counter).toHaveText('1 / 3');
  const image = page.locator('.gallery-stage>img');
  const layout = async () => image.evaluate((element) => {
    const photo = element as HTMLImageElement, stage = photo.parentElement!.getBoundingClientRect(), thumbs = document.querySelector('.gallery-thumbnails')!.getBoundingClientRect();
    return { stageX: stage.x, stageY: stage.y + scrollY, stageWidth: stage.width, stageHeight: stage.height, thumbsY: thumbs.y + scrollY, naturalRatio: photo.naturalWidth / photo.naturalHeight, fit: getComputedStyle(photo).objectFit };
  });
  const first = await layout();
  expect(first.fit).toBe('contain');
  expect(first.thumbsY).toBeGreaterThanOrEqual(first.stageY + first.stageHeight);
  await page.getByRole('button', { name: '查看第 3 张图片' }).click();
  await expect(counter).toHaveText('3 / 3');
  const third = await layout();
  expect(third.naturalRatio).not.toBe(first.naturalRatio);
  for (const field of ['stageX', 'stageY', 'stageWidth', 'stageHeight', 'thumbsY'] as const) expect(Math.abs(third[field] - first[field])).toBeLessThan(2);
  await page.clock.runFor(16000); await expect(counter).toHaveText('3 / 3');
  await page.getByRole('button', { name: '下一张图片' }).click(); await expect(counter).toHaveText('1 / 3');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('product-page.png'), fullPage: true });
  await page.reload(); await expect(details(page)).toBeVisible(); await expect(counter).toHaveText('1 / 3');
});

test('desktop detail fits the viewport while a long specification list stays usable', async ({ page, product }, info) => {
  test.skip(info.project.name === 'mobile');
  await page.setViewportSize({ width: 1280, height: 720 });
  await product.login();
  const original = await (await page.request.get(`/api/products/${product.id}`)).json() as ProductDto;
  const extra = Array.from({ length: 17 }, (_, index) => ({ ...original.skus[0]!, id: randomUUID(), name: `扩展规格 ${index + 1} · 详细版本`, skuCode: `extra_${index}` }));
  extra[16]!.attributeCount = 20;
  extra[16]!.attributes = Array.from({ length: 20 }, (_, index) => ({ id: randomUUID(), code: `detail_${index}`, name: `参数 ${index + 1}`, dataType: 'text' as const, unit: null, options: null, value: `参数值 ${index + 1}` }));
  await page.route(`**/api/products/${product.id}`, (route) => route.fulfill({ json: { ...original, skus: [...original.skus, ...extra], skuCount: 20 } }));
  await page.goto(`/#/products/${product.id}`);
  await expect(details(page)).toBeVisible();
  const measure = () => page.evaluate(() => ({ pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, stageWidth: document.querySelector('.gallery-stage')!.getBoundingClientRect().width }));
  const initial = await measure();
  expect(initial.pageHeight).toBeLessThanOrEqual(initial.viewportHeight + 1);
  expect(initial.stageWidth).toBeGreaterThan(600);
  await expect(page.getByRole('button', { name: '立即购买', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /扩展规格 17/ }).click();
  expect((await measure()).pageHeight).toBeLessThanOrEqual(721);
  await page.getByText('规格参数', { exact: false }).click();
  await expect(page.getByText('参数 1', { exact: true })).toBeVisible();
  await expect(page.getByText('规格编码', { exact: true })).toHaveCount(0);
  expect((await measure()).pageHeight).toBeLessThanOrEqual(721);
  expect(await page.locator('.product-purchase').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.screenshot({ path: info.outputPath('compact-desktop.png'), fullPage: true });
});

test('gallery handles no pictures, one picture, eight-picture limit and a broken image', async ({ page, product }) => {
  const data = await (await page.request.get(`/api/products/${product.id}`)).json() as ProductDto;
  let images: string[] = [];
  await page.route(`**/api/products/${product.id}`, (route) => route.fulfill({ json: { ...data, imageUrls: images } }));
  await page.goto(`/#/products/${product.id}`); await expect(page.getByText('商家暂未提供实拍图', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下一张图片' })).toHaveCount(0);
  images = [data.imageUrls[0]!]; await page.reload(); await expect(page.getByLabel('图片序号')).toHaveText('1 / 1');
  await expect(page.getByRole('button', { name: '下一张图片' })).toHaveCount(0);
  images = Array.from({ length: 9 }, () => data.imageUrls[0]!); await page.reload();
  await expect(page.locator('.gallery-thumbnails button')).toHaveCount(8); await expect(page.getByLabel('图片序号')).toHaveText('1 / 8');
  images = ['/demo-media/missing.jpg', data.imageUrls[0]!]; await page.reload();
  await expect(page.getByText('图片加载失败，可切换其他图片', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一张图片' }).click(); await expect(page.getByLabel('图片序号')).toHaveText('2 / 2');
  await expect.poll(() => page.locator('.gallery-stage>img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test('buy now creates only the selected quantity, leaves cart unchanged and retries a lost response once', async ({ page, product }, info) => {
  await product.login();
  for (const [skuId, quantity] of [[product.skuIds[0]!, 1], [product.skuIds[2]!, 3]] as const) expect((await page.request.post('/api/cart/items', { data: { skuId, quantity } })).status()).toBe(201);
  const before = await (await page.request.get('/api/cart')).json();
  await page.goto(`/#/products/${product.id}`);
  await page.getByRole('radio', { name: /旅行版/ }).click();
  await page.getByRole('button', { name: '增加购买数量' }).click();
  await expect(page.getByLabel('旅行版购买数量', { exact: true })).toHaveValue('2');
  await page.screenshot({ path: info.outputPath('purchase-actions.png'), fullPage: true });
  await page.getByRole('button', { name: '立即购买', exact: true }).click();
  await expect(page).toHaveURL(/#\/checkout\//);
  const preview = page.getByRole('region', { name: '立即结账清单', exact: true }); await expect(preview).toContainText('旅行版 × 2'); await expect(preview).toContainText('¥0.60');
  let first = true;
  await page.route('**/api/orders/direct', async (route) => { if (first) { first = false; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await page.getByRole('button', { name: '填写收货信息并提交订单', exact: true }).click();
  await page.getByLabel('收货人', { exact: true }).fill('直接购买测试'); await page.getByLabel('联系电话', { exact: true }).fill('13800000000'); await page.getByLabel('完整收货地址', { exact: true }).fill('测试省测试市测试街道 100 号');
  await page.getByRole('button', { name: '确认并提交订单', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试原订单提交', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试原订单提交', exact: true }).click();
  await expect(page.getByRole('heading', { name: '待支付', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '订单详情' })).toContainText('成交单价 ¥0.30 × 2');
  const after = await (await page.request.get('/api/cart')).json();
  const cartRows = (cart: typeof before) => cart.items.map((item: { id: string; skuId: string; quantity: number; version: string }) => ({ id: item.id, skuId: item.skuId, quantity: item.quantity, version: item.version }));
  expect(cartRows(after)).toEqual(cartRows(before));
  expect(after.items.find((item: { skuId: string }) => item.skuId === product.skuIds[2]).stockQuantity).toBe(8);
  const db = createDatabase(); try { expect(await db.order.count({ where: { buyer_id: product.userId } })).toBe(1); expect((await db.sku.findUniqueOrThrow({ where: { id: product.skuIds[2] } })).stock_quantity).toBe(8); } finally { await db.$disconnect(); }
});

test('guest, out-of-stock and missing product states are recoverable', async ({ page, product }) => {
  await page.goto(`/#/products/${product.id}`);
  await expect(page.getByRole('link', { name: '登录后立即购买', exact: true })).toBeVisible();
  await product.login(); await page.goto(`/#/products/${product.id}`);
  await page.getByRole('radio', { name: /缺货版/ }).click();
  await expect(page.getByRole('button', { name: '加入购物车', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: '立即购买', exact: true })).toBeDisabled();
  await page.goto(`/#/checkout/${product.id}?sku=${product.skuIds[0]}&quantity=999`);
  await expect(page.getByRole('alert')).toContainText('数量不符合当前库存');
  await page.goto(`/#/products/${randomUUID()}`); await expect(page.getByRole('alert')).toContainText('商品不存在或未上架');
});

test('direct checkout rejects a stale price and reprices without losing recipient input', async ({ page, product }) => {
  await product.login(); await page.goto(`/#/checkout/${product.id}?sku=${product.skuIds[0]}&quantity=2`);
  await expect(page.getByRole('region', { name: '立即结账清单', exact: true })).toContainText('¥0.20');
  await page.getByRole('button', { name: '填写收货信息并提交订单', exact: true }).click();
  await page.getByLabel('收货人', { exact: true }).fill('保留资料'); await page.getByLabel('联系电话', { exact: true }).fill('13800000000'); await page.getByLabel('完整收货地址', { exact: true }).fill('测试省测试市测试路 200 号');
  const db = createDatabase(); try { await db.sku.update({ where: { id: product.skuIds[0] }, data: { price: '0.50' } }); } finally { await db.$disconnect(); }
  await page.getByRole('button', { name: '确认并提交订单', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('价格已变化');
  await page.getByRole('button', { name: '返回修改商品', exact: true }).click(); await page.getByRole('button', { name: '重新核价', exact: true }).click();
  await expect(page.getByRole('region', { name: '立即结账清单', exact: true })).toContainText('¥1.00');
  await page.getByRole('button', { name: '填写收货信息并提交订单', exact: true }).click();
  await expect(page.getByRole('form', { name: '提交订单' }).getByRole('textbox', { name: '收货人' })).toHaveValue('保留资料');
  await expect(page.getByRole('form', { name: '提交订单' }).getByRole('textbox', { name: '完整收货地址' })).toHaveValue('测试省测试市测试路 200 号');
  const check = createDatabase(); try { expect(await check.order.count({ where: { buyer_id: product.userId } })).toBe(0); } finally { await check.$disconnect(); }
});

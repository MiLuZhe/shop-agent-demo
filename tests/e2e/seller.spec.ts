import { submitLogin } from './login.ts';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { expect, test as base, type Page, type APIRequestContext } from '@playwright/test';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import { DEFAULT_SHOP_ID } from '../../packages/contracts/src/common.ts';
import { createImageStore } from '../../apps/shop-api/src/catalog/image-store.ts';
import type { SellerProductDetailDto, SellerTagDto, SellerCategoryDto, SellerDefinitionDto } from '../../packages/contracts/src/index.ts';

const test = base.extend<{ scope: string }>({
  scope: async ({}, use) => {
    const prefix = `e2e_${randomUUID().slice(0, 8)}`, db = createDatabase(), userId = randomUUID();
    try {
      await db.user.create({ data: { id: userId, username: prefix, display_name: '管理界面测试店长', password_hash: await hashPassword('SellerUi123!') } });
      await db.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: userId, role: 'owner' } });
      await use(prefix);
    }
    finally {
      try {
        const rows = await db.product.findMany({ where: { name: { startsWith: prefix } }, select: { id: true, image_urls: true } });
        const ids = rows.map((p) => p.id);
        await db.skuAttributeValue.deleteMany({ where: { sku: { product_id: { in: ids } } } });
        await db.sku.deleteMany({ where: { product_id: { in: ids } } });
        await db.product.deleteMany({ where: { id: { in: ids } } });
        for (const row of rows) for (const url of Array.isArray(row.image_urls) ? row.image_urls : []) {
          if (typeof url === 'string' && /^\/api\/uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(url)) {
            if (process.env.SHOP_IMAGE_STORAGE === 'tos') {
              const [, , , shopId, filename] = url.split('/');
              await createImageStore().remove(shopId!, filename!);
            } else {
              await unlink(path.resolve(process.env.SHOP_UPLOAD_DIR ?? 'apps/shop-api/data/uploads', url.replace('/api/uploads/', ''))).catch(() => {});
            }
          }
        }
        await db.category.deleteMany({ where: { name: { startsWith: prefix } } });
        await db.tag.deleteMany({ where: { name: { startsWith: prefix } } });
        await db.attributeDefinition.deleteMany({ where: { OR: [{ code: { startsWith: prefix } }, { name: { startsWith: prefix } }] } });
        await db.shopMember.deleteMany({ where: { user_id: userId } });
        await db.user.deleteMany({ where: { id: userId } });
      } finally { await db.$disconnect(); }
    }
  },
});
async function login(page: Page, username: string) {
  await page.goto('/#/login');
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('SellerUi123!');
  await submitLogin(page);
  await expect(page.getByRole('region', { name: '商店管理', exact: true })).toBeVisible();
}
async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const r = await request.post(`/api/seller/${path}`, { data }); expect(r.status(), await r.text()).toBe(201); return r.json() as Promise<T>;
}
function category(name: string) { return { name, description: null, sortOrder: 0, isActive: true }; }
function tag(name: string) { return { ...category(name), groupName: '场景' }; }
function product(name: string, tags: string[] = []) { return { name, description: '浏览器测试商品', categoryId: null, tagIds: tags, status: 'active', imageUrls: [], defaultSku: { skuCode: `${name}_sku`, name: '标准版', price: '12.34', stockQuantity: 8, isActive: true, attributes: [] } }; }
async function module(page: Page, name: string) { await page.getByRole('navigation', { name: '管理模块' }).getByRole('button', { name, exact: true }).click(); }
async function find(page: Page, label: string, name: string) { await page.getByLabel(label, { exact: true }).fill(name); await page.locator('.manage-toolbar').getByRole('button', { name: '搜索', exact: true }).click(); }
async function editProduct(page: Page, name: string) {
  await module(page, '商品与规格'); await find(page, '搜索商品', name);
  await page.locator('.manage-list .manage-row').filter({ hasText: name }).getByRole('button', { name: '编辑商品', exact: true }).click();
  await expect(page.getByLabel('商品名称', { exact: true })).toHaveValue(name);
}

test('seller creates category, tag, shared attribute and a sellable product through forms', async ({ page, scope }, info) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await login(page, scope);
  await module(page, '分类'); await page.getByRole('button', { name: '新建分类', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('名称', { exact: true }).fill(`${scope}_分类`);
  await expect(page.getByLabel('名称', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await module(page, '标签'); await page.getByRole('button', { name: '新建标签', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(`${scope}_标签`); await page.getByLabel('标签分组').fill('用途');
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await module(page, '共享属性'); await page.getByRole('button', { name: '新建共享属性', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(`${scope}_重量`); await expect(page.getByLabel('属性编码')).toHaveCount(0);
  await page.getByLabel('属性类型').selectOption('number'); await page.getByLabel('单位', { exact: true }).fill('g');
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  const definitions = await (await page.request.get(`/api/seller/attributes?q=${encodeURIComponent(`${scope}_重量`)}`)).json() as { items: SellerDefinitionDto[] };
  expect(definitions.items[0]?.code).toMatch(/^attr_[0-9a-f]{32}$/);
  await module(page, '商品与规格'); await page.getByRole('button', { name: '新建商品', exact: true }).click();
  const name = `${scope}_随身好物`;
  await page.getByLabel('商品名称', { exact: true }).fill(name); await page.getByLabel('商品状态', { exact: true }).selectOption('active');
  await page.getByLabel('主分类（可选）').selectOption({ label: `${scope}_分类` });
  await page.getByLabel(`${scope}_标签`, { exact: true }).check();
  await page.getByText('商家货号（可选）').click(); await page.getByLabel('商家货号', { exact: true }).fill(`${scope}_sku`);
  await page.getByLabel('单价（元）').fill('29.90'); await page.getByLabel('库存数量').fill('12');
  await page.getByLabel('添加属性', { exact: true }).selectOption({ label: `${scope}_重量（g）` });
  await page.getByLabel(`${scope}_重量（g）`, { exact: true }).fill('abc');
  await page.getByRole('button', { name: '创建商品', exact: true }).click();
  await expect(page.getByLabel(`${scope}_重量（g）`, { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel(`${scope}_重量（g）`, { exact: true }).fill('80.25');
  await page.getByRole('button', { name: '创建商品', exact: true }).click(); await expect(page.getByText('商品已保存', { exact: true })).toBeVisible();
  await find(page, '搜索商品', name); await expect(page.locator('.manage-list')).toContainText(name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('seller-products.png'), fullPage: true });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '发现好物' }).click();
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('button', { name: `${scope}_分类`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `${scope}_标签`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看结果', exact: true }).click();
  await page.getByRole('textbox', { name: '顶部商品搜索', exact: true }).fill(name); await page.locator('.header-search').getByRole('button', { name: '找商品', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(1); await page.locator('.product-card').click();
  const detail = page.getByRole('region', { name: '商品详情', exact: true }); await expect(detail).toContainText('29.90'); await expect(detail).toContainText('80.25'); await expect(detail).toContainText(`${scope}_标签`);
  expect(errors).toEqual([]);
});

test('tag merge, rename and disable update the catalog without losing bindings', async ({ page, scope }, info) => {
  await login(page, scope);
  const source = await post<SellerTagDto>(page.request, 'tags', tag(`${scope}_来源`));
  const target = await post<SellerTagDto>(page.request, 'tags', tag(`${scope}_目标`));
  const one = await post<SellerProductDetailDto>(page.request, 'products', product(`${scope}_商品一`, [source.id, target.id]));
  const two = await post<SellerProductDetailDto>(page.request, 'products', product(`${scope}_商品二`, [source.id]));
  await module(page, '标签'); await find(page, '搜索标签', `${scope}_来源`);
  await page.locator('.manage-row').filter({ hasText: source.name }).getByRole('button', { name: '合并', exact: true }).click();
  await page.getByRole('button', { name: '确认操作' }).click();
  await expect(page.getByLabel('目标标签')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('目标标签').selectOption(target.id); await page.getByRole('button', { name: '确认操作' }).click(); await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  for (const p of [one, two]) expect((await (await page.request.get(`/api/seller/products/${p.id}`)).json()).tagIds).toEqual([target.id]);
  await find(page, '搜索标签', target.name); await page.locator('.manage-row').filter({ hasText: target.name }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(`${scope}_新目标`);
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByRole('region', { name: '编辑标签', exact: true })).toHaveCount(0);
  expect((await (await page.request.get(`/api/products/${one.id}`)).json()).tags[0].name).toBe(`${scope}_新目标`);
  await find(page, '搜索标签', `${scope}_新目标`); await page.locator('.manage-row').filter({ hasText: `${scope}_新目标` }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('启用', { exact: true }).uncheck(); await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('region', { name: '编辑标签', exact: true })).toHaveCount(0);
  const publicRow = await page.request.get(`/api/products/${one.id}`); expect(publicRow.status()).toBe(200); expect((await publicRow.json()).tags).toEqual([]);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.locator('.manage-row').filter({ hasText: `${scope}_新目标` })).toContainText('停用');
  await page.screenshot({ path: info.outputPath('seller-tags.png'), fullPage: true });
  await editProduct(page, one.name); await expect(page.getByLabel(`${scope}_新目标（停用，可解除）`, { exact: true })).toBeChecked();
});

test('SKU editor enforces last enabled SKU, updates price and stock, and recovers from stale writes', async ({ page, scope }, info) => {
  await login(page, scope);
  const p = await post<SellerProductDetailDto>(page.request, 'products', product(`${scope}_规格商品`));
  await editProduct(page, p.name);
  await page.getByRole('button', { name: '编辑规格', exact: true }).click();
  await page.getByLabel('启用规格').uncheck(); await page.getByRole('button', { name: '保存规格', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('最后一个启用规格');
  await page.getByLabel('启用规格').check(); await page.getByLabel('单价（元）').fill('19.99'); await page.getByLabel('库存数量').fill('3');
  await page.getByRole('button', { name: '保存规格', exact: true }).click(); await expect(page.getByText('规格已保存', { exact: true })).toBeVisible();
  const pub = await (await page.request.get(`/api/products/${p.id}`)).json(); expect(pub.skus[0].price).toBe('19.99'); expect(pub.skus[0].stockQuantity).toBe(3);
  await page.getByRole('button', { name: '新增规格', exact: true }).click(); await page.getByLabel('规格名称', { exact: true }).fill('加大版');
  await page.getByRole('button', { name: '保存规格', exact: true }).click(); await expect(page.getByRole('heading', { name: '商品规格 · 2' })).toBeVisible();
  await expect(page.getByRole('region', { name: '规格管理' }).locator('.manage-row')).toHaveCount(2);
  const latest = await (await page.request.get(`/api/seller/products/${p.id}`)).json() as SellerProductDetailDto;
  const { skus: _skus, skuCount: _count, id: _id, shopId: _shopId, ...body } = latest;
  expect((await page.request.put(`/api/seller/products/${p.id}`, { data: { ...body, description: '其他页面已更新' } })).status()).toBe(200);
  await page.getByLabel('商品名称', { exact: true }).fill(`${scope}_本地修改`); await page.getByRole('button', { name: '保存商品信息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('数据已被修改');
  await page.getByRole('button', { name: '关闭编辑器' }).click(); await editProduct(page, p.name); await expect(page.getByLabel('商品说明', { exact: true })).toHaveValue('其他页面已更新');
  await page.screenshot({ path: info.outputPath('seller-skus.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('商品状态', { exact: true }).selectOption('inactive');
  await expect(page.getByRole('button', { name: '新增规格', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存商品信息', exact: true }).click(); await expect(page.getByText('商品已保存', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/products/${p.id}`)).status()).toBe(404);
  await editProduct(page, p.name); await page.getByLabel('商品状态', { exact: true }).selectOption('active');
  await page.getByRole('button', { name: '保存商品信息', exact: true }).click(); await expect(page.getByText('商品已保存', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/products/${p.id}`)).status()).toBe(200);
});

test('used attribute options and referenced categories show recoverable errors', async ({ page, scope }) => {
  await login(page, scope);
  const c = await post<SellerCategoryDto>(page.request, 'categories', category(`${scope}_分类`));
  const d = await post<SellerDefinitionDto>(page.request, 'attributes', { code: `${scope}_color`, name: `${scope}_颜色`, dataType: 'enum', unit: null, options: ['红', '蓝'], isFilterable: true, sortOrder: 0 });
  const input = product(`${scope}_引用商品`);
  await post<SellerProductDetailDto>(page.request, 'products', { ...input, categoryId: c.id, defaultSku: { ...input.defaultSku, attributes: [{ attributeId: d.id, value: '红' }] } });
  await module(page, '分类'); await find(page, '搜索分类', c.name);
  await page.locator('.manage-row').filter({ hasText: c.name }).getByRole('button', { name: '删除', exact: true }).click(); await page.getByRole('button', { name: '确认操作' }).click();
  await expect(page.getByRole('alert')).toContainText('仍有商品引用'); await page.getByRole('button', { name: '取消操作' }).click();
  await module(page, '共享属性'); await find(page, '搜索共享属性', d.name);
  await page.locator('.manage-row').filter({ hasText: d.name }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('枚举选项（每行一个）').fill('蓝'); await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('仍在使用的枚举选项');
  await page.getByLabel('枚举选项（每行一个）').fill('红\n蓝\n绿'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('region', { name: '编辑共享属性', exact: true })).toHaveCount(0);
  await module(page, '分类'); await find(page, '搜索分类', c.name);
  await page.route('**/api/seller/categories?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '暂时无法加载分类' } }) }));
  await page.getByRole('button', { name: '重新加载', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('暂时无法加载分类');
  await page.unroute('**/api/seller/categories?*'); await page.getByRole('button', { name: '重新加载', exact: true }).click(); await expect(page.locator('.manage-row').filter({ hasText: c.name })).toBeVisible();
});

test('seller uploads and reorders product photos with visual previews', async ({ page, scope }) => {
  await login(page, scope);
  await module(page, '共享属性');
  await find(page, '搜索共享属性', '重量');
  const attributeRows = page.locator('.manage-list .manage-row');
  if (await attributeRows.count()) await expect(attributeRows.first()).not.toContainText(' · number');
  await module(page, '商品与规格');
  await page.getByRole('button', { name: '新建商品', exact: true }).click();
  const name = `${scope}_上传图片商品`;
  await page.getByLabel('商品名称', { exact: true }).fill(name);
  await page.getByLabel('商品状态', { exact: true }).selectOption('active');
  await page.getByLabel('单价（元）').fill('18.00');
  await page.getByLabel('库存数量').fill('3');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  await page.getByLabel('上传商品图片').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('region', { name: '商品图片管理' }).getByRole('img', { name: '商品图片 1' })).toBeVisible();
  await page.getByLabel('或添加图片 URL').fill('ftp://example.com/second.jpg');
  await page.getByRole('button', { name: '添加链接' }).click();
  await expect(page.getByLabel('或添加图片 URL')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('或添加图片 URL').fill('https://example.com/second.jpg');
  await expect(page.getByLabel('或添加图片 URL')).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: '添加链接' }).click();
  await expect(page.getByText('2 / 8')).toBeVisible();
  await page.getByRole('button', { name: '将第 2 张图片前移' }).click();
  await page.getByRole('button', { name: '将第 2 张图片前移' }).click();
  await page.getByRole('button', { name: '创建商品' }).click();
  await expect(page.getByText('商品已保存', { exact: true })).toBeVisible();
  await find(page, '搜索商品', name);
  const row = page.locator('.manage-list .manage-row').filter({ hasText: name });
  await expect(row.getByRole('img', { name: `${name}封面` })).toBeVisible();
  await row.getByRole('button', { name: '编辑商品' }).click();
  await expect(page).toHaveURL(/#\/seller\/products\/[0-9a-f-]{36}$/);
  await page.reload();
  const images = page.getByRole('region', { name: '商品图片管理' });
  await expect(images.getByRole('img', { name: '商品图片 1' })).toHaveAttribute('src', /\/api\/uploads\/.*\.png$/);
  await expect(images.getByRole('img', { name: '商品图片 2' })).toHaveAttribute('src', 'https://example.com/second.jpg');
});

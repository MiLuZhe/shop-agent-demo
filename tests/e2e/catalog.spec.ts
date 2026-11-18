import { expect, test } from '@playwright/test';

test('browse, filter across categories and inspect SKU facts', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const catalog = await page.request.get('/api/products?pageSize=12');
  expect(catalog.status()).toBe(200);
  const initialCount = (await catalog.json()).items.length;
  expect(initialCount).toBeGreaterThan(0);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '发现你的日常好物' })).toBeVisible();
  await expect(page.getByRole('search', { name: '全站搜索' })).toBeVisible();
  await expect(page.locator('.product-card')).toHaveCount(initialCount);
  await expect(page.getByRole('button', { name: '旧标签', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '筛选商品' })).toBeVisible();
  await page.getByRole('button', { name: '通勤', exact: true }).click();
  await page.getByRole('button', { name: '旅行', exact: true }).click();
  const tags = (await (await page.request.get('/api/tags?pageSize=50')).json()).items as { id: string; name: string }[];
  const selected = tags.filter(tag => ['通勤', '旅行'].includes(tag.name)).map(tag => tag.id);
  expect(selected).toHaveLength(2);
  const filtered = await (await page.request.get(`/api/products?pageSize=12&tagMode=all&tagIds=${selected.join(',')}`)).json();
  expect(filtered.total).toBeGreaterThan(0);
  expect(filtered.items.every((item: { tags: { id: string }[] }) => selected.every(id => item.tags.some(tag => tag.id === id)))).toBe(true);
  await expect(page.locator('.product-card')).toHaveCount(filtered.items.length);
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await page.getByRole('button', { name: '查看结果', exact: true }).click();
  await page.getByLabel('顶部商品搜索', { exact: true }).fill('鼠标');
  await page.locator('.header-search').getByRole('button', { name: '找商品', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(1);
  await page.locator('.product-card').click();
  const dialog = page.getByRole('region', { name: '商品详情', exact: true });
  await expect(page).toHaveURL(/#\/products\//);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('标准黑色版', { exact: true })).toBeVisible();
  await expect(dialog.getByText('轻量白色版', { exact: true })).toBeVisible();
  await expect(dialog.getByText('¥129.00', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回商店', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('顶部商品搜索', { exact: true }).fill('磁吸折叠手机支架');
  await page.locator('.header-search').getByRole('button', { name: '找商品', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.locator('.product-card')).toContainText('磁吸折叠手机支架');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await page.getByLabel('最高价格').fill('100');
  await page.getByLabel('筛选属性').selectOption({ label: '重量（g）' });
  await page.getByLabel('属性取值').fill('50');
  await page.getByRole('button', { name: '添加条件' }).click();
  await page.getByRole('button', { name: '查看结果', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有找到合适的商品' })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.locator('.product-card')).toHaveCount(initialCount);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath('catalog.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('network failure offers a working retry', async ({ page }) => {
  await page.route('**/api/products?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '暂时无法读取商品' } }) }));
  const catalog = await page.request.get('/api/products?pageSize=12');
  expect(catalog.status()).toBe(200);
  const initialCount = (await catalog.json()).items.length;
  expect(initialCount).toBeGreaterThan(0);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '暂时无法展示商品' })).toBeVisible();
  await page.unroute('**/api/products?*');
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.locator('.product-card')).toHaveCount(initialCount);
});

test('wide desktop content uses the available page width and expands the product grid', async ({ page, isMobile }) => {
  test.skip(isMobile, 'This checks the wide desktop layout.');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await expect(page.locator('.product-card').first()).toBeVisible();
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    main: document.querySelector('main')!.getBoundingClientRect().width,
    header: document.querySelector('.store-header')!.getBoundingClientRect().width,
    columns: getComputedStyle(document.querySelector('.grid')!).gridTemplateColumns.split(' ').length,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.main).toBe(layout.viewport);
  expect(layout.header).toBe(layout.viewport);
  expect(layout.columns).toBe(5);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
});

test('top navigation and search stay available while scrolling', async ({ page, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/');
  const header = page.locator('.store-header');
  await expect(header).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => header.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(0);
  await expect(page.getByRole('textbox', { name: '顶部商品搜索', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '筛选', exact: true })).toBeVisible();
});


test('one filter dialog works across pages, preserves choices, resets independently and restores focus', async ({ page }, info) => {
  await page.goto('/#/login');
  const trigger = page.getByRole('button', { name: '筛选', exact: true });
  await trigger.click();
  const filters = page.getByRole('dialog', { name: '筛选商品' });
  await expect(filters).toBeVisible();
  await expect(page.locator('main aside')).toHaveCount(0);
  await filters.getByRole('button', { name: '数码配件', exact: true }).click();
  await filters.getByLabel('只看有货商品').check();
  await filters.getByRole('button', { name: '查看结果', exact: true }).click();
  await expect(filters).not.toBeVisible();
  await expect(page.locator('.product-card').first()).toBeVisible();
  const categories = await page.locator('.product-card .card-category').allTextContents();
  expect(categories.length).toBeGreaterThan(0);
  expect(categories.every((category) => category === '数码配件')).toBe(true);
  await trigger.click();
  await expect(filters.getByRole('button', { name: '数码配件', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(filters.getByLabel('只看有货商品')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(filters).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByRole('textbox', { name: '顶部商品搜索', exact: true }).fill('鼠标');
  await page.locator('.header-search').getByRole('button', { name: '找商品', exact: true }).click();
  await trigger.click();
  await filters.getByRole('button', { name: '重置', exact: true }).click();
  await expect(filters.getByRole('button', { name: '全部好物', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(filters.getByLabel('只看有货商品')).not.toBeChecked();
  expect(await filters.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('catalog-filters.png'), fullPage: true });
  await filters.getByRole('button', { name: '关闭筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '顶部商品搜索', exact: true })).toHaveValue('鼠标');
  await expect(page.locator('.product-card')).toHaveCount(1);
});

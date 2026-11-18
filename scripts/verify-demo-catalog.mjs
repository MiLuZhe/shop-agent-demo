import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

// Read-only check: no login, model calls, uploads, cart writes or catalogue mutations.
const data = JSON.parse(await readFile(new URL('./data/demo-catalog-20261118.json', import.meta.url), 'utf8'));
const base = process.env.SHOP_WEB_URL ?? 'http://127.0.0.1:5173';
const output = process.env.SHOP_CATALOG_REPORT ?? new URL('../docs/验收记录/导购商品目录图片验证.json', import.meta.url);
const report = { checkedAt: new Date().toISOString(), readOnly: true, passed: false, api: {}, imageCount: 0, devices: [] };
let browser, phase = 'api';
async function json(path) {
  const response = await fetch(`${base}/api${path}`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); return response.json();
}
try {
  const categories = await json('/categories?pageSize=50'), tags = await json('/tags?pageSize=50'), filters = await json('/filters?pageSize=50');
  const details = [];
  for (const expected of data.products) {
    const p = await json(`/products/${expected.id}`);
    assert.equal(p.name, expected.name); assert.ok(p.description?.length > 40);
    assert.equal(p.category?.name, expected.category); assert.ok(p.imageUrls.length >= 2 && p.imageUrls.length <= 8);
    assert.equal(p.skus.length, 3); assert.ok(p.tags.length >= 2);
    for (const s of p.skus) {
      assert.ok(s.attributeCount >= 4); assert.ok(s.attributes.some(a => a.code === 'material'));
      assert.ok(Number(s.price) > 0 && s.stockQuantity >= 0); assert.ok(!s.name.includes('默认规格'));
    }
    details.push(p);
  }
  const listing = []; let page = 1, total;
  do { const result = await json(`/products?pageSize=12&page=${page++}`); total = result.total; listing.push(...result.items); assert.ok(page <= 20); } while (listing.length < total);
  assert.equal(new Set(listing.map(p => p.id)).size, listing.length);
  assert.ok(data.products.every(p => listing.some(item => item.id === p.id)));
  assert.ok(!listing.some(p => /^manage_/.test(p.name)));
  const color = filters.items.find(d => d.code === 'color').id;
  const memory = filters.items.find(d => d.code === 'memory_gb').id;
  const storage = filters.items.find(d => d.code === 'storage_gb').id;
  const search = (q, rest) => json(`/products?${new URLSearchParams({ q, pageSize: '50', ...rest })}`);
  const absent = await search('轻触多设备无线键盘', { maxPrice: '150', attributes: JSON.stringify([{ attributeId: color, type: 'text', op: 'eq', value: '白色' }]) });
  assert.equal(absent.total, 0); // White is 159; the cheaper black SKU must not satisfy the white requirement.
  const present = await search('轻触多设备无线键盘', { maxPrice: '150', attributes: JSON.stringify([{ attributeId: color, type: 'text', op: 'eq', value: '黑色' }]) });
  assert.equal(present.total, 1);
  const incompatible = await search('笔记本电脑', { attributes: JSON.stringify([{ attributeId: memory, type: 'number', op: 'eq', value: '8' }, { attributeId: storage, type: 'number', op: 'eq', value: '1024' }]) });
  assert.equal(incompatible.total, 0);
  const cup = await search('随行保温杯', { inStock: 'true', attributes: JSON.stringify([{ attributeId: color, type: 'text', op: 'eq', value: '黑色' }]) });
  assert.equal(cup.total, 0); // The original black 500ml SKU remains sold out.
  const commuteTravel = tags.items.filter(t => ['通勤', '旅行'].includes(t.name)).map(t => t.id);
  const tagged = await search('', { tagMode: 'all', tagIds: commuteTravel.join(',') });
  assert.ok(tagged.total > 0 && tagged.items.every(p => commuteTravel.every(id => p.tags.some(t => t.id === id))));
  report.api = { products: details.length, activeSkus: details.reduce((n,p) => n + p.skus.length, 0), categories: categories.total, tags: tags.total, filterableAttributes: filters.total, pages: page - 1, sameSkuFilters: true, outOfStockPreserved: true, tagIntersection: true };
  phase = 'image-reads';
  const urls = [...new Set(details.flatMap(p => p.imageUrls))];
  for (const stable of urls) {
    const response = await fetch(`${base}${stable}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 302); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const location = new URL(response.headers.get('location'));
    assert.equal(location.protocol, 'https:'); assert.equal(location.hostname, 'agent-shop-demo.tos-cn-shanghai.volces.com');
    assert.ok(location.searchParams.has('X-Tos-Signature')); assert.equal(location.searchParams.get('X-Tos-Expires'), '300');
    const image = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(image.status, 200); const bytes = new Uint8Array(await image.arrayBuffer());
    assert.ok(bytes.length > 1024 && bytes.length <= 4 * 1024 * 1024); assert.equal(bytes[0], 255); assert.equal(bytes[1], 216);
    report.imageCount++;
    if (report.imageCount === 1) {
      const unsigned = await fetch(`${location.origin}${location.pathname}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(unsigned.status, 403); report.unsignedReadDenied = true;
    }
  }
  phase = 'browser';
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  for (const device of ['desktop', 'mobile']) {
    const context = await browser.newContext(device === 'mobile' ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 1000 } });
    const row = { device, catalogCards: 0, galleryImages: 0, detailPages: 0, overflow: false, errors: 0 };
    try {
      const p = await context.newPage(); p.on('pageerror', () => row.errors++);
      await p.goto(base, { waitUntil: 'networkidle' });
      for (let n = 0; n < page - 1; n++) {
        const cards = p.locator('.product-card'); await cards.first().waitFor();
        for (let i = 0; i < await cards.count(); i++) {
          await cards.nth(i).scrollIntoViewIfNeeded();
          await cards.nth(i).locator('img').evaluate(image => image.decode()); row.catalogCards++;
        }
        row.overflow ||= await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        if (n === 0) { await p.evaluate(() => scrollTo(0, 0)); await p.screenshot({ path: fileURLToPath(new URL(`../docs/验收记录/综合商品目录-${device}.png`, import.meta.url)), fullPage: true }); }
        if (n < page - 2) { const previous = await cards.first().getAttribute('href'); await p.getByRole('button', { name: '下一页', exact: true }).click(); await p.waitForFunction(old => document.querySelector('.product-card')?.getAttribute('href') !== old, previous); }
      }
      for (const name of ['轻行无线鼠标', '轻触多设备无线键盘', '云感无线头戴耳机', '原味不锈钢双耳汤锅', '日常纯棉圆领短袖', '暖绒针织休闲毯']) {
        const product = details.find(p => p.name === name), chosen = product.skus.at(-1);
        await p.goto(`${base}/#/products/${product.id}?sku=${chosen.id}`, { waitUntil: 'networkidle' });
        await p.getByRole('heading', { name, exact: true }).waitFor();
        assert.equal(await p.getByRole('radio').filter({ hasText: chosen.name }).getAttribute('aria-checked'), 'true');
        for (let i = 0; i < product.imageUrls.length; i++) { await p.getByRole('button', { name: `查看第 ${i + 1} 张图片`, exact: true }).click(); await p.locator('.gallery-stage>img').evaluate(image => image.decode()); row.galleryImages++; }
        row.overflow ||= await p.evaluate(() => document.documentElement.scrollWidth > innerWidth); row.detailPages++;
        if (name === '轻触多设备无线键盘') await p.screenshot({ path: fileURLToPath(new URL(`../docs/验收记录/综合商品详情-${device}.png`, import.meta.url)), fullPage: true });
      }
    } finally { await context.close(); }
    assert.equal(row.overflow, false); assert.equal(row.errors, 0); report.devices.push(row);
  }
  report.passed = true;
} catch (error) { report.failure = { phase, type: error?.name ?? 'Error', line: /verify-demo-catalog\.mjs:(\d+)/.exec(error?.stack ?? '')?.[1] }; }
finally {
  await browser?.close(); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, phase, api: report.api, verifiedImages: report.imageCount, devices: report.devices }));
  if (!report.passed) process.exitCode = 1;
}

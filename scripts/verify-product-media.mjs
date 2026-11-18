import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const root = new URL('../', import.meta.url), baseURL = process.env.SHOP_WEB_URL ?? 'http://127.0.0.1:5173';
const manifest = JSON.parse(await readFile(new URL('docs/验收记录/TOS商品图片迁移.json', root), 'utf8'));
const results = { executed_at: new Date().toISOString(), browser: 'Chromium', mobile_is_emulated: true, devices: [], all_passed: false };
let browser;
try {
  browser = await chromium.launch({ args: ['--no-proxy-server'] });
  for (const device of ['desktop', 'mobile']) {
    const context = await browser.newContext(device === 'mobile' ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 1000 } });
    const row = { device, products: [], tos_responses: 0, signed_https_reads: 0 };
    try {
      const page = await context.newPage();
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.hostname === `${manifest.bucket}.tos-cn-shanghai.volces.com` && response.status() === 200) {
          row.tos_responses++;
          if (url.protocol === 'https:' && url.searchParams.has('X-Tos-Signature')) row.signed_https_reads++;
        }
      });
      for (const product of manifest.products) {
        await page.goto(`${baseURL}/#/products/${product.id}`, { waitUntil: 'networkidle', timeout: 30000 });
        const checked = [];
        for (let i = 0; i < product.image_count; i++) {
          if (product.image_count > 1) await page.getByRole('button', { name: `查看第 ${i + 1} 张图片`, exact: true }).click();
          await page.waitForFunction(() => {
            const image = document.querySelector('.gallery-stage>img');
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
          }, undefined, { timeout: 12000 });
          const image = await page.locator('.gallery-stage>img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, stable_reference: image.getAttribute('src')?.startsWith('/demo-media/') || image.getAttribute('src')?.startsWith('/api/uploads/') }));
          checked.push(image);
        }
        row.products.push({ id: product.id, name: product.name, images: checked });
        if (product.name === '折叠充电器') await page.screenshot({ path: fileURLToPath(new URL(`docs/验收记录/TOS商品详情-${device}.png`, root)), fullPage: true });
      }
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      const cards = page.locator('.product-card');
      for (let i = 0; i < await cards.count(); i++) await cards.nth(i).scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.querySelectorAll('.product-card img')].every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: fileURLToPath(new URL(`docs/验收记录/TOS商品目录-${device}.png`, root)), fullPage: true });
      results.devices.push(row);
    } finally { await context.close(); }
  }
  results.all_passed = results.devices.length === 2 && results.devices.every(row => row.products.length === manifest.products.length && row.products.every(p => p.images.length > 0 && p.images.every(i => i.width > 0 && i.height > 0 && i.stable_reference)) && row.tos_responses > 0 && row.tos_responses === row.signed_https_reads);
} catch (error) {
  // Browser exceptions can contain temporary signed URLs: persist only their class.
  results.error = { name: error?.name ?? 'Error' };
} finally {
  if (browser) await browser.close();
  await writeFile(new URL('docs/验收记录/TOS全部商品页面验证.json', root), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ passed: results.all_passed, products_per_device: results.devices.map(x => x.products.length), images_per_device: results.devices.map(x => x.products.reduce((n, p) => n + p.images.length, 0)) }));
  if (!results.all_passed) process.exitCode = 1;
}

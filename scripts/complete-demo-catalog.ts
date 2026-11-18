import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDatabase, Prisma } from '../packages/database/src/index.ts';
import { DEFAULT_SHOP_ID, productWriteSchema, skuWriteSchema, definitionWriteSchema } from '../packages/contracts/src/index.ts';
import { createTosClient, imageFormat, imageKey, legacyKey, MAX_IMAGE_BYTES } from '../apps/shop-api/src/catalog/image-store.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), apply = args.includes('--apply'), prepare = args.includes('--prepare');
const enrich = args.includes('--enrich-existing'), cleanup = args.includes('--cleanup-tests');
const run = promisify(execFile), sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const stable = (n: number) => `26111800-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cache = path.join(homedir(), '.local/share/shop-agent-demo/catalog-media-20261118');
const reportDirectory = path.join(homedir(), '.local/share/shop-agent-demo/verification/catalog-complete-20261118');
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const manifest = z.object({
  version: z.string(), license: z.url(), photoParameters: z.string(),
  photos: z.array(z.object({ id: z.number().int().positive(), page: z.url(), subject: z.string() })),
  categories: z.array(z.object({ name: z.string(), description: z.string() })),
  tags: z.array(z.object({ name: z.string(), group: z.string(), description: z.string() })),
  attributes: z.array(z.object({ code: z.string(), name: z.string(), type: z.enum(['number', 'text', 'boolean', 'enum']), unit: z.string().nullable(), options: z.array(z.string()).nullable() })),
  products: z.array(z.object({ id: z.uuid(), name: z.string(), category: z.string(), description: z.string(), tags: z.array(z.string()), photos: z.array(z.number()), existing: z.boolean().optional(), skus: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), price: z.string(), stock: z.number().int(), existing: z.boolean().optional(), attributes: z.record(z.string(), scalar) })) })),
}).parse(JSON.parse(await readFile(new URL('./data/demo-catalog-20261118.json', import.meta.url), 'utf8')));
const newPhotos = new Set(manifest.photos.map(p => p.id));
const filename = (id: number) => `26111800-1000-4000-8000-${String(id).padStart(12, '0')}.jpg`;
const photoUrl = (id: number) => newPhotos.has(id) ? `/api/uploads/${DEFAULT_SHOP_ID}/${filename(id)}` : `/demo-media/pexels-${id}.jpg`;
const photoKey = (id: number) => newPhotos.has(id) ? imageKey(DEFAULT_SHOP_ID, filename(id)) : legacyKey(`pexels-${id}.jpg`);
const categoryIds = new Map(manifest.categories.map((c, i) => [c.name, stable(50000 + i)]));
const tagIds = new Map(manifest.tags.map((t, i) => [t.name, stable(40000 + i)]));
const definitions = new Map(manifest.attributes.map((a, i) => [a.code, { ...a, id: stable(30000 + i) }]));

// Validate the same public write contracts, plus typed enum/range references, before cloud or DB writes.
for (const a of definitions.values()) definitionWriteSchema.parse({ code: a.code, name: a.name, dataType: a.type, unit: a.unit, options: a.options, isFilterable: a.code !== 'care', sortOrder: 0 });
if (new Set(manifest.products.map(p => p.id)).size !== manifest.products.length || new Set(manifest.products.flatMap(p => p.skus.map(s => s.id))).size !== manifest.products.flatMap(p => p.skus).length) throw new Error('Duplicate catalogue identity');
for (const p of manifest.products) {
  if (!categoryIds.has(p.category) || p.tags.some(t => !tagIds.has(t)) || p.skus.length < 3 || p.photos.length < 2) throw new Error('Incomplete catalogue entry');
  productWriteSchema.parse({ name: p.name, description: p.description, categoryId: categoryIds.get(p.category), tagIds: p.tags.map(t => tagIds.get(t)), imageUrls: p.photos.map(photoUrl), status: 'active' });
  for (const s of p.skus) {
    skuWriteSchema.parse({ skuCode: s.code, name: s.name, price: s.price, stockQuantity: s.stock, isActive: true, attributes: Object.entries(s.attributes).map(([code, value]) => ({ attributeId: definitions.get(code)?.id, value: typeof value === 'boolean' ? value : String(value) })) });
    for (const [code, value] of Object.entries(s.attributes)) {
      const d = definitions.get(code);
      if (!d || (d.type === 'enum' && !d.options?.includes(String(value))) || (d.type === 'boolean' && typeof value !== 'boolean') || (d.type === 'number' && !/^-?\d{1,14}(\.\d{1,4})?$/.test(String(value)))) throw new Error('Invalid typed catalogue attribute');
    }
  }
}
if (process.env.NODE_ENV === 'production') throw new Error('Demo catalogue is for local development only');
if (apply && process.env.SHOP_IMAGE_STORAGE !== 'tos') throw new Error('This demo catalogue requires the configured private TOS storage');
await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
const db = createDatabase();
let phase = 'plan';
const report: Record<string, unknown> = { executedAt: new Date().toISOString(), version: manifest.version, products: manifest.products.length, skus: manifest.products.reduce((n, p) => n + p.skus.length, 0), photos: manifest.photos.length };
async function protectedDigests() {
  const result: Record<string, string> = {};
  for (const table of ['users', 'account_names', 'saved_addresses', 'shops', 'shop_members', 'chat_channels', 'chat_read_states', 'conversations', 'messages', 'inquiries', 'cart_items', 'orders', 'order_items']) {
    const rows = await db.$queryRawUnsafe<Array<{ digest: string }>>(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM "${table}" t`);
    result[table] = rows[0]!.digest;
  }
  return result;
}
try {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: DEFAULT_SHOP_ID } });
  if (shop.status !== 'active') throw new Error('Target demo shop is inactive');
  const originals = await db.product.findMany({ where: { id: { in: manifest.products.map(p => p.id) } }, include: { skus: true } });
  for (const p of originals) {
    const expected = manifest.products.find(x => x.id === p.id)!;
    if (p.shop_id !== DEFAULT_SHOP_ID || (expected.existing && p.name !== expected.name)) throw new Error('Original product identity changed; review required');
  }
  const existingSkus = await db.sku.findMany({ where: { OR: [{ id: { in: manifest.products.flatMap(p => p.skus.map(s => s.id)) } }, { sku_code: { in: manifest.products.flatMap(p => p.skus.map(s => s.code)) } }] } });
  for (const s of existingSkus) {
    const expected = manifest.products.flatMap(p => p.skus.map(sku => ({ ...sku, product: p.id }))).find(x => x.id === s.id);
    if (!expected || expected.product !== s.product_id || expected.code !== s.sku_code) throw new Error('SKU identity collision; review required');
  }
  report.newProducts = manifest.products.length - originals.length;
  report.newSkus = manifest.products.flatMap(p => p.skus).length - existingSkus.length;
  if (!prepare && !apply) { console.log(JSON.stringify({ ...report, mode: 'read-only plan', enrich, cleanup })); }
  else {
    phase = 'download';
    await mkdir(cache, { recursive: true, mode: 0o700 }); await chmod(cache, 0o700);
    const downloaded: Array<{ id: number; bytes: number; sha256: string }> = [];
    const queue = [...manifest.photos];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let photo = queue.shift(); photo; photo = queue.shift()) {
        const target = path.join(cache, `pexels-${photo.id}.jpg`);
        if (!await stat(target).then(s => s.size > 0, () => false)) {
          try { await run('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '45', '--max-filesize', String(MAX_IMAGE_BYTES), `https://images.pexels.com/photos/${photo.id}/pexels-photo-${photo.id}.jpeg?${manifest.photoParameters}`, '-o', target]); }
          catch { throw new Error(`Photo download failed: ${photo.id}`); }
        }
        const bytes = await readFile(target);
        if (imageFormat(bytes) !== 'jpg' || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Invalid photo: ${photo.id}`);
        await chmod(target, 0o600); downloaded.push({ id: photo.id, bytes: bytes.length, sha256: sha(bytes) });
      }
    }));
    report.downloaded = downloaded.sort((a, b) => a.id - b.id);
    if (!apply) console.log(JSON.stringify({ ...report, downloaded: downloaded.length, totalBytes: downloaded.reduce((n, p) => n + p.bytes, 0), mode: 'prepared; database and cloud unchanged' }));
    else {
      phase = 'backup';
      const backup = path.join(homedir(), '.local/share/shop-agent-demo/backups', `catalog-apply-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await mkdir(backup, { recursive: true, mode: 0o700 });
      const databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.slice(1));
      const dump = await run('docker', ['compose', 'exec', '-T', 'postgres', 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$1" -Fc', 'sh', databaseName], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      await writeFile(path.join(backup, 'database.dump'), dump.stdout, { mode: 0o600 });
      await writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 }); report.backup = backup;
      const protectedBefore = await protectedDigests();
      phase = 'cloud';
      const { client, bucket } = createTosClient();
      const objects: Array<{ id: number; url: string; bytes: number; sha256: string; created: boolean }> = [];
      for (const photo of manifest.photos) {
        const key = photoKey(photo.id), bytes = await readFile(path.join(cache, `pexels-${photo.id}.jpg`));
        let exists = false;
        try { await client.headObject({ bucket, key }); exists = true; }
        catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw new Error(`Cloud check failed: ${photo.id}`); }
        if (!exists) await client.putObject({ bucket, key, body: bytes, contentType: 'image/jpeg', contentMD5: createHash('md5').update(bytes).digest('base64'), forbidOverwrite: true, cacheControl: 'private, max-age=3600' });
        const response = await fetch(client.getPreSignedUrl({ bucket, key, method: 'GET', expires: 300 }), { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== sha(bytes)) throw new Error(`Cloud verification failed: ${photo.id}`);
        objects.push({ id: photo.id, url: photoUrl(photo.id), bytes: bytes.length, sha256: sha(bytes), created: !exists });
        // Durable per-object checkpoint: retries verify and reuse, never overwrite or blindly delete cloud content.
        report.objects = objects; await writeFile(path.join(reportDirectory, 'import-private.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      }
      for (const id of new Set(manifest.products.flatMap(p => p.photos).filter(id => !newPhotos.has(id)))) await client.headObject({ bucket, key: photoKey(id) });
      phase = 'database';
      const removed = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(261118)`;
        const deleted: string[] = [];
        if (cleanup) {
          const candidates = await tx.product.findMany({ where: { shop_id: DEFAULT_SHOP_ID, status: 'draft' }, include: { skus: { include: { _count: { select: { cart_items: true, order_items: true } } } } } });
          const history = JSON.stringify(await tx.message.findMany({ select: { product_context: true, product_cards: true } }));
          for (const p of candidates) {
            const images = p.image_urls as string[];
            const knownBrokenTest = /^manage_[0-9a-f]{8}_product_\d+$/.test(p.name) && images.length === 8 && images.every((u, i) => u === `/demo-media/example-${i}.jpg`);
            if (!knownBrokenTest || p.skus.some(s => s._count.cart_items || s._count.order_items || history.includes(s.id)) || history.includes(p.id)) continue;
            await tx.skuAttributeValue.deleteMany({ where: { sku_id: { in: p.skus.map(s => s.id) } } });
            await tx.productTag.deleteMany({ where: { product_id: p.id } });
            await tx.sku.deleteMany({ where: { product_id: p.id } }); await tx.product.delete({ where: { id: p.id } }); deleted.push(p.name);
          }
          const unused = await tx.attributeDefinition.deleteMany({ where: { shop_id: DEFAULT_SHOP_ID, name: { startsWith: 'e2e_' }, code: { startsWith: 'attr_' }, values: { none: {} } } });
          report.deletedUnusedTestAttributes = unused.count;
        }
        for (const [i, c] of manifest.categories.entries()) {
          const row = await tx.category.upsert({ where: { shop_id_name: { shop_id: DEFAULT_SHOP_ID, name: c.name } }, update: {}, create: { id: stable(50000 + i), shop_id: DEFAULT_SHOP_ID, name: c.name, description: c.description, sort_order: 20 + i } });
          if (!row.description) await tx.category.update({ where: { id: row.id }, data: { description: c.description } }); categoryIds.set(c.name, row.id);
        }
        for (const [i, t] of manifest.tags.entries()) {
          const matches = await tx.tag.findMany({ where: { shop_id: DEFAULT_SHOP_ID, name: t.name } });
          if (matches.length > 1) throw new Error('Ambiguous existing tag; review required');
          const row = matches[0] ?? await tx.tag.create({ data: { id: stable(40000 + i), shop_id: DEFAULT_SHOP_ID, name: t.name, description: t.description, group_name: t.group, sort_order: 20 + i } });
          if (!row.description) await tx.tag.update({ where: { id: row.id }, data: { description: t.description } }); tagIds.set(t.name, row.id);
        }
        for (const [i, a] of manifest.attributes.entries()) {
          let d = await tx.attributeDefinition.findUnique({ where: { shop_id_code: { shop_id: DEFAULT_SHOP_ID, code: a.code } } });
          if (d && (d.data_type !== a.type || d.unit !== a.unit)) throw new Error('Existing attribute has incompatible type');
          if (!d) d = await tx.attributeDefinition.create({ data: { id: stable(30000 + i), shop_id: DEFAULT_SHOP_ID, code: a.code, name: a.name, data_type: a.type, unit: a.unit, options: a.options ?? Prisma.DbNull, sort_order: 30 + i, is_filterable: a.code !== 'care' } });
          else if (a.type === 'enum') {
            const options = [...new Set([...(d.options as string[]), ...a.options!])];
            if (options.length > 50) throw new Error('Enum option limit exceeded');
            if (JSON.stringify(options) !== JSON.stringify(d.options)) d = await tx.attributeDefinition.update({ where: { id: d.id }, data: { options } });
          }
          definitions.set(a.code, { ...a, id: d.id });
        }
        for (const p of manifest.products) {
          const previous = originals.find(x => x.id === p.id);
          const data = { name: p.name, description: p.description, category_id: categoryIds.get(p.category)!, image_urls: p.photos.map(photoUrl), status: 'active' };
          if (!previous) await tx.product.create({ data: { id: p.id, shop_id: DEFAULT_SHOP_ID, ...data } });
          else if (enrich && (previous.description !== data.description || previous.category_id !== data.category_id || JSON.stringify(previous.image_urls) !== JSON.stringify(data.image_urls))) {
            const changed = await tx.product.updateMany({ where: { id: p.id, updated_at: previous.updated_at }, data });
            if (changed.count !== 1) throw new Error('Product changed during import; retry after review');
          }
          for (const tag of p.tags) {
            const key = { product_id: p.id, tag_id: tagIds.get(tag)! };
            await tx.productTag.upsert({ where: { product_id_tag_id: key }, update: {}, create: key });
          }
          for (const s of p.skus) {
            const previousSku = existingSkus.find(x => x.id === s.id);
            if (!previousSku) await tx.sku.create({ data: { id: s.id, product_id: p.id, sku_code: s.code, name: s.name, price: s.price, stock_quantity: s.stock } });
            else if (enrich && s.existing && previousSku.name !== s.name) await tx.sku.update({ where: { id: s.id }, data: { name: s.name } });
            for (const [code, value] of Object.entries(s.attributes)) {
              const def = definitions.get(code)!, key = { sku_id: s.id, attribute_definition_id: def.id };
              const data = { text_value: null as string | null, number_value: null as string | null, boolean_value: null as boolean | null };
              if (def.type === 'number') data.number_value = String(value);
              else if (def.type === 'boolean') data.boolean_value = value as boolean;
              else data.text_value = String(value);
              await tx.skuAttributeValue.upsert({ where: { sku_id_attribute_definition_id: key }, update: {}, create: { ...key, ...data } });
            }
          }
        }
        return deleted;
      }, { timeout: 60000, isolationLevel: 'Serializable' });
      report.deletedProducts = removed;
      report.protectedBusinessDataUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(await protectedDigests());
      report.originalPricesAndStockUnchanged = (await db.sku.findMany({ where: { id: { in: existingSkus.map(s => s.id) } } })).every(s => { const old = existingSkus.find(x => x.id === s.id)!; return old.price.eq(s.price) && old.stock_quantity === s.stock_quantity && old.is_active === s.is_active; });
      if (!report.protectedBusinessDataUnchanged || !report.originalPricesAndStockUnchanged) throw new Error('Protected data changed; inspect backup and report');
      phase = 'complete'; report.phase = phase; await writeFile(path.join(reportDirectory, 'import-private.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ phase, products: report.products, skus: report.skus, createdProducts: report.newProducts, createdSkus: report.newSkus, deletedTests: removed.length, verifiedPhotos: objects.length, protectedBusinessDataUnchanged: report.protectedBusinessDataUnchanged, originalPricesAndStockUnchanged: report.originalPricesAndStockUnchanged }));
    }
  }
} catch (error) {
  // SDK errors and signed URLs must never reach console/logs.
  const code = (error as { code?: unknown })?.code;
  console.error(JSON.stringify({ phase, errorType: error instanceof Error ? error.name : 'Error', ...(typeof code === 'string' && /^P\d{4}$/.test(code) ? { code } : {}), error: 'Catalogue operation failed; retained backup/cache/checkpoint. Inspect the current phase safely.' })); process.exitCode = 1;
} finally { await db.$disconnect(); }

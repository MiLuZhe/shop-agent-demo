import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createDatabase } from '../packages/database/src/index.ts';
import { demoProductImages } from '../packages/database/prisma/demo-images.ts';
import { createTosClient, imageFormat, imageKey, legacyKey, managedImagePattern } from '../apps/shop-api/src/catalog/image-store.ts';

const root = fileURLToPath(new URL('../', import.meta.url)), run = promisify(execFile);
const reportPath = path.join(root, 'docs/验收记录/TOS商品图片迁移.json');
const args = process.argv.slice(2), cleanup = args.includes('--cleanup'), apply = args.includes('--apply');
const sourceDir = args.includes('--source-dir') ? path.resolve(args[args.indexOf('--source-dir') + 1]!) : '/tmp/shop-tos-photos-20261116';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
interface Entry { source: string; key: string; url: string; sha256: string; bytes: number; cloud_verified: boolean; versionId?: string; local_deleted?: boolean }
interface Report { executed_at: string; phase: string; bucket: string; backup_directory: string; objects: Entry[]; orphan_files: Array<{ source: string; sha256: string; local_deleted?: boolean }>; products: Array<{ id: string; name: string; image_count: number; updated: boolean }>; other_business_data_unchanged: boolean; live_images_checked?: number; cleanup_completed?: boolean }
const db = createDatabase();
const collectStrings = (value: unknown, into: Set<string>) => {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, into);
};
async function references() {
  const refs = new Set<string>();
  for (const p of await db.product.findMany({ select: { image_urls: true } })) collectStrings(p.image_urls, refs);
  for (const m of await db.message.findMany({ select: { product_context: true, product_cards: true } })) { collectStrings(m.product_context, refs); collectStrings(m.product_cards, refs); }
  return refs;
}
async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesBelow(path.join(directory, entry.name)) : entry.isFile() ? [path.join(directory, entry.name)] : []))).flat();
}
async function businessDigests() {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  const digests: Record<string, string> = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table identifier');
    const value = tablename === 'products' ? "to_jsonb(t) - 'image_urls' - 'updated_at'" : 'to_jsonb(t)';
    const rows = await db.$queryRawUnsafe<Array<{ digest: string }>>(`SELECT md5(coalesce(string_agg((${value})::text,'' ORDER BY (${value})::text),'')) AS digest FROM "${tablename}" t`);
    digests[tablename] = rows[0]!.digest;
  }
  return digests;
}
async function save(report: Report) { await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
async function main() {
  if (!apply && !cleanup) {
    console.log('Use --apply to back up, upload, verify and update product galleries; use --cleanup only after app verification.');
    return;
  }
  const { bucket, client } = createTosClient();
  async function cloudBytes(key: string) {
    const url = client.getPreSignedUrl({ bucket, key, method: 'GET', expires: 300 });
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error('Cloud verification failed');
    return Buffer.from(await response.arrayBuffer());
  }
  if (cleanup) {
    const report: Report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (!report.other_business_data_unchanged || !report.objects.length || report.bucket !== bucket || report.objects.some(x => !x.cloud_verified)) throw new Error('Incomplete migration; cleanup refused');
    if (!(await stat(path.join(report.backup_directory, 'media.tar.gz'))).size) throw new Error('Backup missing; cleanup refused');
    let checked = 0;
    for (const p of await db.product.findMany({ where: { status: 'active', shop: { status: 'active' }, skus: { some: { is_active: true } } }, select: { image_urls: true } })) {
      if (!Array.isArray(p.image_urls) || !p.image_urls.length) throw new Error('Active product has no gallery; cleanup refused');
      for (const value of p.image_urls) {
        if (typeof value !== 'string') throw new Error('Invalid picture reference');
        const entry = report.objects.find(x => x.url === value);
        if (!entry) throw new Error('Unverified product picture; cleanup refused');
        const response = await fetch(`http://127.0.0.1:5173${value}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        const location = response.headers.get('location');
        if (response.status !== 302 || !location || new URL(location).hostname !== `${bucket}.${process.env.TOS_ENDPOINT}` || new URL(location).protocol !== 'https:') throw new Error('Application cloud redirect failed; cleanup refused');
        const picture = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!picture.ok || sha(Buffer.from(await picture.arrayBuffer())) !== entry.sha256) throw new Error('Application picture mismatch; cleanup refused');
        checked++;
      }
    }
    // Verify every archived source again before deleting anything.
    const refs = await references();
    for (const entry of report.objects) {
      if (sha(await cloudBytes(entry.key)) !== entry.sha256) throw new Error('Cloud source mismatch; cleanup refused');
      if (entry.local_deleted) continue;
      const p = path.resolve(root, entry.source);
      if (!p.startsWith(path.join(root, 'apps/web/public/demo-media') + path.sep) && !p.startsWith(path.join(root, 'apps/shop-api/data/uploads') + path.sep)) continue;
      if (sha(await readFile(p)) !== entry.sha256) throw new Error('Local source changed; cleanup refused');
    }
    for (const entry of report.orphan_files) {
      if (entry.local_deleted) continue;
      if (!entry.source.startsWith('apps/shop-api/data/uploads/')) throw new Error('Invalid orphan path; cleanup refused');
      const rel = entry.source.replace(/^apps\/shop-api\/data\/uploads\//, '');
      if (!managedImagePattern.test(`/api/uploads/${rel}`)) throw new Error('Invalid orphan filename; cleanup refused');
      if (refs.has(`/api/uploads/${rel}`) || sha(await readFile(path.join(root, entry.source))) !== entry.sha256) throw new Error('Orphan source changed or is now referenced; cleanup refused');
    }
    for (const entry of report.objects) {
      const p = path.resolve(root, entry.source);
      if (!entry.local_deleted && (p.startsWith(path.join(root, 'apps/web/public/demo-media') + path.sep) || p.startsWith(path.join(root, 'apps/shop-api/data/uploads') + path.sep))) { await unlink(p); entry.local_deleted = true; }
    }
    for (const entry of report.orphan_files) if (!entry.local_deleted) { await unlink(path.join(root, entry.source)); entry.local_deleted = true; }
    report.live_images_checked = checked; report.cleanup_completed = true; report.phase = 'verified_and_local_media_cleaned'; await save(report);
    console.log(JSON.stringify({ active_product_images_checked: checked, cloud_objects_verified: report.objects.length, local_media_cleaned: true, backup_directory: report.backup_directory }));
    return;
  }
  const backup = path.join(homedir(), '.local/share/shop-agent-demo/backups', `tos-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(backup, { recursive: true, mode: 0o700 }); await chmod(backup, 0o700);
  const dump = await run('docker', ['compose', 'exec', '-T', 'postgres', 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  await writeFile(path.join(backup, 'database.dump'), dump.stdout, { mode: 0o600 });
  const baseline = await businessDigests(), refs = await references();
  const originals = [...await filesBelow(path.join(root, 'apps/web/public/demo-media')), ...await filesBelow(path.join(root, 'apps/shop-api/data/uploads'))];
  if (originals.length) {
    await run('tar', ['-czf', path.join(backup, 'media.tar.gz'), '--', ...originals.map(p => path.relative(root, p))], { cwd: root });
    await chmod(path.join(backup, 'media.tar.gz'), 0o600);
  }
  const products = await db.product.findMany({ where: { status: 'active', shop: { status: 'active' }, skus: { some: { is_active: true } } }, select: { id: true, name: true, image_urls: true, updated_at: true } });
  await writeFile(path.join(backup, 'original-product-galleries.json'), JSON.stringify(products, null, 2), { mode: 0o600 });
  const report: Report = { executed_at: new Date().toISOString(), phase: 'uploading', bucket, backup_directory: backup, objects: [], orphan_files: [], products: [], other_business_data_unchanged: false };
  const plans = new Map<string, { source: string; url: string; key: string }>();
  const license = JSON.parse(await readFile(path.join(root, 'docs/商品图片素材清单.json'), 'utf8')) as { photos: Array<{ id: number }> };
  for (const photo of license.photos) {
    const filename = `pexels-${photo.id}.jpg`, existing = path.join(root, 'apps/web/public/demo-media', filename), downloaded = path.join(sourceDir, filename);
    let source = existing;
    if (!await stat(existing).then(() => true, () => false)) {
      source = downloaded;
      if (!await stat(source).then(() => true, () => false)) {
        await mkdir(sourceDir, { recursive: true });
        await run('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '45', `https://images.pexels.com/photos/${photo.id}/pexels-photo-${photo.id}.jpeg?auto=compress&cs=tinysrgb&w=1100&q=80`, '-o', source]);
      }
    }
    plans.set(legacyKey(filename), { source, url: `/demo-media/${filename}`, key: legacyKey(filename) });
  }
  for (const source of originals.filter(p => p.includes('/data/uploads/'))) {
    const relative = path.relative(path.join(root, 'apps/shop-api/data/uploads'), source).replaceAll(path.sep, '/');
    const url = `/api/uploads/${relative}`, managed = managedImagePattern.exec(url), bytes = await readFile(source);
    if (!managed) throw new Error('Unexpected upload path; migration stopped');
    if (refs.has(url)) plans.set(url, { source, url, key: imageKey(managed[1]!, managed[2]!) });
    else report.orphan_files.push({ source: path.relative(root, source), sha256: sha(bytes) });
  }
  await save(report);
  for (const plan of plans.values()) {
    const bytes = await readFile(plan.source), digest = sha(bytes), ext = imageFormat(bytes);
    if (!ext || bytes.length > 4 * 1024 * 1024) throw new Error('Invalid media file');
    let exists = false;
    try { await client.headObject({ bucket, key: plan.key }); exists = true; }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw new Error('Unable to verify existing object'); }
    let versionId: string | undefined;
    if (!exists) {
      const uploaded = await client.putObject({ bucket, key: plan.key, body: bytes, contentType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, contentMD5: createHash('md5').update(bytes).digest('base64'), forbidOverwrite: true, cacheControl: 'private, max-age=3600', meta: { sha256: digest } });
      versionId = uploaded.data['x-tos-version-id'];
    }
    if (sha(await cloudBytes(plan.key)) !== digest) throw new Error('Cloud content differs; no local file deleted');
    report.objects.push({ source: path.relative(root, plan.source), key: plan.key, url: plan.url, bytes: bytes.length, sha256: digest, cloud_verified: true, ...(versionId ? { versionId } : {}) });
    await save(report);
  }
  await db.$transaction(async tx => {
    for (const product of products) {
      const preset = demoProductImages.find(x => x.id === product.id && x.name === product.name);
      const current = product.image_urls as string[];
      const oldCoffee = product.id.endsWith('000000000107') && JSON.stringify(current) === JSON.stringify(['/demo-media/pexels-2832062.jpg','/demo-media/pexels-15653319.jpg','/demo-media/pexels-11763619.jpg']);
      const next = !current.length || oldCoffee ? preset?.imageUrls : current;
      if (!next?.length || next.length > 8 || next.some(url => !report.objects.some(x => x.url === url))) throw new Error('Active product lacks a verified image assignment');
      const updated = JSON.stringify(current) !== JSON.stringify(next);
      if (updated) {
        const changed = await tx.product.updateMany({ where: { id: product.id, updated_at: product.updated_at }, data: { image_urls: next } });
        if (changed.count !== 1) throw new Error('Product edited concurrently; migration rolled back');
      }
      report.products.push({ id: product.id, name: product.name, image_count: next.length, updated });
    }
  });
  report.other_business_data_unchanged = JSON.stringify(baseline) === JSON.stringify(await businessDigests());
  report.phase = 'uploaded_and_galleries_updated'; await save(report);
  if (!report.other_business_data_unchanged) throw new Error('Other business data changed; local cleanup prohibited');
  console.log(JSON.stringify({ active_products: report.products.length, updated_galleries: report.products.filter(x => x.updated).length, cloud_objects: report.objects.length, bytes: report.objects.reduce((sum, x) => sum + x.bytes, 0), orphan_local_files: report.orphan_files.length, other_business_data_unchanged: true, backup_directory: backup }));
}
try { await main(); }
catch (error) {
  // Do not serialize SDK errors, request configs, signed URLs, credentials, or raw SQL.
  const safe = error instanceof Error && !('config' in error) && !('requestId' in error) && !error.message.includes('http') && !error.message.includes('Tos') ? error.message : 'Media migration failed; local files retained. Inspect the sanitized manifest.';
  console.error(safe); process.exitCode = 1;
} finally { await db.$disconnect(); }

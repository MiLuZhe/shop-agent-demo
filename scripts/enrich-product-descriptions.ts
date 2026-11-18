import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createDatabase, type Prisma } from '../packages/database/src/index.ts';
import { DEFAULT_SHOP_ID } from '../packages/contracts/src/index.ts';

// A description-only operation: never import images, reset stock/prices or seed.
const manifest = z.object({ version: z.string(), products: z.array(z.object({ id: z.uuid(), name: z.string(), description: z.string().trim().min(1).max(2000) })) })
  .parse(JSON.parse(await readFile(new URL('./data/demo-catalog-20261118.json', import.meta.url), 'utf8')));
const apply = process.argv.includes('--apply'), db = createDatabase();
const tables = ['users', 'account_names', 'saved_addresses', 'shops', 'shop_members', 'categories', 'products', 'product_tags', 'tags', 'skus', 'attribute_definitions', 'sku_attribute_values', 'cart_items', 'orders', 'order_items', 'chat_channels', 'chat_read_states', 'conversations', 'messages', 'inquiries'];
async function digests(tx: Prisma.TransactionClient) {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const row = table === 'products' ? "to_jsonb(t)-'description'-'updated_at'" : 'to_jsonb(t)';
    const result = await tx.$queryRawUnsafe<Array<{ digest: string }>>(`SELECT md5(coalesce(string_agg((${row})::text,'' ORDER BY (${row})::text),'')) AS digest FROM "${table}" t`);
    out[table] = result[0]!.digest;
  }
  return out;
}
try {
  if (process.env.NODE_ENV === 'production') throw new Error('This catalogue operation is for local development only');
  const rows = await db.product.findMany({ where: { id: { in: manifest.products.map(p => p.id) } } });
  if (rows.length !== manifest.products.length || rows.some(p => p.shop_id !== DEFAULT_SHOP_ID || p.status !== 'active' || p.name !== manifest.products.find(x => x.id === p.id)?.name)) throw new Error('Catalogue identity/status changed; review before updating');
  const changes = manifest.products.filter(p => rows.find(row => row.id === p.id)!.description !== p.description);
  if (!apply) console.log(JSON.stringify({ mode: 'read-only plan', version: manifest.version, products: rows.length, changes: changes.length }));
  else {
    const directory = path.join(homedir(), '.local/share/shop-agent-demo/backups', `descriptions-${new Date().toISOString().replaceAll(':', '-')}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    const { stdout } = await promisify(execFile)('docker', ['compose', 'exec', '-T', 'postgres', 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$1" -Fc', 'sh', database], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    await writeFile(path.join(directory, 'database.dump'), stdout, { mode: 0o600 });
    await chmod(path.join(directory, 'database.dump'), 0o600);
    await writeFile(path.join(directory, 'descriptions-before.json'), JSON.stringify(rows.map(p => ({ id: p.id, name: p.name, description: p.description, updatedAt: p.updated_at })), null, 2), { mode: 0o600 });
    const report = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(261118)`;
      const before = await digests(tx);
      for (const p of changes) {
        const original = rows.find(row => row.id === p.id)!;
        const result = await tx.product.updateMany({ where: { id: p.id, shop_id: DEFAULT_SHOP_ID, updated_at: original.updated_at, description: original.description }, data: { description: p.description } });
        if (result.count !== 1) throw new Error('Product edited during update; retry after review');
      }
      if (JSON.stringify(before) !== JSON.stringify(await digests(tx))) throw new Error('Unexpected non-description change; transaction rolled back');
      return { completedAt: new Date().toISOString(), version: manifest.version, products: rows.length, updatedDescriptions: changes.length, otherDataUnchanged: true, cloudRequests: 0 };
    }, { isolationLevel: 'Serializable', timeout: 20000 });
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
  }
} catch (error) {
  // Database/connection errors can include secrets. Keep CLI output redacted.
  console.error(JSON.stringify({ errorType: error instanceof Error ? error.name : 'Error', error: 'Description update failed; existing data/backup retained. Review catalogue identities and retry.' }));
  process.exitCode = 1;
} finally { await db.$disconnect(); }

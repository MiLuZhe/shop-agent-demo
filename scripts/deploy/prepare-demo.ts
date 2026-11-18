import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import { DEFAULT_SHOP_ID } from '../../packages/contracts/src/index.ts';

const run = promisify(execFile), work = path.join(homedir(), '.local/share/shop-agent-demo/verification/showcase-deploy-20261118');
const releaseDatabase = 'shop_release_20261118';
const source = new URL(process.env.DATABASE_URL!);
if (source.hostname !== '127.0.0.1' || source.pathname !== '/shop_agent_demo') throw new Error('Expected the original local database as source');
await mkdir(work, { recursive: true, mode: 0o700 });
// Never recreate a database or credentials on a repeat invocation.
const dumpPath = path.join(work, 'release/demo.dump'), credentialsPath = path.join(work, 'demo-accounts.json');
try { await readFile(dumpPath); throw new Error('Release database already prepared; reuse it rather than resetting data'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const original = await run('docker', ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'shop_agent', '-d', 'shop_agent_demo', '-Fc'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const backup = path.join(homedir(), '.local/share/shop-agent-demo/backups/showcase-deploy-20261118/database.dump');
await writeFile(backup, original.stdout, { mode: 0o600 });
await run('docker', ['compose', 'exec', '-T', 'postgres', 'createdb', '-U', 'shop_agent', releaseDatabase]);
// execFile has no stdin argument; use an explicit child to stream the private dump.
const { spawn } = await import('node:child_process');
await new Promise<void>((resolve, reject) => {
  const child = spawn('docker', ['compose', 'exec', '-T', 'postgres', 'pg_restore', '-U', 'shop_agent', '-d', releaseDatabase, '--no-owner', '--no-privileges'], { stdio: ['pipe', 'ignore', 'pipe'] });
  child.stderr.resume(); child.stdin.end(original.stdout);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error('Private database copy failed'))); child.on('error', reject);
});
const target = new URL(source); target.pathname = '/' + releaseDatabase;
const db = createDatabase(target.toString());
const accounts = [
  { username: 'buyer_demo', displayName: '演示买家', kind: 'customer', role: null },
  { username: 'staff_demo', displayName: '演示店员', kind: 'work', role: 'staff' },
  { username: 'seller_demo', displayName: '演示店长', kind: 'work', role: 'owner' },
].map(a => ({ ...a, password: 'Demo-' + randomBytes(15).toString('base64url') + '9!', id: randomUUID() }));
try {
  await db.$transaction(async tx => {
    // Explicit table list and isolated database name: never run against source.
    await tx.$executeRawUnsafe('TRUNCATE inquiries,messages,conversations,chat_read_states,chat_channels,order_items,orders,cart_items,saved_addresses,account_names,shop_members,users CASCADE');
    const other = await tx.shop.count({ where: { id: { not: DEFAULT_SHOP_ID } } });
    if (other) throw new Error('Review additional shops before preparing a release');
    for (const a of accounts) {
      await tx.user.create({ data: { id: a.id, username: a.username, display_name: a.displayName, account_kind: a.kind, password_hash: await hashPassword(a.password) } });
      if (a.role) await tx.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: a.id, role: a.role } });
    }
    const products = await tx.product.count({ where: { shop_id: DEFAULT_SHOP_ID, status: 'active' } });
    const skus = await tx.sku.count({ where: { is_active: true, product: { shop_id: DEFAULT_SHOP_ID, status: 'active' } } });
    if (products !== 30 || skus !== 90) throw new Error('Unexpected catalogue counts');
  }, { timeout: 20000 });
  const dump = await run('docker', ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'shop_agent', '-d', releaseDatabase, '-Fc', '--no-owner', '--no-privileges'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  await mkdir(path.dirname(dumpPath), { recursive: true, mode: 0o700 });
  await writeFile(dumpPath, dump.stdout, { mode: 0o600 }); await chmod(dumpPath, 0o600);
  await writeFile(credentialsPath, JSON.stringify({ createdAt: new Date().toISOString(), accounts: accounts.map(({ id, ...a }) => a) }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ database: releaseDatabase, accounts: 3, products: 30, activeSkus: 90, copiedOrders: 0, copiedAddresses: 0, copiedMessages: 0, originalDataModified: false }));
} finally { await db.$disconnect(); }

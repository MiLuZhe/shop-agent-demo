import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createDatabase } from '../packages/database/src/index.ts';
process.loadEnvFile(new URL('../.env', import.meta.url));
const run = promisify(execFile), main = createDatabase();
const name = `work_migration_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const url = new URL(process.env.DATABASE_URL); url.pathname = `/${name}`;
const isolated = createDatabase(url.toString()), env = { ...process.env, DATABASE_URL: url.toString() };
const dump = process.argv[2];
if (!dump || !/^\/tmp\/[a-zA-Z0-9_.-]+\.dump$/.test(dump)) throw new Error('Pass the private pre-migration dump path inside the postgres container');
async function snapshot(db) {
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename`;
  assert.equal(tables.length, 19);
  const result = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    const omit = tablename === 'users' ? " - 'account_kind'" : tablename === 'messages' ? " - 'product_context'" : '';
    const [row] = await db.$queryRawUnsafe(`SELECT count(*)::text AS count, coalesce(md5(string_agg(row::text,'' ORDER BY row::text)),md5('')) AS digest FROM (SELECT to_jsonb(t)${omit} AS row FROM "${tablename}" t) rows`);
    result[tablename] = row;
  }
  return result;
}
let created = false;
try {
  await main.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true;
  await run('docker', ['compose', 'exec', '-T', 'postgres', 'pg_restore', '-U', 'shop_agent', '-d', name, '--no-owner', dump]);
  const baseline = await snapshot(isolated);
  // The real database must retain all original fields across all 19 tables.
  assert.deepEqual(await snapshot(main), baseline);
  const member = randomUUID(), buyer = randomUUID(), shop = randomUUID();
  for (const id of [member, buyer]) await isolated.$executeRaw`INSERT INTO users(id,username,display_name) VALUES(${id}::uuid,${`legacy_${id.replaceAll('-', '')}`},'迁移测试')`;
  await isolated.$executeRaw`INSERT INTO shops(id,slug,name,status) VALUES(${shop}::uuid,${`legacy_${shop}`},'停用店铺','disabled')`;
  await isolated.$executeRaw`INSERT INTO shop_members(id,shop_id,user_id,role,status) VALUES(${randomUUID()}::uuid,${shop}::uuid,${member}::uuid,'staff','disabled')`;
  const before = await snapshot(isolated);
  await run('pnpm', ['db:migrate'], { env });
  assert.deepEqual(await snapshot(isolated), before);
  assert.equal((await isolated.user.findUniqueOrThrow({ where: { id: member } })).account_kind, 'work');
  assert.equal((await isolated.user.findUniqueOrThrow({ where: { id: buyer } })).account_kind, 'customer');
  const wrong = await isolated.$queryRaw`SELECT count(*)::int AS count FROM users u WHERE account_kind <> CASE WHEN platform_role='admin' OR EXISTS(SELECT 1 FROM shop_members WHERE user_id=u.id) THEN 'work' ELSE 'customer' END`;
  assert.equal(wrong[0].count, 0);
  await isolated.shopMember.deleteMany({ where: { user_id: member } });
  assert.equal((await isolated.user.findUniqueOrThrow({ where: { id: member } })).account_kind, 'work');
  await assert.rejects(isolated.user.update({ where: { id: member }, data: { account_kind: 'customer' } }), /work account cannot become/);
  await run('pnpm', ['db:migrate'], { env });
  console.log('All 19 original tables preserved in real database and isolated restore; disabled membership classification, work-account permanence and repeat deployment passed.');
} finally {
  await isolated.$disconnect();
  if (created) { await main.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${name} AND pid<>pg_backend_pid()`; await main.$executeRawUnsafe(`DROP DATABASE "${name}"`); }
  await main.$disconnect();
}

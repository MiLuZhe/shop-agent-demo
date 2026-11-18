import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createDatabase } from '../packages/database/src/index.ts';
process.loadEnvFile(new URL('../.env', import.meta.url));
const dump = process.argv[2];
if (!dump || !/^\/tmp\/[a-zA-Z0-9_.-]+\.dump$/.test(dump)) throw new Error('Pass the pre-product-chat dump path inside the postgres container');
const run = promisify(execFile), main = createDatabase(), name = `chat_product_migration_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const url = new URL(process.env.DATABASE_URL); url.pathname = `/${name}`;
const isolated = createDatabase(url.toString()), env = { ...process.env, DATABASE_URL: url.toString() };
async function snapshot(db) {
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename`;
  assert.equal(tables.length, 19); const result = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    const omit = tablename === 'messages' ? " - 'product_context'" : '';
    const [row] = await db.$queryRawUnsafe(`SELECT count(*)::text AS count,coalesce(md5(string_agg(row::text,'' ORDER BY row::text)),md5('')) AS digest FROM (SELECT to_jsonb(t)${omit} AS row FROM "${tablename}" t) rows`);
    result[tablename] = row;
  }
  return result;
}
let created = false;
try {
  await main.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true;
  await run('docker', ['compose', 'exec', '-T', 'postgres', 'pg_restore', '-U', 'shop_agent', '-d', name, '--no-owner', dump]);
  assert.deepEqual(await snapshot(main), await snapshot(isolated));
  const buyer = randomUUID(), shop = randomUUID(), channel = randomUUID(), round = randomUUID(), message = randomUUID();
  await isolated.$executeRaw`INSERT INTO users(id,username,display_name) VALUES(${buyer}::uuid,${`legacy_${buyer.replaceAll('-', '')}`},'旧消息买家')`;
  await isolated.$executeRaw`INSERT INTO shops(id,slug,name) VALUES(${shop}::uuid,${`legacy_${shop}`},'旧消息店铺')`;
  await isolated.$executeRaw`INSERT INTO chat_channels(id,shop_id,buyer_id,next_sequence) VALUES(${channel}::uuid,${shop}::uuid,${buyer}::uuid,1)`;
  await isolated.$executeRaw`INSERT INTO conversations(id,channel_id,shop_id,buyer_id,status) VALUES(${round}::uuid,${channel}::uuid,${shop}::uuid,${buyer}::uuid,'waiting_seller')`;
  await isolated.$executeRaw`INSERT INTO messages(id,channel_id,conversation_id,sequence,sender_type,sender_user_id,content) VALUES(${message}::uuid,${channel}::uuid,${round}::uuid,1,'buyer',${buyer}::uuid,'已有历史消息')`;
  const before = await snapshot(isolated);
  await run('pnpm', ['db:migrate'], { env });
  assert.deepEqual(await snapshot(isolated), before);
  const migrated = await isolated.message.findUniqueOrThrow({ where: { id: message } });
  assert.equal(migrated.content, '已有历史消息'); assert.equal(migrated.product_context, null);
  await assert.rejects(isolated.message.create({ data: { channel_id: channel, conversation_id: round, sequence: 2, sender_type: 'system', content: '伪造商品事件', product_context: { id: randomUUID() } } }), /messages_product_context_check/);
  await run('pnpm', ['db:migrate'], { env });
  assert.deepEqual(await snapshot(isolated), before);
  console.log('Real database and isolated restore preserve all original fields in 19 tables; legacy messages, product-context constraint and repeated migration passed.');
} finally {
  await isolated.$disconnect();
  if (created) { await main.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${name} AND pid<>pg_backend_pid()`; await main.$executeRawUnsafe(`DROP DATABASE "${name}"`); }
  await main.$disconnect();
}

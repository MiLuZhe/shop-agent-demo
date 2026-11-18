import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createDatabase } from '../packages/database/src/index.ts';
process.loadEnvFile(new URL('../.env', import.meta.url));
const [mode, file] = process.argv.slice(2);
if (!['before','after'].includes(mode) || !file) throw new Error('Usage: verify-chat-migration.mjs before|after snapshot.json');
const db = createDatabase();
const omit = { users: ['account_kind'], conversations: ['channel_id','ended_at'], messages: ['channel_id','sequence','client_message_id','event_data','product_context'] };
try {
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_prisma_migrations','chat_channels') ORDER BY tablename`;
  const snapshot = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table name');
    const remove = (omit[tablename] ?? []).map((key) => ` - '${key}'`).join('');
    // Sort by the normalized row itself: account_names has no id column.
    const [row] = await db.$queryRawUnsafe(`SELECT count(*)::text AS count,COALESCE(md5(string_agg(row::text,'' ORDER BY row::text)),md5('')) AS digest FROM (SELECT to_jsonb(t)${remove} AS row FROM "${tablename}" t) rows`);
    snapshot[tablename] = row;
  }
  assert.equal(Object.keys(snapshot).length,18);
  if (mode==='before') { await writeFile(file,JSON.stringify(snapshot),{mode:0o600}); console.log('Original 18-table counts and normalized digests saved privately.'); }
  else {
    assert.deepEqual(snapshot,JSON.parse(await readFile(file,'utf8')));
    console.log('All original 18 tables preserved, including message bodies, senders, credentials and timestamps.');
  }
} finally { await db.$disconnect(); }

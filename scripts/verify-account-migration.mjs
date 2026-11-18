import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createDatabase } from '../packages/database/src/index.ts';
process.loadEnvFile(new URL('../.env', import.meta.url));
const [mode, file] = process.argv.slice(2);
if (!['before','after'].includes(mode) || !file) throw new Error('Usage: node --import tsx scripts/verify-account-migration.mjs before|after snapshot.json');
const tables = ['users','shops','shop_members','categories','products','skus','tags','product_tags','attribute_definitions','sku_attribute_values','conversations','messages','inquiries','cart_items','orders','order_items'];
const db = createDatabase();
try {
  const result = {};
  for (const table of tables) {
    const [row] = await db.$queryRawUnsafe(`SELECT count(*)::text AS count, COALESCE(md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)),md5('')) AS digest FROM "${table}" t`);
    result[table] = row;
  }
  if (mode === 'before') { await writeFile(file, JSON.stringify(result), { mode: 0o600 }); console.log('Original 16-table counts and digests saved privately.'); }
  else {
    const before = JSON.parse(await readFile(file, 'utf8'));
    for (const table of tables) assert.ok(JSON.stringify(before[table]) === JSON.stringify(result[table]), `Existing ${table} rows changed`);
    const [missing] = await db.$queryRaw`SELECT count(*)::int AS count FROM users u LEFT JOIN account_names n ON n.username=u.username AND n.user_id=u.id AND n.retired_at IS NULL WHERE n.username IS NULL`;
    assert.equal(missing.count, 0);
    console.log('All original 16 tables unchanged, including credentials, ownership and timestamps; account names fully populated.');
  }
} finally { await db.$disconnect(); }

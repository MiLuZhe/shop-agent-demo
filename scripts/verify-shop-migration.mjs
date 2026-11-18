import { readFile, writeFile } from 'node:fs/promises';
import { createDatabase } from '../packages/database/src/index.ts';
process.loadEnvFile(new URL('../.env', import.meta.url));
const [mode, file] = process.argv.slice(2);
if (!['before', 'after'].includes(mode) || !file) throw new Error('Usage: node --import tsx scripts/verify-shop-migration.mjs before|after snapshot.json');
const tables = ['users','categories','products','skus','tags','product_tags','attribute_definitions','sku_attribute_values','conversations','messages','inquiries','cart_items','orders','order_items'];
const db = createDatabase();
try {
  const result = {};
  for (const table of tables) {
    // Table names come exclusively from the hard-coded allowlist above.
    const [row] = await db.$queryRawUnsafe(`SELECT count(*)::text AS count, COALESCE(md5(string_agg((to_jsonb(t)-'shop_id'-'shop_name')::text, '' ORDER BY id)),md5('')) AS digest FROM "${table}" t`);
    result[table] = row;
  }
  if (mode === 'before') { await writeFile(file, JSON.stringify(result), { mode: 0o600 }); console.log('Original 14-table snapshot recorded (counts/digests only).'); }
  else {
    const original = JSON.parse(await readFile(file, 'utf8'));
    for (const table of tables) if (JSON.stringify(original[table]) !== JSON.stringify(result[table])) throw new Error(`Existing business data changed: ${table}`);
    console.log('All original rows, values and timestamps preserved in the 14 legacy tables.');
    const missing = await db.$queryRawUnsafe(`SELECT (SELECT count(*) FROM products WHERE shop_id IS NULL) + (SELECT count(*) FROM orders WHERE shop_id IS NULL OR shop_name IS NULL) AS count`);
    if (Number(missing[0].count) !== 0) throw new Error('Missing ownership backfill');
    console.log('Product/order ownership and historical shop names are populated.');
  }
} finally { await db.$disconnect(); }

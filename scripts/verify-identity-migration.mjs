import { readFile, writeFile } from 'node:fs/promises';
import { createDatabase } from '../packages/database/src/index.ts';
process.loadEnvFile(new URL('../.env', import.meta.url));
const [mode, file] = process.argv.slice(2);
if (!['before','after'].includes(mode) || !file) throw new Error('Usage: node --import tsx scripts/verify-identity-migration.mjs before|after snapshot.json');
const tables = ['users','categories','products','skus','tags','product_tags','attribute_definitions','sku_attribute_values','conversations','messages','inquiries','cart_items','orders','order_items','shops','shop_members'];
const db = createDatabase();
try {
  const result = {};
  for (const table of tables) {
    const expression = table === 'users' ? "to_jsonb(t)-'role'-'platform_role'-'auth_version'" : 'to_jsonb(t)';
    const [row] = await db.$queryRawUnsafe(`SELECT count(*)::text AS count,COALESCE(md5(string_agg((${expression})::text,'' ORDER BY id)),md5('')) AS digest FROM "${table}" t`);
    result[table] = row;
  }
  if (mode === 'before') { await writeFile(file,JSON.stringify(result),{mode:0o600}); console.log('16-table data snapshot recorded; only planned user-role replacement excluded.'); }
  else {
    const before = JSON.parse(await readFile(file,'utf8'));
    for (const table of tables) if (JSON.stringify(before[table])!==JSON.stringify(result[table])) throw new Error(`Unexpected existing data change: ${table}`);
    console.log('Original 16-table rows, timestamps and credentials preserved; only user-role model replaced.');
  }
} finally { await db.$disconnect(); }

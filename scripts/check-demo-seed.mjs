import assert from 'node:assert/strict';
import { DEFAULT_SHOP_ID } from '../packages/contracts/src/common.ts';

const tables = ['users','account_names','shops','shop_members','categories','products','skus','tags','product_tags','attribute_definitions','sku_attribute_values','conversations','messages','inquiries','cart_items','orders','order_items'];
// Used in an isolated database only. Keep credentials in memory and never log rows.
export async function checkDemoSeed(db, seed) {
  async function snapshot() {
    const result = {};
    for (const table of tables) result[table] = (await db.$queryRawUnsafe(`SELECT row_to_json(t)::text AS row FROM "${table}" t`)).map(({ row }) => row);
    return result;
  }
  const before = await snapshot(); await seed(); const first = await snapshot();
  const added = {};
  for (const table of tables) {
    const previous = new Set(before[table]), current = new Set(first[table]);
    assert.ok(before[table].every((row) => current.has(row)), `Seed modified existing ${table} rows`);
    added[table] = first[table].filter((row) => !previous.has(row)).map((row) => JSON.parse(row));
    const seededTables = ['users','shop_members','account_names','products','skus','product_tags','sku_attribute_values'];
    if (!seededTables.includes(table)) assert.equal(added[table].length, 0, `Seed unexpectedly inserted ${table}`);
  }
  const expected = new Map([['manager_demo','manager'], ['staff_demo','staff']]);
  assert.ok(added.users.length <= 2 && added.shop_members.length <= 2, 'Unexpected number of demo additions');
  for (const user of added.users) assert.ok(expected.has(user.username) && user.platform_role === 'user', 'Unexpected demo identity');
  for (const name of added.account_names) assert.ok(added.users.some((user) => user.id === name.user_id && user.username === name.username) && name.retired_at === null, 'Unexpected name reservation');
  for (const member of added.shop_members) {
    const user = first.users.map((row) => JSON.parse(row)).find((row) => row.id === member.user_id);
    assert.ok(user && expected.get(user.username) === member.role && member.shop_id === DEFAULT_SHOP_ID && member.status === 'active', 'Unexpected demo membership');
  }
  const stableId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  assert.deepEqual(added.products.map((row) => row.id).sort(), [106,107,108,109].map(stableId).sort(), 'Unexpected demo products');
  assert.deepEqual(added.skus.map((row) => row.id).sort(), [209,210,211,212].map(stableId).sort(), 'Unexpected demo SKUs');
  assert.equal(added.product_tags.length, 9, 'Unexpected demo product tags');
  assert.equal(added.sku_attribute_values.length, 10, 'Unexpected demo SKU attributes');
  for (const row of added.products) assert.equal(row.shop_id, DEFAULT_SHOP_ID, 'Demo product belongs to another shop');
  for (const row of added.skus) assert.ok(added.products.some((product) => product.id === row.product_id), 'Demo SKU belongs to a non-demo product');
  await seed(); const second = await snapshot();
  for (const table of tables) assert.ok(JSON.stringify([...second[table]].sort()) === JSON.stringify([...first[table]].sort()), `Repeated seed changed ${table}`);
  console.log('Demo seed preserved all existing rows; only missing manager/staff identities added; second run changed nothing.');
}

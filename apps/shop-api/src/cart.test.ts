import { DEFAULT_SHOP_ID } from '@shop/contracts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import { sumCartMoney, type CartItemDto, type CartDto, type CartPreviewDto } from '@shop/contracts';
import { buildApp } from './app.ts';
const db = createDatabase(), app = buildApp(db, false);
const prefix = `cart_${randomUUID().slice(0, 8)}`, users = [randomUUID(), randomUUID(), randomUUID()], productId = randomUUID(), skus = [randomUUID(), randomUUID()];
const cookies: string[] = [];
async function req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path = '', payload?: unknown, cookie = cookies[0]!) {
  return app.inject({ method, url: `/api/cart${path}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { cookie, 'content-type': 'application/json' } }) });
}
async function add(skuId = skus[0]!, quantity = 1, cookie = cookies[0]!) {
  const r = await req('POST', '/items', { skuId, quantity }, cookie); assert.equal(r.statusCode, 201, r.body); return r.json<CartItemDto>();
}
before(async () => {
  const password_hash = await hashPassword('CartTest123!');
  await db.user.createMany({ data: users.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: '购物车测试', password_hash })) });
  await db.product.create({ data: { shop_id: DEFAULT_SHOP_ID, id: productId, name: prefix, status: 'active', skus: { create: skus.map((id, i) => ({ id, sku_code: `${prefix}_${i}`, name: `规格${i}`, price: i ? '0.20' : '0.10', stock_quantity: 2000 })) } } });
  for (let i = 0; i < users.length; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_${i}`, password: 'CartTest123!' } });
    assert.equal(r.statusCode, 200); cookies.push(String(r.headers['set-cookie']).split(';')[0]!);
  }
});
beforeEach(async () => {
  await db.cartItem.deleteMany({ where: { user_id: { in: users } } });
  await db.product.update({ where: { id: productId }, data: { status: 'active' } });
  await db.sku.updateMany({ where: { product_id: productId }, data: { is_active: true, stock_quantity: 2000 } });
  for (let i = 0; i < skus.length; i++) await db.sku.update({ where: { id: skus[i] }, data: { price: i ? '0.20' : '0.10' } });
});
after(async () => {
  try {
    await db.cartItem.deleteMany({ where: { user_id: { in: users } } });
    await db.sku.deleteMany({ where: { product_id: productId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  } finally { await app.close(); }
});
test('all cart routes require login; personal buyers can shop and untrusted origins are rejected', async () => {
  for (const [method, path, payload] of [['GET', '', undefined], ['POST', '/items', {}], ['PUT', `/items/${randomUUID()}`, {}], ['DELETE', `/items/${randomUUID()}`, {}], ['POST', '/preview', {}]] as const) {
    assert.equal((await req(method, path, payload, '')).statusCode, 401);

  }
  await add(skus[0], 1, cookies[2]);
  assert.equal((await req('GET', '', undefined, cookies[2]!)).statusCode, 200);
  const r = await app.inject({ method: 'POST', url: '/api/cart/items', headers: { cookie: cookies[0], origin: 'https://untrusted.example' }, payload: { skuId: skus[0], quantity: 1 } });
  assert.equal(r.statusCode, 403);
});
test('same SKU merges, different SKUs stay separate and cart survives a new session', async () => {
  const first = await add(); const merged = await add(skus[0], 2); await add(skus[1]);
  assert.equal(merged.id, first.id); assert.equal(merged.quantity, 3); assert.equal(merged.subtotal, '0.30');
  const r = await req('GET'); assert.equal(r.statusCode, 200, r.body); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.json<CartDto>().items.length, 2);
  assert.equal((await db.sku.findUniqueOrThrow({ where: { id: skus[0] } })).stock_quantity, 2000);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_0`, password: 'CartTest123!' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  assert.equal((await req('GET', '', undefined, cookie)).json<CartDto>().items.length, 2);
});
test('quantity, identifier and strict input boundaries reject malformed writes without changing data', async () => {
  for (const quantity of [0, -1, 1.2, 1000, '2', null]) assert.equal((await req('POST', '/items', { skuId: skus[0], quantity })).statusCode, 400);
  assert.equal((await req('POST', '/items', { skuId: 'bad', quantity: 1 })).statusCode, 400);
  assert.equal((await req('POST', '/items', { skuId: randomUUID(), quantity: 1 })).statusCode, 404);
  assert.equal((await req('POST', '/items', { skuId: skus[0], quantity: 1, userId: users[1] })).statusCode, 400);
  await add(skus[0], 999); assert.equal((await req('POST', '/items', { skuId: skus[0], quantity: 1 })).statusCode, 409);
  assert.equal((await req('GET')).json<CartDto>().items[0]?.quantity, 999);
});
test('buyer ownership is enforced for reads, edits, deletes and preview', async () => {
  const own = await add(), other = await add(skus[0], 2, cookies[1]);
  assert.equal((await req('GET')).json<CartDto>().items[0]?.id, own.id);
  for (const [method, payload] of [['PUT', { quantity: 4, version: other.version }], ['DELETE', { version: other.version }]] as const)
    assert.equal((await req(method, `/items/${other.id}`, payload)).statusCode, 404);
  assert.equal((await req('POST', '/preview', { itemIds: [own.id, other.id] })).statusCode, 404);
  assert.equal((await db.cartItem.findUniqueOrThrow({ where: { id: other.id } })).quantity, 2);
});
test('versioned quantity updates and deletes reject stale clients and allow removal of invalid goods', async () => {
  const old = await add();
  const updated = await req('PUT', `/items/${old.id}`, { quantity: 3, version: old.version }); assert.equal(updated.statusCode, 200);
  assert.notEqual(updated.json<CartItemDto>().version, old.version);
  assert.equal((await req('PUT', `/items/${old.id}`, { quantity: 4, version: old.version })).statusCode, 409);
  assert.equal((await req('DELETE', `/items/${old.id}`, { version: old.version })).statusCode, 409);
  await db.product.update({ where: { id: productId }, data: { status: 'inactive' } });
  assert.equal((await req('DELETE', `/items/${old.id}`, { version: updated.json<CartItemDto>().version })).statusCode, 200);
  assert.equal((await req('GET')).json<CartDto>().items.length, 0);
});
test('current prices and distinct invalid reasons appear; writes and preview revalidate live availability', async () => {
  const row = await add(skus[0], 5);
  await db.sku.update({ where: { id: skus[0] }, data: { price: '1.23', stock_quantity: 3 } });
  let item = (await req('GET')).json<CartDto>().items[0]!;
  assert.equal(item.price, '1.23'); assert.equal(item.subtotal, '6.15'); assert.match(item.reason!, /库存不足/);
  assert.equal((await req('POST', '/preview', { itemIds: [row.id] })).statusCode, 409);
  assert.equal((await req('POST', '/items', { skuId: skus[0], quantity: 1 })).statusCode, 409);
  assert.equal((await req('PUT', `/items/${row.id}`, { quantity: 2, version: row.version })).statusCode, 200);
  for (const [patch, expected] of [[{ stock_quantity: 0 }, '暂时缺货'], [{ is_active: false }, '规格已停用']] as const) {
    await db.sku.update({ where: { id: skus[0] }, data: patch });
    item = (await req('GET')).json<CartDto>().items[0]!; assert.equal(item.reason, expected); assert.equal(item.available, false);
  }
  await db.product.update({ where: { id: productId }, data: { status: 'draft' } });
  assert.equal((await req('GET')).json<CartDto>().items[0]?.reason, '商品已下架');
});
test('partial preview uses exact money, excludes unselected rows and never creates orders or removes cart rows', async () => {
  const first = await add(skus[0], 3); await add(skus[1], 2);
  const result = await req('POST', '/preview', { itemIds: [first.id] }); assert.equal(result.statusCode, 200);
  const preview = result.json<CartPreviewDto>(); assert.equal(preview.totalAmount, '0.30'); assert.equal(preview.totalQuantity, 3); assert.equal(preview.items.length, 1);
  assert.equal((await req('GET')).json<CartDto>().items.length, 2);
  assert.equal(await db.order.count({ where: { buyer_id: users[0] } }), 0);
  assert.equal((await req('POST', '/preview', { itemIds: [] })).statusCode, 400);
  assert.equal((await req('POST', '/preview', { itemIds: [first.id, first.id] })).statusCode, 400);
  assert.equal(sumCartMoney([{ price: '9999999999.99', quantity: 999 }, { price: '0.10', quantity: 3 }]), '9989999999990.31');
});
test('parallel adds merge without lost increments; stale parallel quantity edits cannot overwrite', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => add()));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  const row = (await req('GET')).json<CartDto>().items[0]!; assert.equal(row.quantity, 6);
  const writes = await Promise.all([7, 8].map((quantity) => req('PUT', `/items/${row.id}`, { quantity, version: row.version })));
  assert.deepEqual(writes.map((r) => r.statusCode).sort(), [200, 409]);
});
test('100 distinct SKU cap permits existing merges but rejects a new row atomically', async () => {
  const extra = Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), product_id: productId, sku_code: `${prefix}_extra_${i}`, name: '容量测试', price: '1.00', stock_quantity: 2000 }));
  await db.sku.createMany({ data: extra });
  await db.cartItem.createMany({ data: extra.map((s) => ({ user_id: users[0]!, sku_id: s.id, quantity: 1 })) });
  assert.equal((await req('POST', '/items', { skuId: skus[0], quantity: 1 })).statusCode, 409);
  await add(extra[0]!.id);
  assert.equal((await req('GET')).json<CartDto>().items.length, 100);
});

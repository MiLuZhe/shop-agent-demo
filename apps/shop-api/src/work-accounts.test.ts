import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword, verifyPassword } from '@shop/database/password';
import { buildApp } from './app.ts';

async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await work(f); } finally { await f.cleanup(); }
}
async function setup() {
  const db = createDatabase(), app = buildApp(db, false, { loginLimit: 200 });
  const prefix = `work_${randomUUID().slice(0, 8)}`, users = Array.from({ length: 6 }, () => randomUUID()), shop = randomUUID(), product = randomUUID(), sku = randomUUID(), cookies: string[] = [];
  const password = 'WorkAccount123!', password_hash = await hashPassword(password);
  await db.user.createMany({ data: users.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: '隔离测试', password_hash, platform_role: i === 4 ? 'admin' : 'user', account_kind: i === 5 ? 'work' : 'customer' })) });
  await db.shop.create({ data: { id: shop, slug: prefix, name: '隔离测试店' } });
  for (const [i, role] of [[1, 'owner'], [2, 'manager'], [3, 'staff']] as const) await db.shopMember.create({ data: { shop_id: shop, user_id: users[i]!, role } });
  await db.product.create({ data: { id: product, shop_id: shop, name: prefix, status: 'active', skus: { create: { id: sku, sku_code: prefix, name: '默认', price: '2.00', stock_quantity: 10 } } } });
  for (let i = 0; i < users.length; i++) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_${i}`, password } });
    assert.equal(response.statusCode, 200); cookies[i] = String(response.headers['set-cookie']).split(';')[0]!;
  }
  const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, user = 0) => app.inject({ method, url: `/api${path}`, headers: { cookie: cookies[user] ?? '', 'x-shop-id': shop }, ...(body === undefined ? {} : { payload: body as object }) });
  const orderBody = () => ({ checkoutKey: randomUUID(), skuId: sku, quantity: 1, unitPrice: '2.00', recipientName: '测试买家', recipientPhone: '13800000000', recipientAddress: '测试省测试市测试地址' });
  return { db, app, users, shop, product, sku, prefix, req, orderBody, cleanup: async () => {
    const owned = await db.user.findMany({ where: { username: { startsWith: prefix } }, select: { id: true } }); const ids = owned.map((u) => u.id);
    const orders = await db.order.findMany({ where: { shop_id: shop }, select: { id: true } });
    await db.orderItem.deleteMany({ where: { order_id: { in: orders.map((o) => o.id) } } }); await db.order.deleteMany({ where: { shop_id: shop } });
    await db.cartItem.deleteMany({ where: { user_id: { in: ids } } }); await db.savedAddress.deleteMany({ where: { user_id: { in: ids } } });
    await db.sku.deleteMany({ where: { product_id: product } }); await db.product.delete({ where: { id: product } });
    await db.category.deleteMany({ where: { shop_id: shop } }); await db.shopMember.deleteMany({ where: { shop_id: shop } }); await db.shop.delete({ where: { id: shop } });
    await db.user.deleteMany({ where: { id: { in: ids } } }); await app.close();
  } };
}

test('every private buyer route rejects work accounts regardless of role, membership or forged headers', async () => fixture(async ({ req, db, users, shop, sku, orderBody }) => {
  const id = randomUUID();
  const routes = [
    ['GET', '/cart'], ['POST', '/cart/items'], ['PUT', `/cart/items/${id}`], ['DELETE', `/cart/items/${id}`], ['POST', '/cart/preview'],
    ['GET', '/orders'], ['GET', `/orders/${id}`], ['POST', '/orders'], ['POST', '/orders/direct'], ['POST', `/orders/${id}/mock-pay`], ['POST', `/orders/${id}/cancel`],
    ['GET', '/account/addresses'], ['POST', '/account/addresses'], ['PUT', `/account/addresses/${id}`], ['DELETE', `/account/addresses/${id}`],
    ['GET', '/chat/channels'], ['GET', `/chat/shops/${shop}`], ['POST', `/chat/shops/${shop}/messages`], ['GET', `/chat/channels/${id}`], ['GET', `/chat/channels/${id}/messages`], ['GET', `/chat/channels/${id}/rounds`],
  ] as const;
  for (const user of [1, 2, 3, 4, 5]) for (const [method, path] of routes) {
    const response = await req(method, path, method === 'GET' ? undefined : {}, user);
    assert.equal(response.statusCode, 403, `${user} ${method} ${path}: ${response.body}`); assert.equal(response.json().error.code, 'BUYER_ONLY');
  }
  assert.equal((await req('POST', '/orders/direct', orderBody())).statusCode, 201);
  assert.equal((await req('POST', '/cart/items', { skuId: sku, quantity: 1 })).statusCode, 201);
  await db.shopMember.deleteMany({ where: { user_id: users[3] } });
  assert.equal((await req('GET', '/cart', undefined, 3)).statusCode, 403);
  assert.equal((await req('GET', '/auth/me', undefined, 3)).json().user.canShop, false);
  assert.equal((await req('GET', '/products')).statusCode, 200);
}));

test('only owners provision dedicated work accounts atomically, without converting customers or granting admin', async () => fixture(async ({ req, db, users, prefix, shop }) => {
  const input = { username: `${prefix}_new`, displayName: '同名职工', password: 'CreatedWork123!', role: 'staff' };
  for (const user of [-1, 0, 2, 3, 4, 5]) assert.equal((await req('POST', '/seller/members/work-accounts', input, user)).statusCode, user < 0 ? 401 : 403);
  for (const patch of [{ role: 'owner' }, { platformRole: 'admin' }, { accountKind: 'customer' }, { password: 'short' }, { displayName: ' ' }]) assert.equal((await req('POST', '/seller/members/work-accounts', { ...input, ...patch }, 1)).statusCode, 400);
  assert.equal((await req('POST', '/seller/members', { username: `${prefix}_0`, role: 'staff' }, 1)).statusCode, 409);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: users[0] } })).account_kind, 'customer');
  const responses = await Promise.all([0, 1].map(() => req('POST', '/seller/members/work-accounts', input, 1)));
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
  const user = await db.user.findUniqueOrThrow({ where: { username: input.username } });
  assert.equal(user.account_kind, 'work'); assert.equal(user.platform_role, 'user'); assert.equal(await verifyPassword(input.password, user.password_hash), true);
  assert.equal(await db.shopMember.count({ where: { user_id: user.id, shop_id: shop } }), 1);
  for (const response of responses) { assert.ok(!response.body.includes(input.password)); assert.ok(!response.body.includes(user.id)); }
  const reserved = `${prefix}_retired`; await db.user.update({ where: { id: user.id }, data: { username: reserved } });
  assert.equal((await req('POST', '/seller/members/work-accounts', input, 1)).statusCode, 409);
  assert.equal(await db.user.count({ where: { username: input.username } }), 0);
}));

async function waitForLock(db: ReturnType<typeof createDatabase>, query: string) {
  for (let i = 0; i < 150; i++) {
    const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE ${query}`;
    if (Number(rows[0]!.count)) return; await setTimeout(20);
  }
  assert.fail('request did not reach the expected authorization lock');
}
test('buyer writes recheck account purpose after passing the request guard', async () => fixture(async ({ req, db, users, sku }) => {
  let pending: ReturnType<typeof req> | undefined;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${users[0]}::uuid FOR UPDATE`;
    pending = req('POST', '/cart/items', { skuId: sku, quantity: 1 });
    await waitForLock(db, 'SELECT id FROM users WHERE id=%FOR SHARE%');
    await tx.user.update({ where: { id: users[0] }, data: { account_kind: 'work' } });
  }, { timeout: 10000 });
  assert.equal((await pending!).statusCode, 403);
  assert.equal(await db.cartItem.count({ where: { user_id: users[0] } }), 0);
}));

test('catalog and shipment writes recheck membership after waiting for concurrent revocation', async () => fixture(async ({ req, db, users, shop, orderBody }) => {
  const response = await req('POST', '/orders/direct', orderBody()); assert.equal(response.statusCode, 201, response.body);
  const order = response.json<{ id: string }>(); assert.equal((await req('POST', `/orders/${order.id}/mock-pay`)).statusCode, 200);
  for (const catalog of [true, false]) {
    const user = catalog ? 2 : 3; let pending: ReturnType<typeof req> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${shop}::uuid FOR UPDATE`;
      pending = catalog ? req('POST', '/seller/categories', { name: '不应创建', description: null, sortOrder: 0, isActive: true }, user) : req('POST', `/seller/orders/${order.id}/ship`, undefined, user);
      await waitForLock(db, 'SELECT id FROM shops WHERE id=%FOR SHARE%');
      await tx.shopMember.updateMany({ where: { shop_id: shop, user_id: users[user] }, data: { status: 'disabled' } });
    }, { timeout: 10000 });
    assert.equal((await pending!).statusCode, 403);
  }
  assert.equal(await db.category.count({ where: { shop_id: shop } }), 0);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'pending_shipment');
}));

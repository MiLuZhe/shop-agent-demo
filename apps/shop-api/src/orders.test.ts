import { DEFAULT_SHOP_ID } from '@shop/contracts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { createDatabase, type Prisma, type PrismaClient } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import type { CheckoutInput, CartItemDto, OrderDetailDto, Page, OrderSummaryDto, SellerProductDetailDto } from '@shop/contracts';
import { buildApp } from './app.ts';
const db = createDatabase(), app = buildApp(db, false);
const prefix = `order_${randomUUID().slice(0, 8)}`, users = [randomUUID(), randomUUID(), randomUUID()], productId = randomUUID(), skus = [randomUUID(), randomUUID()];
const cookies: string[] = [];
async function req(method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown, user = 0, instance = app) {
  return instance.inject({ method, url: `/api${path}`, headers: { cookie: cookies[user] ?? '' }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { cookie: cookies[user] ?? '', 'content-type': 'application/json' } }) });
}
async function checkout(user = 0, skuId = skus[0]!, quantity = 1): Promise<CheckoutInput> {
  const added = await req('POST', '/cart/items', { skuId, quantity }, user); assert.equal(added.statusCode, 201, added.body);
  const item = added.json<CartItemDto>();
  return { checkoutKey: randomUUID(), items: [{ cartItemId: item.id, quantity: item.quantity, unitPrice: item.price, version: item.version }], recipientName: '测试收件人', recipientPhone: '13800000000', recipientAddress: '测试省测试市测试路 1 号', buyerNote: null };
}
async function create(input?: CheckoutInput, user = 0) {
  const body = input ?? await checkout(user), r = await req('POST', '/orders', body, user); assert.equal(r.statusCode, 201, r.body); return r.json<OrderDetailDto>();
}
async function stock() { return (await db.sku.findUniqueOrThrow({ where: { id: skus[0] } })).stock_quantity; }
async function clean() {
  const orders = await db.order.findMany({ where: { buyer_id: { in: users } }, select: { id: true } });
  await db.orderItem.deleteMany({ where: { order_id: { in: orders.map((row) => row.id) } } });
  await db.order.deleteMany({ where: { buyer_id: { in: users } } });
  await db.cartItem.deleteMany({ where: { user_id: { in: users } } });
}
before(async () => {
  const password_hash = await hashPassword('OrderTest123!');
  await db.user.createMany({ data: users.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: '订单测试账号', password_hash })) });
  await db.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: users[2]! } });
  await db.product.create({ data: { shop_id: DEFAULT_SHOP_ID, id: productId, name: prefix, status: 'active', skus: { create: skus.map((id, i) => ({ id, sku_code: `${prefix}_${i}`, name: `规格${i}`, price: i ? '0.20' : '0.10', stock_quantity: 10 })) } } });
  for (let i = 0; i < users.length; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_${i}`, password: 'OrderTest123!' } });
    assert.equal(r.statusCode, 200); cookies.push(String(r.headers['set-cookie']).split(';')[0]!);
  }
});
beforeEach(async () => {
  await clean(); await db.product.update({ where: { id: productId }, data: { name: prefix, status: 'active' } });
  for (let i = 0; i < skus.length; i++) await db.sku.update({ where: { id: skus[i] }, data: { name: `规格${i}`, price: i ? '0.20' : '0.10', stock_quantity: 10, is_active: true } });
});
after(async () => { try { await clean(); await db.sku.deleteMany({ where: { product_id: productId } }); await db.product.deleteMany({ where: { id: productId } }); await db.shopMember.deleteMany({ where: { user_id: { in: users } } }); await db.user.deleteMany({ where: { id: { in: users } } }); } finally { await app.close(); } });
function directBody(quantity = 2) {
  return { checkoutKey: randomUUID(), skuId: skus[0]!, quantity, unitPrice: '0.10', recipientName: '直接购买', recipientPhone: '13800000000', recipientAddress: '测试省测试市测试街道 1 号', buyerNote: null };
}
test('direct checkout preserves every cart row, snapshots only selected quantities and replays once', async () => {
  await checkout(0, skus[0], 5); await checkout(0, skus[1], 3);
  const beforeCart = await db.cartItem.findMany({ where: { user_id: users[0] }, orderBy: { id: 'asc' } });
  const body = directBody();
  const responses = await Promise.all([req('POST', '/orders/direct', body), req('POST', '/orders/direct', body)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]);
  const order = responses[0]!.json<OrderDetailDto>();
  assert.equal(responses[1]!.json<OrderDetailDto>().id, order.id); assert.equal(order.totalAmount, '0.20');
  assert.equal(order.items.length, 1); assert.equal(order.items[0]!.quantity, 2); assert.equal(await stock(), 8);
  assert.deepEqual(await db.cartItem.findMany({ where: { user_id: users[0] }, orderBy: { id: 'asc' } }), beforeCart);
  assert.equal((await req('GET', `/orders/${order.id}`, undefined, 1)).statusCode, 404);
  assert.equal((await req('POST', '/orders/direct', { ...body, quantity: 3 })).statusCode, 409);
  assert.equal((await req('POST', `/orders/${order.id}/cancel`)).statusCode, 200); assert.equal(await stock(), 10);
  assert.equal((await req('POST', '/orders/direct', body)).json<OrderDetailDto>().status, 'cancelled');
  assert.equal(await db.order.count({ where: { buyer_id: users[0] } }), 1);
});
test('direct checkout enforces login, strict fields, live prices, quantities and sellability', async () => {
  const body = directBody();
  assert.equal((await req('POST', '/orders/direct', body, -1)).statusCode, 401);
  for (const patch of [{ quantity: 0 }, { quantity: 1000 }, { quantity: 1.5 }, { unitPrice: '0.001' }, { buyerId: users[1] }, { recipientAddress: '' }, { items: [] }]) {
    assert.equal((await req('POST', '/orders/direct', { ...body, ...patch })).statusCode, 400);
  }
  for (const patch of [{ quantity: 11 }, { skuId: randomUUID() }, { unitPrice: '0.09' }]) assert.equal((await req('POST', '/orders/direct', { ...body, ...patch })).statusCode, 409);
  await db.sku.update({ where: { id: skus[0] }, data: { is_active: false } });
  assert.equal((await req('POST', '/orders/direct', body)).statusCode, 409);
  await db.sku.update({ where: { id: skus[0] }, data: { is_active: true } });
  await db.product.update({ where: { id: productId }, data: { status: 'inactive' } });
  assert.equal((await req('POST', '/orders/direct', body)).statusCode, 409);
  assert.equal(await stock(), 10); assert.equal(await db.order.count({ where: { buyer_id: users[0] } }), 0);
});
test('direct buyers competing for the last item cannot oversell and keys cannot cross checkout modes', async () => {
  await db.sku.update({ where: { id: skus[0] }, data: { stock_quantity: 1 } });
  const body = directBody(1);
  const responses = await Promise.all([req('POST', '/orders/direct', body), req('POST', '/orders/direct', directBody(1), 1)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]); assert.equal(await stock(), 0);
  const winner = responses.findIndex((response) => response.statusCode === 201);
  const order = responses[winner]!.json<OrderDetailDto>();
  await req('POST', `/orders/${order.id}/cancel`, undefined, winner);
  const cartInput = await checkout(winner, skus[0], 1);
  const winningKey = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).checkout_key;
  assert.equal((await req('POST', '/orders', { ...cartInput, checkoutKey: winningKey }, winner)).statusCode, 409);
});
test('orders require login and seller routes require membership; mutation origin is checked', async () => {
  const id = randomUUID();
  for (const [method, path, payload] of [['GET', '/orders', undefined], ['GET', `/orders/${id}`, undefined], ['POST', '/orders', {}], ['POST', `/orders/${id}/cancel`, undefined], ['POST', `/orders/${id}/mock-pay`, undefined]] as const) {
    assert.equal((await req(method, path, payload, -1)).statusCode, 401);
  }
  for (const [method, path] of [['GET', '/seller/orders'], ['GET', `/seller/orders/${id}`], ['POST', `/seller/orders/${id}/ship`]] as const) {
    assert.equal((await req(method, path, undefined, -1)).statusCode, 401); assert.equal((await req(method, path)).statusCode, 403);
  }
  assert.equal((await req('GET', '/orders', undefined, 2)).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orders', headers: { origin: 'https://foreign.example', cookie: cookies[0] }, payload: {} })).statusCode, 403);
});
test('checkout requires valid recipient snapshots, exact item confirmation and strict payloads', async () => {
  const body = await checkout();
  for (const patch of [{ recipientName: '  ' }, { recipientPhone: 'abc1234567' }, { recipientPhone: '123' }, { recipientAddress: '' }, { items: [] }, { items: [...body.items, ...body.items] }, { checkoutKey: 'bad' }, { buyerId: users[1] }, { items: [{ ...body.items[0], unitPrice: '0.001' }] }])
    assert.equal((await req('POST', '/orders', { ...body, ...patch })).statusCode, 400);
  assert.equal(await stock(), 10); assert.equal(await db.order.count({ where: { buyer_id: users[0] } }), 0);
  assert.equal((await req('GET', '/orders?pageSize=1000')).statusCode, 400);
});
test('partial checkout atomically snapshots money and recipient, decrements inventory and clears only selected rows', async () => {
  const body = await checkout(0, skus[0], 3); await checkout(0, skus[1]);
  body.recipientName = ' 测试收件人 '; body.buyerNote = ' 请联系 '; const oldSku = await db.sku.findUniqueOrThrow({ where: { id: skus[0] } });
  const order = await create(body); assert.equal(order.status, 'pending_payment'); assert.equal(order.totalAmount, '0.30'); assert.equal(order.items.length, 1);
  assert.equal(order.recipientName, '测试收件人'); assert.equal(order.buyerNote, '请联系'); assert.equal(order.paymentMethod, null); assert.equal(order.paidAt, null);
  assert.equal(await stock(), 7); assert.equal(await db.cartItem.count({ where: { user_id: users[0], sku_id: skus[1] } }), 1); assert.equal(await db.cartItem.count({ where: { user_id: users[0], sku_id: skus[0] } }), 0);
  assert.notEqual((await db.sku.findUniqueOrThrow({ where: { id: skus[0] } })).updated_at.toISOString(), oldSku.updated_at.toISOString());
});
test('price changes, stale quantities, disabled goods and insufficient stock reject checkout without partial writes', async () => {
  const body = await checkout(0, skus[0], 2), other = await checkout(0, skus[1], 2); body.items.push(...other.items);
  await db.sku.update({ where: { id: skus[1] }, data: { price: '0.30' } });
  assert.equal((await req('POST', '/orders', body)).statusCode, 409); assert.equal(await stock(), 10);
  await db.sku.update({ where: { id: skus[1] }, data: { price: '0.20', stock_quantity: 1 } });
  assert.equal((await req('POST', '/orders', body)).statusCode, 409);
  await db.sku.update({ where: { id: skus[1] }, data: { stock_quantity: 10, is_active: false } }); assert.equal((await req('POST', '/orders', body)).statusCode, 409);
  await db.sku.update({ where: { id: skus[1] }, data: { is_active: true } });
  await db.product.update({ where: { id: productId }, data: { status: 'inactive' } }); assert.equal((await req('POST', '/orders', body)).statusCode, 409);
  await db.product.update({ where: { id: productId }, data: { status: 'active' } });
  await db.cartItem.update({ where: { id: body.items[0]!.cartItemId }, data: { quantity: 3 } }); assert.equal((await req('POST', '/orders', body)).statusCode, 409);
  assert.equal(await db.order.count({ where: { buyer_id: users[0] } }), 0); assert.equal(await db.cartItem.count({ where: { user_id: users[0] } }), 2); assert.equal(await stock(), 10);
});
test('database failure after inventory changes rolls back inventory, order and cart as a unit', async () => {
  const body = await checkout();
  const faultDb = new Proxy(db, { get(target, property) {
    if (property === '$disconnect') return async () => {};
    if (property === '$transaction') return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction((tx) => work(new Proxy(tx, { get(t, key) {
      if (key === 'order') return new Proxy(t.order, { get(delegate, method) { if (method === 'create') return async () => { throw new Error('injected order write failure'); }; return Reflect.get(delegate, method); } });
      const value = Reflect.get(t, key); return typeof value === 'function' ? value.bind(t) : value;
    } })));
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } }) as PrismaClient;
  const faultApp = buildApp(faultDb, false);
  try {
    const login = await faultApp.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_0`, password: 'OrderTest123!' } });
    const r = await faultApp.inject({ method: 'POST', url: '/api/orders', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, payload: body });
    assert.equal(r.statusCode, 500); assert.equal(await stock(), 10); assert.equal(await db.order.count({ where: { buyer_id: users[0] } }), 0); assert.equal(await db.cartItem.count({ where: { user_id: users[0] } }), 1);
  } finally { await faultApp.close(); }
});
test('idempotent retries work after cart cleanup; changed recipient or items using the same key conflict', async () => {
  const body = await checkout(), order = await create(body);
  const retry = await req('POST', '/orders', { ...body, items: body.items.map((item) => ({ ...item, unitPrice: '0.1' })) }); assert.equal(retry.statusCode, 200); assert.equal(retry.json<OrderDetailDto>().id, order.id);
  for (const patch of [{ recipientName: '另一个人' }, { recipientPhone: '13900000000' }, { recipientAddress: '另一条完整的地址' }, { buyerNote: '新增备注' }, { items: [{ ...body.items[0], quantity: 2 }] }])
    assert.equal((await req('POST', '/orders', { ...body, ...patch })).statusCode, 409);
  assert.equal(await stock(), 9); assert.equal(await db.order.count({ where: { buyer_id: users[0] } }), 1);
});
test('parallel duplicate checkout returns one order and decrements stock only once', async () => {
  const body = await checkout(); const responses = await Promise.all([req('POST', '/orders', body), req('POST', '/orders', body)]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 201]); assert.equal(responses[0]!.json<OrderDetailDto>().id, responses[1]!.json<OrderDetailDto>().id); assert.equal(await stock(), 9);
});
test('different checkout keys cannot purchase the same cart row twice', async () => {
  const body = await checkout(); const responses = await Promise.all([req('POST', '/orders', body), req('POST', '/orders', { ...body, checkoutKey: randomUUID() })]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]); assert.equal(await stock(), 9);
});
test('two buyers competing for the last item cannot oversell; losing buyer keeps their cart', async () => {
  const first = await checkout(), second = await checkout(1); await db.sku.update({ where: { id: skus[0] }, data: { stock_quantity: 1 } });
  const responses = await Promise.all([req('POST', '/orders', first), req('POST', '/orders', second, 1)]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]); assert.equal(await stock(), 0);
  assert.equal(await db.order.count({ where: { buyer_id: { in: users } } }), 1); assert.equal(await db.cartItem.count({ where: { user_id: { in: users } } }), 1);
});
test('buyer reads and mutations enforce ownership; list omits recipient fields and seller can inspect snapshots', async () => {
  const order = await create();
  for (const path of [`/orders/${order.id}`, `/orders/${order.id}/cancel`, `/orders/${order.id}/mock-pay`]) assert.equal((await req(path.endsWith(order.id) ? 'GET' : 'POST', path, undefined, 1)).statusCode, 404);
  const list = await req('GET', '/orders'); assert.equal(list.headers['cache-control'], 'no-store'); assert.equal(list.json<Page<OrderSummaryDto>>().items.length, 1); assert.ok(!('recipientAddress' in list.json<Page<OrderSummaryDto>>().items[0]!));
  assert.equal((await req('GET', '/orders', undefined, 1)).json<Page<OrderSummaryDto>>().total, 0);
  assert.equal((await req('GET', `/seller/orders/${order.id}`, undefined, 2)).json<OrderDetailDto>().recipientAddress, order.recipientAddress);
  assert.equal((await req('GET', '/orders?status=shipped')).json<Page<OrderSummaryDto>>().total, 0);
});
test('parallel cancellations restore stock and invalidate SKU versions exactly once', async () => {
  const order = await create(await checkout(0, skus[0], 3)), beforeCancel = await db.sku.findUniqueOrThrow({ where: { id: skus[0] } });
  const responses = await Promise.all([req('POST', `/orders/${order.id}/cancel`), req('POST', `/orders/${order.id}/cancel`)]);
  assert.deepEqual(responses.map((r) => r.statusCode), [200, 200]); assert.equal(responses[0]!.json<OrderDetailDto>().cancelledAt, responses[1]!.json<OrderDetailDto>().cancelledAt); assert.equal(await stock(), 10);
  assert.notEqual((await db.sku.findUniqueOrThrow({ where: { id: skus[0] } })).updated_at.toISOString(), beforeCancel.updated_at.toISOString());
  assert.equal((await req('POST', `/orders/${order.id}/mock-pay`)).statusCode, 409); assert.equal((await req('POST', `/seller/orders/${order.id}/ship`, undefined, 2)).statusCode, 409);
});
test('payment versus cancellation permits exactly one transition and consistent inventory', async () => {
  const order = await create(); const responses = await Promise.all([req('POST', `/orders/${order.id}/mock-pay`), req('POST', `/orders/${order.id}/cancel`)]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  const row = (await req('GET', `/orders/${order.id}`)).json<OrderDetailDto>();
  assert.equal(await stock(), row.status === 'cancelled' ? 10 : 9); assert.equal(row.paymentMethod, row.status === 'cancelled' ? null : 'mock');
});
test('mock payment and shipment are repeatable without rewriting first timestamps; shipped is terminal', async () => {
  const order = await create(); assert.equal((await req('POST', `/seller/orders/${order.id}/ship`, undefined, 2)).statusCode, 409);
  const paid = (await req('POST', `/orders/${order.id}/mock-pay`)).json<OrderDetailDto>(); assert.equal(paid.status, 'pending_shipment'); assert.ok(paid.paidAt);
  assert.equal((await req('POST', `/orders/${order.id}/mock-pay`)).json<OrderDetailDto>().paidAt, paid.paidAt);
  const shipped = (await req('POST', `/seller/orders/${order.id}/ship`, undefined, 2)).json<OrderDetailDto>(); assert.equal(shipped.status, 'shipped'); assert.ok(shipped.shippedAt);
  assert.equal((await req('POST', `/seller/orders/${order.id}/ship`, undefined, 2)).json<OrderDetailDto>().shippedAt, shipped.shippedAt);
  assert.equal((await req('POST', `/orders/${order.id}/mock-pay`)).json<OrderDetailDto>().paidAt, paid.paidAt);
  assert.equal((await req('POST', `/orders/${order.id}/cancel`)).statusCode, 409); assert.equal(await stock(), 9);
});
test('product edits never change historical names, price or order recipient snapshots', async () => {
  const order = await create(); await db.product.update({ where: { id: productId }, data: { name: `${prefix}_renamed`, status: 'inactive' } }); await db.sku.update({ where: { id: skus[0] }, data: { name: '新名字', price: '99.00' } });
  const detail = (await req('GET', `/orders/${order.id}`)).json<OrderDetailDto>(); assert.equal(detail.items[0]?.productName, prefix); assert.equal(detail.items[0]?.skuName, '规格0'); assert.equal(detail.items[0]?.unitPrice, '0.10'); assert.equal(detail.recipientAddress, order.recipientAddress);
});
test('checkout invalidates stale seller inventory edits; simultaneous seller change cannot overwrite a sale', async () => {
  const body = await checkout();
  const product = (await req('GET', `/seller/products/${productId}`, undefined, 2)).json<SellerProductDetailDto>(), sku = product.skus.find((sku) => sku.id === skus[0])!;
  const write = { skuCode: sku.skuCode, name: sku.name, price: sku.price, stockQuantity: 0, isActive: true, attributes: sku.attributes, version: sku.version };
  const responses = await Promise.all([req('POST', '/orders', body), req('PUT', `/seller/products/${productId}/skus/${sku.id}`, write, 2)]);
  assert.ok(responses[0]!.statusCode === 201 && responses[1]!.statusCode === 409 || responses[0]!.statusCode === 409 && responses[1]!.statusCode === 200);
  assert.equal(await stock(), responses[0]!.statusCode === 201 ? 9 : 0);
  if (responses[0]!.statusCode === 201) assert.equal((await req('PUT', `/seller/products/${productId}/skus/${sku.id}`, write, 2)).statusCode, 409);
});
test('amount overflow and cancellation restore overflow fail without partial inventory changes', async () => {
  const body = await checkout(0, skus[0], 2); await db.sku.update({ where: { id: skus[0] }, data: { price: '9999999999.99' } }); body.items[0]!.unitPrice = '9999999999.99';
  assert.equal((await req('POST', '/orders', body)).statusCode, 409); assert.equal(await stock(), 10);
  await db.sku.update({ where: { id: skus[0] }, data: { price: '0.10' } }); body.items[0]!.unitPrice = '0.10'; const order = await create(body);
  await db.sku.update({ where: { id: skus[0] }, data: { stock_quantity: 2147483647 } }); assert.equal((await req('POST', `/orders/${order.id}/cancel`)).statusCode, 409);
  assert.equal((await req('GET', `/orders/${order.id}`)).json<OrderDetailDto>().status, 'pending_payment'); assert.equal(await stock(), 2147483647);
});

test('cancellation coordinates with seller absolute inventory adjustments without losing restored stock', async () => {
  const order = await create(await checkout(0, skus[0], 3));
  const product = (await req('GET', `/seller/products/${productId}`, undefined, 2)).json<SellerProductDetailDto>(), sku = product.skus.find((sku) => sku.id === skus[0])!;
  const write = { skuCode: sku.skuCode, name: sku.name, price: sku.price, stockQuantity: 5, isActive: true, attributes: sku.attributes, version: sku.version };
  const responses = await Promise.all([req('POST', `/orders/${order.id}/cancel`), req('PUT', `/seller/products/${productId}/skus/${sku.id}`, write, 2)]);
  assert.equal(responses[0]!.statusCode, 200);
  assert.ok([200, 409].includes(responses[1]!.statusCode)); assert.equal(await stock(), responses[1]!.statusCode === 200 ? 8 : 10);
});
test('cart add and checkout share a buyer lock and preserve either the new cart intent or stale-checkout rejection', async () => {
  const body = await checkout(); const responses = await Promise.all([req('POST', '/orders', body), req('POST', '/cart/items', { skuId: skus[0], quantity: 1 })]);
  assert.equal(responses[1]!.statusCode, 201);
  const rows = await db.cartItem.findMany({ where: { user_id: users[0] } }); assert.equal(rows.length, 1);
  assert.ok([201, 409].includes(responses[0]!.statusCode)); assert.equal(rows[0]!.quantity, responses[0]!.statusCode === 201 ? 1 : 2); assert.equal(await stock(), responses[0]!.statusCode === 201 ? 9 : 10);
});
test('reordered checkout items replay the original order without additional stock changes', async () => {
  const body = await checkout(), other = await checkout(0, skus[1]); body.items.push(...other.items);
  const order = await create(body); const replay = await req('POST', '/orders', { ...body, items: [...body.items].reverse().map((item) => ({ ...item, cartItemId: item.cartItemId.toUpperCase() })) });
  assert.equal(replay.statusCode, 200); assert.equal(replay.json<OrderDetailDto>().id, order.id); assert.equal(await stock(), 9);
});

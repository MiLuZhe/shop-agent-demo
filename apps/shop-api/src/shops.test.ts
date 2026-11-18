import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import { DEFAULT_SHOP_ID, type CartItemDto, type OrderDetailDto, type SellerProductDetailDto } from '@shop/contracts';
import { buildApp } from './app.ts';
const db = createDatabase(), app = buildApp(db, false);
const prefix = `shop_${randomUUID().slice(0, 8)}`, shops = [randomUUID(), randomUUID()], users = Array.from({ length: 4 }, () => randomUUID());
const products = [randomUUID(), randomUUID()], skus = [randomUUID(), randomUUID()], categories = [randomUUID(), randomUUID()], tags = [randomUUID(), randomUUID()], attributes = [randomUUID(), randomUUID()];
const cookies: string[] = [];
async function req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, user = 0, shop: string | undefined = shops[0]) {
  return app.inject({ method, url: `/api${path}`, headers: { cookie: cookies[user] ?? '', ...(shop ? { 'x-shop-id': shop } : {}) }, ...(body === undefined ? {} : { payload: JSON.stringify(body), headers: { cookie: cookies[user] ?? '', ...(shop ? { 'x-shop-id': shop } : {}), 'content-type': 'application/json' } }) });
}
async function checkout(index = 0) {
  const added = await req('POST', '/cart/items', { skuId: skus[index], quantity: 1 }, 2); assert.equal(added.statusCode, 201, added.body); const item = added.json<CartItemDto>();
  return { checkoutKey: randomUUID(), items: [{ cartItemId: item.id, quantity: item.quantity, unitPrice: item.price, version: item.version }], recipientName: '跨店测试', recipientPhone: '13800000000', recipientAddress: '测试省测试市测试街道', buyerNote: null };
}
async function clearOrders() {
  const rows = await db.order.findMany({ where: { buyer_id: { in: users } }, select: { id: true } });
  await db.orderItem.deleteMany({ where: { order_id: { in: rows.map((row) => row.id) } } }); await db.order.deleteMany({ where: { buyer_id: { in: users } } }); await db.cartItem.deleteMany({ where: { user_id: { in: users } } });
}
before(async () => {
  const password_hash = await hashPassword('ShopTest123!');
  await db.user.createMany({ data: users.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: '店铺测试', password_hash })) });
  for (let i = 0; i < shops.length; i++) {
    await db.shop.create({ data: { id: shops[i], slug: `${prefix}_${i}`, name: `${prefix}_店${i}` } });
    await db.shopMember.create({ data: { user_id: users[i]!, shop_id: shops[i]!, role: 'owner' } });
    await db.category.create({ data: { id: categories[i], shop_id: shops[i]!, name: '同名分类' } });
    await db.tag.create({ data: { id: tags[i], shop_id: shops[i]!, name: '同名标签' } });
    await db.attributeDefinition.create({ data: { id: attributes[i], shop_id: shops[i]!, code: 'same_code', name: '相同编码属性', data_type: 'text' } });
    await db.product.create({ data: { id: products[i], shop_id: shops[i]!, category_id: categories[i], name: `${prefix}_商品${i}`, status: 'active', skus: { create: { id: skus[i], name: '默认规格', sku_code: `${prefix}_${i}`, price: '1.23', stock_quantity: 10 } } } });
  }
  for (let i = 0; i < users.length; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_${i}`, password: 'ShopTest123!' } }); assert.equal(r.statusCode, 200); cookies.push(String(r.headers['set-cookie']).split(';')[0]!);
  }
});
beforeEach(async () => {
  await clearOrders(); await db.shop.updateMany({ where: { id: { in: shops } }, data: { status: 'active' } });
  await db.shopMember.updateMany({ where: { shop_id: { in: shops } }, data: { status: 'active' } });
});
after(async () => {
  try {
    await clearOrders();
    const conversations = await db.conversation.findMany({ where: { shop_id: { in: shops } }, select: { id: true } }); const ids = conversations.map((row) => row.id);
    await db.inquiry.deleteMany({ where: { conversation_id: { in: ids } } }); await db.message.deleteMany({ where: { conversation_id: { in: ids } } }); await db.conversation.deleteMany({ where: { id: { in: ids } } }); await db.chatChannel.deleteMany({ where: { shop_id: { in: shops } } });
    await db.skuAttributeValue.deleteMany({ where: { sku_id: { in: skus } } }); await db.sku.deleteMany({ where: { product_id: { in: products } } }); await db.product.deleteMany({ where: { id: { in: products } } });
    await db.category.deleteMany({ where: { shop_id: { in: shops } } }); await db.tag.deleteMany({ where: { shop_id: { in: shops } } }); await db.attributeDefinition.deleteMany({ where: { shop_id: { in: shops } } });
    await db.shopMember.deleteMany({ where: { shop_id: { in: shops } } }); await db.shop.deleteMany({ where: { id: { in: shops } } }); await db.user.deleteMany({ where: { id: { in: users } } });
  } finally { await app.close(); }
});
test('default store is populated and shop membership is independent of the seller role', async () => {
  assert.ok(await db.shop.findUnique({ where: { id: DEFAULT_SHOP_ID } }));
  assert.ok(await db.shopMember.count({ where: { shop_id: DEFAULT_SHOP_ID } }) >= 1);
  assert.equal((await req('GET', '/seller/overview', undefined, 0, DEFAULT_SHOP_ID)).statusCode, 403);
  assert.equal((await req('GET', '/seller/overview')).statusCode, 200);
  assert.equal((await req('GET', '/seller/overview', undefined, 3)).statusCode, 403);
});
test('all seller interfaces check membership, role and the selected shop header', async () => {
  for (const path of ['/seller/overview','/seller/categories','/seller/tags','/seller/attributes','/seller/products','/seller/orders']) {
    assert.equal((await req('GET', path, undefined, 0, shops[1])).statusCode, 403);
    assert.equal((await req('GET', path, undefined, -1)).statusCode, 401);
    assert.equal((await req('GET', path, undefined, 2)).statusCode, 403);
  }
  assert.equal((await req('GET', '/seller/products', undefined, 0, 'not-a-uuid')).statusCode, 400);
  assert.equal((await req('POST', '/seller/categories', { name: '伪造店铺', description: null, sortOrder: 0, isActive: true }, 0, shops[1])).statusCode, 403);
});
test('catalog dictionaries are isolated and same names/codes are allowed in different shops', async () => {
  for (const [path, id] of [['categories', categories[0]], ['tags', tags[0]], ['attributes', attributes[0]]] as const) {
    const r = await req('GET', `/seller/${path}`); assert.equal(r.statusCode, 200); assert.deepEqual(r.json().items.map((row: { id: string }) => row.id), [id]);
  }
  await assert.rejects(db.tag.create({ data: { shop_id: shops[0]!, name: '同名标签' } }), /tags_name_lower_key|Unique constraint/);
  await assert.rejects(db.category.create({ data: { shop_id: shops[0]!, name: '同名分类' } }), /Unique constraint/);
  await assert.rejects(db.attributeDefinition.create({ data: { shop_id: shops[0]!, code: 'same_code', name: '重复', data_type: 'text' } }), /Unique constraint/);
});
test('public lookup and search select the requested active shop, with the default storefront unchanged', async () => {
  const own = await req('GET', `/products?shopId=${shops[0]}`); assert.equal(own.statusCode, 200); assert.deepEqual(own.json().items.map((row: { id: string }) => row.id), [products[0]]);
  assert.equal(own.json().items[0].shopId, shops[0]);
  assert.equal((await req('GET', `/products?shopId=${shops[0]}&tagIds=${tags[1]}`)).statusCode, 400);
  assert.equal((await req('GET', `/products?shopId=${shops[0]}&categoryId=${categories[1]}`)).statusCode, 400);
  assert.deepEqual((await req('GET', `/tags?shopId=${shops[1]}`)).json().items.map((row: { id: string }) => row.id), [tags[1]]);
  assert.ok(!(await req('GET', '/products')).json().items.some((row: { id: string }) => products.some((id) => id === row.id)));
});
test('seller cannot read or edit another shops product or attach its dictionaries', async () => {
  const detail = (await req('GET', `/seller/products/${products[0]}`)).json<SellerProductDetailDto>();
  assert.equal((await req('GET', `/seller/products/${products[1]}`)).statusCode, 404);
  const body = { name: detail.name, description: detail.description, categoryId: detail.categoryId, tagIds: detail.tagIds, imageUrls: detail.imageUrls, status: detail.status, version: detail.version };
  assert.equal((await req('PUT', `/seller/products/${products[1]}`, body)).statusCode, 404);
  assert.equal((await req('PUT', `/seller/products/${products[0]}`, { ...body, categoryId: categories[1] })).statusCode, 400);
  assert.equal((await req('PUT', `/seller/products/${products[0]}`, { ...body, tagIds: [tags[1]] })).statusCode, 400);
  const sku = detail.skus[0]!;
  const skuBody = { skuCode: sku.skuCode, name: sku.name, price: sku.price, stockQuantity: sku.stockQuantity, isActive: sku.isActive, attributes: [{ attributeId: attributes[1], value: '跨店' }], version: sku.version };
  assert.equal((await req('PUT', `/seller/products/${products[0]}/skus/${skus[0]}`, skuBody)).statusCode, 400);
  const foreign = await db.tag.findUniqueOrThrow({ where: { id: tags[1] } }), source = await db.tag.findUniqueOrThrow({ where: { id: tags[0] } });
  assert.equal((await req('POST', `/seller/tags/${tags[0]}/merge`, { targetId: tags[1], version: source.updated_at.toISOString(), targetVersion: foreign.updated_at.toISOString() })).statusCode, 404);
});
test('one buyer can order from different shops; seller order lists, details and shipment remain isolated', async () => {
  const first = await req('POST', '/orders', await checkout(), 2), second = await req('POST', '/orders', await checkout(1), 2);
  assert.equal(first.statusCode, 201, first.body); assert.equal(second.statusCode, 201, second.body);
  const a = first.json<OrderDetailDto>(), b = second.json<OrderDetailDto>(); assert.equal(a.shopId, shops[0]); assert.equal(b.shopId, shops[1]);
  assert.equal((await req('GET', '/orders', undefined, 2)).json().total, 2);
  assert.deepEqual((await req('GET', '/seller/orders')).json().items.map((row: { id: string }) => row.id), [a.id]);
  assert.equal((await req('GET', `/seller/orders/${b.id}`)).statusCode, 404);
  assert.equal((await req('POST', `/seller/orders/${b.id}/ship`)).statusCode, 404);
  await req('POST', `/orders/${b.id}/mock-pay`, undefined, 2);
  assert.equal((await req('POST', `/seller/orders/${b.id}/ship`, undefined, 1, shops[1])).statusCode, 200);
});
test('mixed-shop checkout is rejected atomically and separate checkout remains possible', async () => {
  const first = await checkout(), second = await checkout(1);
  const response = await req('POST', '/orders', { ...first, items: [...first.items, ...second.items] }, 2); assert.equal(response.statusCode, 409); assert.match(response.body, /按店铺分别结算/);
  assert.equal(await db.order.count({ where: { buyer_id: users[2] } }), 0); assert.equal(await db.cartItem.count({ where: { user_id: users[2] } }), 2);
  assert.equal((await req('POST', '/orders', first, 2)).statusCode, 201);
});
test('revoked membership or disabled shop is checked on each request without invalidating other shop access', async () => {
  await db.shopMember.update({ where: { shop_id_user_id: { shop_id: shops[0]!, user_id: users[0]! } }, data: { status: 'disabled' } });
  assert.equal((await req('GET', '/seller/overview')).statusCode, 403); assert.equal((await req('GET', '/seller/overview', undefined, 1, shops[1])).statusCode, 200);
  await db.shop.update({ where: { id: shops[1] }, data: { status: 'disabled' } }); assert.equal((await req('GET', '/seller/overview', undefined, 1, shops[1])).statusCode, 403);
});
test('disabled shops are hidden publicly, cannot sell, and buyers can still cancel existing orders', async () => {
  const body = await checkout(), response = await req('POST', '/orders', body, 2); assert.equal(response.statusCode, 201); const order = response.json<OrderDetailDto>(); await checkout();
  await db.shop.update({ where: { id: shops[0] }, data: { status: 'disabled' } });
  assert.equal((await req('GET', `/products?shopId=${shops[0]}`)).json().total, 0); assert.equal((await req('GET', `/products/${products[0]}`)).statusCode, 404);
  assert.equal((await req('GET', '/cart', undefined, 2)).json().items[0].reason, '店铺已停用');
  assert.equal((await req('POST', '/cart/items', { skuId: skus[0], quantity: 1 }, 2)).statusCode, 409);
  assert.equal((await req('POST', `/orders/${order.id}/cancel`, undefined, 2)).statusCode, 200);
});
test('database rejects cross-shop category, tag, attribute and order item links', async () => {
  await assert.rejects(db.product.update({ where: { id: products[0] }, data: { category_id: categories[1] } }), /cross-shop reference/);
  await assert.rejects(db.productTag.create({ data: { product_id: products[0]!, tag_id: tags[1]! } }), /cross-shop reference/);
  await assert.rejects(db.skuAttributeValue.create({ data: { sku_id: skus[0]!, attribute_definition_id: attributes[1]!, text_value: '跨店' } }), /cross-shop reference/);
  const response = await req('POST', '/orders', await checkout(), 2); const order = response.json<OrderDetailDto>(); assert.equal(response.statusCode, 201);
  await assert.rejects(db.orderItem.create({ data: { order_id: order.id, sku_id: skus[1]!, product_name: '跨店', sku_name: '规格', sku_code: 'cross', quantity: 1, unit_price: '1' } }), /cross-shop reference/);
});
test('database requires owning shops, protects references and disallows implicit ownership transfer', async () => {
  await assert.rejects(db.shop.delete({ where: { id: shops[0] } }), /Foreign key constraint/);
  await assert.rejects(db.product.update({ where: { id: products[0] }, data: { shop_id: shops[1], category_id: categories[1] } }), /shop ownership cannot be reassigned/);
  await assert.rejects(db.sku.update({ where: { id: skus[0] }, data: { product_id: products[1] } }), /SKU product cannot be reassigned/);
  await assert.rejects(db.shopMember.create({ data: { shop_id: shops[0]!, user_id: users[0]! } }), /Unique constraint/);
  await assert.rejects(db.shop.create({ data: { slug: `${prefix}_invalid`, name: '非法', status: 'unknown' } }), /shops_content_check/);
  await assert.rejects(db.shopMember.create({ data: { shop_id: shops[0]!, user_id: users[3]!, role: 'root' } }), /shop_members_content_check/);
});
test('conversation and seller messages cannot reference staff from another shop', async () => {
  const channel = await db.chatChannel.create({ data: { shop_id: shops[0]!, buyer_id: users[2]! } });
  await assert.rejects(db.conversation.create({ data: { channel_id: channel.id, shop_id: shops[0]!, buyer_id: users[2]!, assigned_seller_id: users[1]!, status: 'seller' } }), /not a member/);
  const conversation = await db.conversation.create({ data: { channel_id: channel.id, shop_id: shops[0]!, buyer_id: users[2]!, assigned_seller_id: users[0]!, status: 'seller' } });
  await assert.rejects(db.message.create({ data: { channel_id: channel.id, sequence: 1, conversation_id: conversation.id, sender_type: 'seller', sender_user_id: users[1]!, content: '跨店回复' } }), /not a shop member/);
  const trigger = await db.message.create({ data: { channel_id: channel.id, sequence: 1, conversation_id: conversation.id, sender_type: 'buyer', sender_user_id: users[2]!, content: '需要咨询' } });
  await assert.rejects(db.inquiry.create({ data: { conversation_id: conversation.id, trigger_message_id: trigger.id, question: '咨询', reason: 'user_request', status: 'processing', assigned_seller_id: users[1]! } }), /not a shop member/);
  await db.message.create({ data: { channel_id: channel.id, sequence: 2, conversation_id: conversation.id, sender_type: 'seller', sender_user_id: users[0]!, content: '同店回复' } });
});
test('memberships can span shops and explicit scope limits overview and member discovery', async () => {
  await db.shopMember.create({ data: { shop_id: shops[1]!, user_id: users[3]! } }); await db.shopMember.create({ data: { shop_id: shops[0]!, user_id: users[3]! } });
  const r = await req('GET', '/seller/shops', undefined, 3); assert.equal(r.statusCode, 200); assert.deepEqual(r.json().items.map((row: { id: string }) => row.id).sort(), [...shops].sort());
  assert.equal((await req('GET', '/seller/overview', undefined, 3, shops[1])).json().productCount, 1);
  assert.equal((await req('GET', '/seller/overview', undefined, 3, shops[0])).json().productCount, 1);
});

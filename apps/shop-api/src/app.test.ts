import { DEFAULT_SHOP_ID } from '@shop/contracts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createDatabase } from '@shop/database';
import type { Page, ProductDto, TagDto } from '@shop/contracts';
import { buildApp } from './app.ts';

const db = createDatabase();
const app = buildApp(db, false);
const fixture = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
before(async () => { await app.ready(); });
after(async () => { await app.close(); });
async function products(params: Record<string, string> = {}) {
  const response = await app.inject({ url: `/api/products?${new URLSearchParams(params)}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Page<ProductDto>>();
}

test('health checks the actual database connection', async () => {
  const response = await app.inject('/api/health');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().database, 'connected');
});
test('public catalog includes uncategorized goods and hides draft/disabled SKUs', async () => {
  // Catalogue enrichment may classify previous samples or move them off page 1.
  // Own this boundary fixture rather than depending on an old demo layout.
  const prefix = `public_${randomUUID()}`, visible = randomUUID(), draft = randomUUID(), hiddenSku = randomUUID();
  try {
    await db.product.create({ data: { id: visible, shop_id: DEFAULT_SHOP_ID, name: prefix, status: 'active', category_id: null,
      skus: { create: [{ sku_code: `${prefix}_a`, name: '可售规格', price: '12.34', stock_quantity: 3 }, { id: hiddenSku, sku_code: `${prefix}_b`, name: '停用规格', price: '1', stock_quantity: 3, is_active: false }] } } });
    await db.product.create({ data: { id: draft, shop_id: DEFAULT_SHOP_ID, name: `${prefix}_draft`, status: 'draft', skus: { create: { sku_code: `${prefix}_c`, name: '草稿规格', price: '2', stock_quantity: 3 } } } });
    const result = await products({ q: prefix });
    assert.equal(result.total, 1); assert.equal(result.items[0]?.id, visible); assert.equal(result.items[0]?.category, null);
    assert.ok(!result.items.flatMap(p => p.skus).some(s => s.id === hiddenSku));
    assert.equal((await app.inject(`/api/products/${draft}`)).statusCode, 404);
    for (const sku of result.items.flatMap(p => p.skus)) assert.match(sku.price, /^\d+\.\d{2}$/);
  } finally {
    await db.sku.deleteMany({ where: { product_id: { in: [visible, draft] } } });
    await db.product.deleteMany({ where: { id: { in: [visible, draft] } } });
  }
});
test('price and attributes must match the SAME SKU, including availability', async () => {
  // Mouse: cheap SKU = 79 yuan / 110g; light SKU = 129 yuan / 65g.
  const attributes = JSON.stringify([{ attributeId: fixture(30), type: 'number', op: 'lte', value: '100' }]);
  assert.equal((await products({ q: '鼠标', maxPrice: '100', attributes })).total, 0);
  const match = await products({ q: '鼠标', maxPrice: '130', attributes });
  assert.equal(match.total, 1);
  assert.deepEqual(match.items[0]?.skus.map((s) => s.id), [fixture(201)]);
  const cups = await products({ q: '保温杯', attributes: JSON.stringify([{ attributeId: fixture(33), type: 'number', op: 'eq', value: '500' }]), inStock: 'true' });
  assert.ok(!cups.items.flatMap(p => p.skus).some(s => s.id === fixture(203)), 'the original sold-out 500ml SKU must stay hidden even when other cups have stock');
  for (const sku of cups.items.flatMap(p => p.skus)) {
    assert.ok(sku.stockQuantity > 0);
    assert.ok(sku.attributes.some(a => a.id === fixture(33) && Number(a.value) === 500));
  }
});
test('tag modes are explicit, inactive tags hidden and unavailable for filtering', async () => {
  const all = await products({ tagIds: `${fixture(20)},${fixture(21)}` });
  for (const id of [fixture(101), fixture(103)]) assert.ok(all.items.some((p) => p.id === id));
  for (const p of all.items) for (const id of [fixture(20), fixture(21)]) assert.ok(p.tags.some((t) => t.id === id));
  const any = await products({ tagIds: `${fixture(20)},${fixture(21)}`, tagMode: 'any' });
  assert.ok(any.total > all.total);
  const tags = (await app.inject('/api/tags?pageSize=50')).json<Page<TagDto>>();
  assert.ok(!tags.items.some((t) => t.id === fixture(24)));
  assert.ok(!(await products()).items.flatMap((p) => p.tags).some((t) => t.id === fixture(24)));
  assert.equal((await app.inject(`/api/products?tagIds=${fixture(24)}`)).statusCode, 400);
});
test('false is a real attribute value; missing does not mean false', async () => {
  const result = await products({ attributes: JSON.stringify([{ attributeId: fixture(31), type: 'boolean', op: 'eq', value: false }]) });
  assert.ok(result.items.some((p) => p.id === fixture(103)));
  for (const p of result.items) for (const sku of p.skus) assert.ok(sku.attributes.some((a) => a.id === fixture(31) && a.value === false));
});
test('invalid input, unknown attributes and type/enum mismatches return 400', async () => {
  for (const query of ['pageSize=999', 'page=-1', 'minPrice=abc', 'minPrice=20&maxPrice=10', 'unknown=1', 'attributes=invalid']) {
    assert.equal((await app.inject(`/api/products?${query}`)).statusCode, 400, query);
  }
  for (const value of [
    { attributeId: randomUUID(), type: 'number', op: 'eq', value: '1' },
    { attributeId: fixture(30), type: 'text', op: 'eq', value: 'light' },
    { attributeId: fixture(32), type: 'text', op: 'eq', value: '不存在的颜色' },
  ]) {
    const query = new URLSearchParams({ attributes: JSON.stringify([value]) });
    assert.equal((await app.inject(`/api/products?${query}`)).statusCode, 400);
  }
});
test('detail endpoints validate IDs, enforce batch limits and hide drafts', async () => {
  assert.equal((await app.inject(`/api/products/${fixture(105)}`)).statusCode, 404);
  assert.equal((await app.inject('/api/products/not-a-uuid')).statusCode, 400);
  const result = await app.inject({ method: 'POST', url: '/api/products/details', payload: { ids: [fixture(103), fixture(100), fixture(105)] } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().items.map((p: ProductDto) => p.id), [fixture(103), fixture(100)]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/products/details', payload: { ids: Array(11).fill(fixture(100)) } })).statusCode, 400);
});
test('database has all 20 business tables', async () => {
  const tables = await db.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
  assert.equal(tables.length, 20);
  for (const name of ['chat_channels','chat_read_states','conversations','messages','inquiries','saved_addresses']) assert.ok(tables.some((t) => t.table_name === name));
});
test('database rejects NULL mock payment method on a paid order', async () => {
  await assert.rejects(db.order.create({ data: { shop_id: DEFAULT_SHOP_ID, shop_name: '拾物',
    order_no: `TEST-${randomUUID().slice(0, 20)}`, buyer_id: fixture(1), checkout_key: randomUUID(),
    checkout_payload_hash: 'a'.repeat(64), status: 'pending_shipment', total_amount: '1.00',
    recipient_name: '约束测试', recipient_phone: '13800000000', recipient_address: '测试地址', paid_at: new Date(),
  } }), /orders_state_check/);
});
test('database rejects multiple typed values and duplicate case-insensitive tags', async () => {
  await assert.rejects(db.skuAttributeValue.create({ data: {
    sku_id: fixture(204), attribute_definition_id: fixture(31), text_value: 'false', boolean_value: false,
  } }), /sku_attribute_values_one_value_check/);
  const name = `case-${randomUUID()}`;
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.tag.create({ data: { shop_id: DEFAULT_SHOP_ID, name } });
    await tx.tag.create({ data: { shop_id: DEFAULT_SHOP_ID, name: name.toUpperCase() } });
  }), /tags_name_lower_key|Unique constraint/);
});

test('database prevents two active human inquiries for one conversation', async () => {
  await assert.rejects(db.$transaction(async (tx) => {
    const channel = await tx.chatChannel.create({ data: { shop_id: DEFAULT_SHOP_ID, buyer_id: fixture(1) } });
    const conversation = await tx.conversation.create({ data: { channel_id: channel.id, shop_id: DEFAULT_SHOP_ID, buyer_id: fixture(1) } });
    const message = await tx.message.create({ data: { channel_id: channel.id, sequence: 1, conversation_id: conversation.id, sender_type: 'buyer', sender_user_id: fixture(1), content: '需要人工说明材质' } });
    const inquiry = { conversation_id: conversation.id, trigger_message_id: message.id, question: '材质是什么？', reason: 'user_request' };
    await tx.inquiry.create({ data: inquiry });
    await tx.inquiry.create({ data: inquiry });
  }), /inquiries_one_active_per_conversation|Unique constraint/);
});

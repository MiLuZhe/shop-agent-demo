import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import { buildApp } from './app.ts';
import { assertImageOwnership, createTosClient, type ImageStore } from './catalog/image-store.ts';

const db = createDatabase(), prefix = `media_${randomUUID().slice(0, 8)}`;
const shops = [randomUUID(), randomUUID()], users = Array.from({ length: 5 }, () => randomUUID());
const cookies: string[] = [], uploads = new Map<string, Buffer>();
let revokeDuringPut = false;
const store: ImageStore = {
  kind: 'tos',
  async put(shopId, filename, bytes) {
    uploads.set(`${shopId}/${filename}`, bytes);
    if (revokeDuringPut) await db.shopMember.updateMany({ where: { shop_id: shops[0], user_id: users[0] }, data: { status: 'disabled' } });
    return {};
  },
  async remove(shopId, filename) { uploads.delete(`${shopId}/${filename}`); },
  async read(shopId, filename) { return { redirect: `https://example.test/${shopId}/${filename}?X-Tos-Expires=300` }; },
  async readLegacy(filename) { return { redirect: `https://example.test/legacy/${filename}?X-Tos-Expires=300` }; },
};
const app = buildApp(db, false, {}, {}, store);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
before(async () => {
  const password_hash = await hashPassword('MediaTest123!');
  await db.shop.createMany({ data: shops.map((id, i) => ({ id, slug: `${prefix}-${i}`, name: `${prefix}-${i}` })) });
  await db.user.createMany({ data: users.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: '图片权限测试', password_hash, account_kind: i < 2 || i === 4 ? 'work' : 'customer', platform_role: i === 4 ? 'admin' : 'user' })) });
  for (let i = 0; i < 2; i++) await db.shopMember.create({ data: { shop_id: shops[i]!, user_id: users[i]!, role: 'manager' } });
  await app.ready();
  for (let i = 0; i < users.length; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_${i}`, password: 'MediaTest123!' } });
    assert.equal(r.statusCode, 200); cookies.push(String(r.headers['set-cookie']).split(';')[0]!);
  }
});
after(async () => {
  try {
    await db.message.deleteMany({ where: { channel: { shop_id: { in: shops } } } });
    await db.conversation.deleteMany({ where: { shop_id: { in: shops } } });
    await db.chatChannel.deleteMany({ where: { shop_id: { in: shops } } });
    await db.sku.deleteMany({ where: { product: { shop_id: { in: shops } } } });
    await db.product.deleteMany({ where: { shop_id: { in: shops } } });
    await db.shopMember.deleteMany({ where: { shop_id: { in: shops } } });
    await db.shop.deleteMany({ where: { id: { in: shops } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  } finally { await app.close(); }
});
const get = (url: string, identity?: number) => app.inject({ method: 'GET', url, headers: identity === undefined ? {} : { cookie: cookies[identity]! } });
const upload = (identity = 0, bytes = png, mime = 'image/png') => app.inject({ method: 'POST', url: '/api/seller/uploads', headers: { cookie: cookies[identity]!, 'x-shop-id': shops[0]!, 'content-type': mime }, payload: bytes });

test('private uploads require shop authority, valid content and bounded size', async () => {
  for (const identity of [1, 2, 3, 4]) assert.equal((await upload(identity)).statusCode, 403);
  assert.equal((await upload(0, Buffer.from('not png'))).statusCode, 400);
  assert.equal((await upload(0, png, 'image/jpeg')).statusCode, 400);
  assert.equal((await upload(0, Buffer.alloc(4 * 1024 * 1024 + 1))).statusCode, 413);
  assert.equal(uploads.size, 0);
});
test('draft upload preview is shop-scoped; public goods use fresh no-store redirects', async () => {
  const r = await upload(); assert.equal(r.statusCode, 201);
  const url = r.json<{ url: string }>().url;
  assert.ok(!url.includes('?'));
  for (const identity of [undefined, 1, 2, 3, 4]) assert.equal((await get(url, identity)).statusCode, 404);
  const own = await get(url, 0); assert.equal(own.statusCode, 302);
  assert.equal(own.headers['cache-control'], 'private, no-store');
  assert.equal(own.headers['referrer-policy'], 'no-referrer');
  const p = await db.product.create({ data: { shop_id: shops[0]!, name: `${prefix}-published`, status: 'active', image_urls: [url], skus: { create: { sku_code: `${prefix}-sku`, name: '默认', price: '1.00', stock_quantity: 1 } } } });
  assert.equal((await get(url)).statusCode, 302);
  await db.product.update({ where: { id: p.id }, data: { status: 'inactive' } });
  assert.equal((await get(url)).statusCode, 404);
  const channel = await db.chatChannel.create({ data: { shop_id: shops[0]!, buyer_id: users[2]! } });
  const round = await db.conversation.create({ data: { channel_id: channel.id, shop_id: shops[0]!, buyer_id: users[2]! } });
  await db.message.create({ data: { channel_id: channel.id, conversation_id: round.id, sequence: 1, sender_type: 'buyer', sender_user_id: users[2]!, content: '商品咨询', product_context: { id: p.id, name: p.name, imageUrl: url } } });
  assert.equal((await get(url, 2)).statusCode, 302);
  assert.equal((await get(url, 3)).statusCode, 404);
  assert.equal((await get(url, 4)).statusCode, 404);
  const cardUrl = `/api/uploads/${shops[0]}/${randomUUID()}.png`;
  await db.message.create({ data: { channel_id: channel.id, conversation_id: round.id, sequence: 2, sender_type: 'agent', content: '历史推荐', product_cards: [{ productId: p.id, imageUrl: cardUrl }] } });
  assert.equal((await get(cardUrl, 2)).statusCode, 302);
  assert.equal((await get(cardUrl, 3)).statusCode, 404);
});
test('managed images cannot be attached across shops or saved with transient signatures', async () => {
  const foreign = `/api/uploads/${shops[1]}/${randomUUID()}.png`;
  assert.throws(() => assertImageOwnership([foreign], shops[0]!), /本店/);
  assert.throws(() => assertImageOwnership(['https://example.test/image.png?X-Tos-Signature=temporary'], shops[0]!), /临时/);
  const r = await app.inject({ method: 'POST', url: '/api/seller/products', headers: { cookie: cookies[0]!, 'x-shop-id': shops[0]! }, payload: { name: `${prefix}-invalid`, description: null, categoryId: null, tagIds: [], imageUrls: [foreign], status: 'draft', defaultSku: { skuCode: `${prefix}-invalid`, name: '默认', price: '1.00', stockQuantity: 1, isActive: true, attributes: [] } } });
  assert.equal(r.statusCode, 400); assert.equal(r.json().error.code, 'IMAGE_SHOP_MISMATCH');
  assert.equal((await get(`/api/uploads/${shops[0]}/not-a-uuid.png`, 0)).statusCode, 404);
});
test('revocation during cloud upload rejects success and removes the new object', async () => {
  const before = uploads.size; revokeDuringPut = true;
  try { assert.equal((await upload()).statusCode, 403); assert.equal(uploads.size, before); }
  finally { revokeDuringPut = false; await db.shopMember.updateMany({ where: { shop_id: shops[0], user_id: users[0] }, data: { status: 'active' } }); }
});
test('legacy image redirects cannot select arbitrary object prefixes', async () => {
  assert.equal((await get('/demo-media/pexels-7265965.jpg')).statusCode, 302);
  assert.equal((await get('/demo-media/not-a-picture.txt')).statusCode, 404);
  assert.equal((await get('/demo-media/%2e%2e%2fsecret.jpg')).statusCode, 404);
});
test('TOS configuration is HTTPS-scoped and preserves existing proxy exclusions', () => {
  const keys = ['TOS_REGION', 'TOS_ENDPOINT', 'TOS_BUCKET', 'TOS_ACCESS_KEY', 'TOS_SECRET_KEY', 'NO_PROXY', 'no_proxy'] as const;
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, { TOS_REGION: 'cn-shanghai', TOS_ENDPOINT: 'tos-cn-shanghai.volces.com', TOS_BUCKET: 'test-bucket', TOS_ACCESS_KEY: 'test-access-key', TOS_SECRET_KEY: 'test-secret-key', NO_PROXY: 'example.org', no_proxy: 'example.net' });
    const { client } = createTosClient();
    assert.ok(client);
    for (const name of ['example.org','example.net','tos-cn-shanghai.volces.com','test-bucket.tos-cn-shanghai.volces.com']) assert.ok(process.env.NO_PROXY!.split(',').includes(name));
    process.env.TOS_ENDPOINT = 'http://127.0.0.1'; assert.throws(createTosClient, /configuration/);
  } finally { for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});

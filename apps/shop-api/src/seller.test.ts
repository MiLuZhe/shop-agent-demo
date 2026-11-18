import { DEFAULT_SHOP_ID } from '@shop/contracts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import type { CategoryWrite, TagWrite, DefinitionWrite, ProductWrite, SkuWrite, SellerProductDetailDto, SellerCategoryDto, SellerTagDto, SellerDefinitionDto, SellerSkuDto } from '@shop/contracts';
import { buildApp } from './app.ts';

const db = createDatabase(), app = buildApp(db, false);
const prefix = `manage_${randomUUID().slice(0, 8)}`;
const userIds = [randomUUID(), randomUUID()];
const productIds: string[] = [], categoryIds: string[] = [], tagIds: string[] = [], definitionIds: string[] = [];
let cookie = '', buyerCookie = '';
let counter = 0;
const unique = (label: string) => `${prefix}_${label}_${++counter}`;
const category = (): CategoryWrite => ({ name: unique('category'), description: null, isActive: true, sortOrder: 0 });
const tag = (): TagWrite => ({ ...category(), name: unique('tag'), groupName: '场景' });
const definition = (dataType: DefinitionWrite['dataType'] = 'text'): DefinitionWrite => ({ code: unique('attr'), name: unique('attribute'), dataType, unit: dataType === 'number' ? 'g' : null, options: dataType === 'enum' ? ['甲', '乙'] : null, isFilterable: true, sortOrder: 0 });
const sku = (): SkuWrite => ({ skuCode: unique('sku'), name: '默认规格', price: '12.30', stockQuantity: 10, isActive: true, attributes: [] });
const product = (): ProductWrite & { defaultSku: SkuWrite } => ({ name: unique('product'), description: '管理测试说明', categoryId: null, tagIds: [], status: 'draft', imageUrls: [], defaultSku: sku() });
const productBody = (p: SellerProductDetailDto) => ({ name: p.name, description: p.description, categoryId: p.categoryId, tagIds: p.tagIds, status: p.status, imageUrls: p.imageUrls, version: p.version });
const skuBody = (s: SellerSkuDto) => ({ skuCode: s.skuCode, name: s.name, price: s.price, stockQuantity: s.stockQuantity, isActive: s.isActive, attributes: s.attributes, version: s.version });
const categoryBody = (c: SellerCategoryDto) => ({ name: c.name, description: c.description, sortOrder: c.sortOrder, isActive: c.isActive, version: c.version });
const tagBody = (t: SellerTagDto) => ({ ...categoryBody(t), groupName: t.groupName });
const definitionBody = (d: SellerDefinitionDto) => ({ code: d.code, name: d.name, dataType: d.dataType, unit: d.unit, options: d.options, isFilterable: d.isFilterable, sortOrder: d.sortOrder, version: d.version });
async function request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: unknown, auth = cookie) {
  return app.inject({ method, url: `/api${path}`, headers: { ...(auth ? { cookie: auth } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
}
async function create<T extends { id: string }>(path: string, body: unknown, ids: string[]): Promise<T> {
  const r = await request('POST', `/seller/${path}`, body);
  assert.equal(r.statusCode, 201, r.body); const row = r.json<T>(); ids.push(row.id); return row;
}
const createProduct = (p = product()) => create<SellerProductDetailDto>('products', p, productIds);
const createCategory = (c = category()) => create<SellerCategoryDto>('categories', c, categoryIds);
const createTag = (t = tag()) => create<SellerTagDto>('tags', t, tagIds);
const createDefinition = (d = definition()) => create<SellerDefinitionDto>('attributes', d, definitionIds);
async function getProduct(id: string) { return (await request('GET', `/seller/products/${id}`)).json<SellerProductDetailDto>(); }
before(async () => {
  const password_hash = await hashPassword('ManageTest123!');
  await db.user.createMany({ data: userIds.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: '管理测试账号', password_hash })) });
  await db.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: userIds[0]! } });
  await app.ready();
  for (let i = 0; i < 2; i++) {
    const r = await request('POST', '/auth/login', { username: `${prefix}_${i}`, password: 'ManageTest123!' }, '');
    assert.equal(r.statusCode, 200, r.body);
    const value = String(r.headers['set-cookie']).split(';')[0]!;
    if (i) buyerCookie = value; else cookie = value;
  }
});
after(async () => {
  try {
    const skus = await db.sku.findMany({ where: { product_id: { in: productIds } }, select: { id: true } });
    await db.skuAttributeValue.deleteMany({ where: { sku_id: { in: skus.map((s) => s.id) } } });
    await db.sku.deleteMany({ where: { product_id: { in: productIds } } });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
    await db.category.deleteMany({ where: { id: { in: categoryIds } } });
    await db.tag.deleteMany({ where: { id: { in: tagIds } } });
    await db.attributeDefinition.deleteMany({ where: { id: { in: definitionIds } } });
    await db.shopMember.deleteMany({ where: { user_id: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally { await app.close(); }
});

test('all seller management routes require a live seller identity', async () => {
  const id = randomUUID();
  const routes = [
    ...['categories', 'tags', 'attributes', 'products'].flatMap((name) => [
      ['GET', `/seller/${name}`], ['POST', `/seller/${name}`], ['PUT', `/seller/${name}/${id}`],
      ...(name !== 'products' ? [['DELETE', `/seller/${name}/${id}`]] : []),
    ]),
    ['GET', `/seller/products/${id}`], ['POST', `/seller/tags/${id}/merge`], ['POST', `/seller/products/${id}/skus`], ['PUT', `/seller/products/${id}/skus/${id}`],
  ] as Array<['GET' | 'POST' | 'PUT' | 'DELETE', string]>;
  for (const [method, path] of routes) {
    for (const [auth, status] of [['', 401], [buyerCookie, 403]] as const) {
      const r = await request(method, path, method === 'GET' ? undefined : {}, auth); assert.equal(r.statusCode, status, `${method} ${path}: ${r.body}`);
    }
  }
});
test('seller image upload validates identity, format and serves the saved image', async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  const send = (auth: string, payload: Buffer, contentType = 'image/png') => app.inject({ method: 'POST', url: '/api/seller/uploads', headers: { ...(auth ? { cookie: auth } : {}), 'content-type': contentType }, payload });
  assert.equal((await send('', image)).statusCode, 401);
  assert.equal((await send(buyerCookie, image)).statusCode, 403);
  assert.equal((await send(cookie, Buffer.from('not an image'))).statusCode, 400);
  assert.equal((await send(cookie, image, 'image/jpeg')).statusCode, 400);
  const response = await send(cookie, image);
  assert.equal(response.statusCode, 201, response.body);
  const url = response.json<{ url: string }>().url;
  try {
    assert.match(url, /^\/api\/uploads\/[0-9a-f-]+\/[0-9a-f-]+\.png$/);
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
    const served = await app.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.deepEqual(served.rawPayload, image);
    assert.deepEqual((await createProduct({ ...product(), imageUrls: [url] })).imageUrls, [url]);
  } finally {
    await unlink(path.resolve(process.env.SHOP_UPLOAD_DIR ?? 'data/uploads', url.replace('/api/uploads/', '')));
  }
});
test('categories support versioned edits, disable without hiding goods, and protected deletion', async () => {
  const c = await createCategory();
  const p = await createProduct({ ...product(), categoryId: c.id, status: 'active' });
  const r = await request('PUT', `/seller/categories/${c.id}`, { ...categoryBody(c), name: unique('renamed'), isActive: false });
  assert.equal(r.statusCode, 200, r.body); const next = r.json<SellerCategoryDto>();
  assert.equal((await request('PUT', `/seller/categories/${c.id}`, categoryBody(c))).statusCode, 409);
  assert.equal((await request('DELETE', `/seller/categories/${c.id}`, { version: next.version })).statusCode, 409);
  const publicRow = await request('GET', `/products/${p.id}`, undefined, '');
  assert.equal(publicRow.statusCode, 200); assert.equal(publicRow.json().category, null);
  assert.equal((await request('POST', '/seller/products', { ...product(), categoryId: c.id })).statusCode, 400);
  assert.equal((await request('PUT', `/seller/products/${p.id}`, { ...productBody(p), name: unique('changed') })).statusCode, 200);
  const updated = await getProduct(p.id);
  assert.equal((await request('PUT', `/seller/products/${p.id}`, { ...productBody(updated), categoryId: null })).statusCode, 200);
  assert.equal((await request('DELETE', `/seller/categories/${c.id}`, { version: next.version })).statusCode, 200);
});
test('tag names are trimmed and unique across groups and letter case; duplicate bindings rejected', async () => {
  const t = await createTag({ ...tag(), name: `  ${unique('Mixed')}  ` });
  assert.equal(t.name, t.name.trim());
  assert.equal((await request('POST', '/seller/tags', { ...tag(), name: t.name.toUpperCase(), groupName: '其他组' })).statusCode, 409);
  assert.equal((await request('POST', '/seller/products', { ...product(), tagIds: [t.id, t.id] })).statusCode, 400);
  const p = await createProduct({ ...product(), status: 'active', tagIds: [t.id] });
  const r = await request('PUT', `/seller/tags/${t.id}`, { ...tagBody(t), name: unique('新标签'), groupName: '用途', isActive: false });
  assert.equal(r.statusCode, 200, r.body);
  const pub = await request('GET', `/products/${p.id}`, undefined, '');
  assert.equal(pub.statusCode, 200); assert.deepEqual(pub.json().tags, []);
  assert.deepEqual((await getProduct(p.id)).tagIds, [t.id]);
  assert.equal((await request('GET', `/products?tagIds=${t.id}`, undefined, '')).statusCode, 400);
  assert.equal((await request('POST', '/seller/products', { ...product(), tagIds: [t.id] })).statusCode, 400);
  assert.equal((await request('PUT', `/seller/products/${p.id}`, productBody(p))).statusCode, 200);
});
test('tag merge deduplicates and preserves all associations, disables source and invalidates stale product edits', async () => {
  const source = await createTag(), target = await createTag();
  const one = await createProduct({ ...product(), status: 'active', tagIds: [source.id, target.id] });
  const two = await createProduct({ ...product(), tagIds: [source.id] });
  assert.equal((await request('POST', `/seller/tags/${source.id}/merge`, { targetId: source.id, version: source.version, targetVersion: source.version })).statusCode, 400);
  const r = await request('POST', `/seller/tags/${source.id}/merge`, { targetId: target.id, version: source.version, targetVersion: target.version });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().movedProductCount, 2);
  assert.deepEqual((await getProduct(one.id)).tagIds, [target.id]); assert.deepEqual((await getProduct(two.id)).tagIds, [target.id]);
  assert.equal((await db.tag.findUniqueOrThrow({ where: { id: source.id } })).is_active, false);
  assert.equal((await request('PUT', `/seller/products/${one.id}`, productBody(one))).statusCode, 409);
  assert.equal((await request('DELETE', `/seller/tags/${target.id}`, { version: (await db.tag.findUniqueOrThrow({ where: { id: target.id } })).updated_at.toISOString() })).statusCode, 409);
  const freshSource = await db.tag.findUniqueOrThrow({ where: { id: source.id } });
  assert.equal((await request('DELETE', `/seller/tags/${source.id}`, { version: freshSource.updated_at.toISOString() })).statusCode, 200);
});
test('invalid target merge rolls back and renaming propagates to public display', async () => {
  const source = await createTag(), target = await createTag({ ...tag(), isActive: false });
  const p = await createProduct({ ...product(), status: 'active', tagIds: [source.id] });
  assert.equal((await request('POST', `/seller/tags/${source.id}/merge`, { targetId: target.id, version: source.version, targetVersion: target.version })).statusCode, 409);
  assert.deepEqual((await getProduct(p.id)).tagIds, [source.id]);
  const renamed = unique('新显示名称');
  assert.equal((await request('PUT', `/seller/tags/${source.id}`, { ...tagBody(source), name: renamed })).statusCode, 200);
  assert.equal((await request('GET', `/products/${p.id}`, undefined, '')).json().tags[0].name, renamed);
});
test('shared attributes validate definition shapes and stable codes', async () => {
  for (const v of [{ ...definition('enum'), options: [] }, { ...definition('enum'), options: ['甲', ' 甲 '] }, { ...definition('text'), options: ['甲'] }, { ...definition('boolean'), unit: 'g' }]) {
    assert.equal((await request('POST', '/seller/attributes', v)).statusCode, 400);
  }
  const d = await createDefinition({ ...definition(), code: unique('CODE').toUpperCase() });
  assert.equal(d.code, d.code.toLowerCase());
  assert.equal((await request('PUT', `/seller/attributes/${d.id}`, { ...definitionBody(d), code: unique('other') })).statusCode, 409);
  assert.equal((await request('POST', '/seller/attributes', { ...definition(), code: d.code })).statusCode, 409);
});
test('SKU attribute types, exact decimals and enum membership are enforced atomically', async () => {
  const number = await createDefinition(definition('number')), bool = await createDefinition(definition('boolean')), en = await createDefinition(definition('enum')), text = await createDefinition();
  for (const a of [{ attributeId: number.id, value: '1.00001' }, { attributeId: number.id, value: '1e3' }, { attributeId: bool.id, value: 'false' }, { attributeId: en.id, value: '丙' }, { attributeId: text.id, value: false }, { attributeId: randomUUID(), value: 'a' }]) {
    const bad = product();
    assert.equal((await request('POST', '/seller/products', { ...bad, defaultSku: { ...bad.defaultSku, attributes: [a] } })).statusCode, 400);
    assert.equal(await db.product.count({ where: { name: bad.name } }), 0);
  }
  const data = product(); data.defaultSku.attributes = [{ attributeId: number.id, value: '-12.3400' }, { attributeId: bool.id, value: false }, { attributeId: en.id, value: '甲' }, { attributeId: text.id, value: '轻便' }]; data.status = 'active';
  const p = await createProduct(data);
  assert.equal(p.skus[0]!.attributes.find((a) => a.attributeId === number.id)?.value, '-12.34');
  assert.equal(p.skus[0]!.attributes.find((a) => a.attributeId === bool.id)?.value, false);
  const s = p.skus[0]!;
  assert.equal((await request('PUT', `/seller/products/${p.id}/skus/${s.id}`, { ...skuBody(s), attributes: [{ attributeId: en.id, value: '丙' }] })).statusCode, 400);
  assert.equal((await getProduct(p.id)).skus[0]!.attributes.length, 4);
});
test('used definitions prevent incompatible changes and allow safe option expansion and renaming', async () => {
  const n = await createDefinition(definition('number')), en = await createDefinition(definition('enum'));
  const data = product(); data.defaultSku.attributes = [{ attributeId: n.id, value: '5' }, { attributeId: en.id, value: '甲' }];
  await createProduct(data);
  for (const patch of [{ dataType: 'text', unit: null }, { unit: 'kg' }]) {
    assert.equal((await request('PUT', `/seller/attributes/${n.id}`, { ...definitionBody(n), ...patch })).statusCode, 409);
  }
  assert.equal((await request('DELETE', `/seller/attributes/${n.id}`, { version: n.version })).statusCode, 409);
  assert.equal((await request('PUT', `/seller/attributes/${en.id}`, { ...definitionBody(en), options: ['乙'] })).statusCode, 409);
  assert.equal((await request('PUT', `/seller/attributes/${en.id}`, { ...definitionBody(en), options: ['甲', '丙'], name: unique('显示名') })).statusCode, 200);
  const unused = await createDefinition();
  assert.equal((await request('DELETE', `/seller/attributes/${unused.id}`, { version: unused.version })).statusCode, 200);
});
test('product creation includes default SKU, price precision, optional category and no orphan on duplicate code', async () => {
  const p = await createProduct();
  assert.equal(p.skus.length, 1); assert.equal(p.skus[0]!.price, '12.30'); assert.equal(p.categoryId, null);
  assert.equal((await request('GET', `/products/${p.id}`, undefined, '')).statusCode, 404);
  const bad = product(); bad.defaultSku.skuCode = p.skus[0]!.skuCode;
  assert.equal((await request('POST', '/seller/products', bad)).statusCode, 409);
  assert.equal(await db.product.count({ where: { name: bad.name } }), 0);
  assert.equal((await request('POST', '/seller/products', { ...product(), productId: p.id })).statusCode, 400);
});
test('last enabled SKU guard applies when publishing and disabling with parallel updates', async () => {
  const p = await createProduct({ ...product(), status: 'active' }); const first = p.skus[0]!;
  assert.equal((await request('PUT', `/seller/products/${p.id}/skus/${first.id}`, { ...skuBody(first), isActive: false })).statusCode, 409);
  const second = (await request('POST', `/seller/products/${p.id}/skus`, sku())).json<SellerSkuDto>();
  assert.ok(second.id);
  const results = await Promise.all([first, second].map((s) => request('PUT', `/seller/products/${p.id}/skus/${s.id}`, { ...skuBody(s), isActive: false })));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const fresh = await getProduct(p.id);
  assert.equal(fresh.skus.filter((s) => s.isActive).length, 1);
  assert.equal((await request('PUT', `/seller/products/${p.id}`, { ...productBody(fresh), status: 'inactive' })).statusCode, 200);
  const enabled = fresh.skus.find((s) => s.isActive)!;
  assert.equal((await request('PUT', `/seller/products/${p.id}/skus/${enabled.id}`, { ...skuBody(enabled), isActive: false })).statusCode, 200);
  const none = await getProduct(p.id);
  assert.equal((await request('PUT', `/seller/products/${p.id}`, { ...productBody(none), status: 'active' })).statusCode, 409);
});
test('SKU ownership and stable encoding are enforced; stale concurrent stock edits cannot overwrite', async () => {
  const p = await createProduct(), other = await createProduct(), s = p.skus[0]!;
  assert.equal((await request('PUT', `/seller/products/${other.id}/skus/${s.id}`, skuBody(s))).statusCode, 404);
  assert.equal((await request('PUT', `/seller/products/${p.id}/skus/${s.id}`, { ...skuBody(s), skuCode: unique('changed') })).statusCode, 409);
  const results = await Promise.all([7, 8].map((stockQuantity) => request('PUT', `/seller/products/${p.id}/skus/${s.id}`, { ...skuBody(s), stockQuantity, price: '99.99' })));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const fresh = (await getProduct(p.id)).skus[0]!;
  assert.ok([7, 8].includes(fresh.stockQuantity)); assert.equal(fresh.price, '99.99');
  assert.equal((await request('PUT', `/seller/products/${p.id}`, productBody(p))).statusCode, 409);
});
test('category changes preserve shared SKU values; bounded lists include inactive records and reject malformed writes', async () => {
  const c = await createCategory(), d = await createDefinition();
  const input = product(); input.defaultSku.attributes = [{ attributeId: d.id, value: '跨类别' }];
  const p = await createProduct(input);
  assert.equal((await request('PUT', `/seller/products/${p.id}`, { ...productBody(p), categoryId: c.id })).statusCode, 200);
  assert.deepEqual((await getProduct(p.id)).skus[0]!.attributes, p.skus[0]!.attributes);
  for (const path of ['products', 'categories', 'tags', 'attributes']) {
    const r = await request('GET', `/seller/${path}?pageSize=1&q=${prefix}`);
    assert.equal(r.statusCode, 200); assert.equal(r.json().items.length, 1); assert.ok(r.json().total > 0);
    assert.equal((await request('GET', `/seller/${path}?pageSize=51`)).statusCode, 400);
  }
  assert.equal((await request('GET', '/seller/products/no-id')).statusCode, 400);
  assert.equal((await request('GET', `/seller/products/${randomUUID()}`)).statusCode, 404);
  for (const patch of [{ price: '-1' }, { price: '1.001' }, { stockQuantity: -1 }, { stockQuantity: 0.1 }, { stockQuantity: 2147483648 }, { attributes: [{ attributeId: d.id, value: 'a' }, { attributeId: d.id, value: 'b' }] }]) {
    const s = (await getProduct(p.id)).skus[0]!;
    assert.equal((await request('PUT', `/seller/products/${p.id}/skus/${s.id}`, { ...skuBody(s), ...patch })).statusCode, 400);
  }
  assert.equal((await request('PUT', `/seller/products/${p.id}`, { ...productBody(await getProduct(p.id)), imageUrls: ['javascript:alert(1)'] })).statusCode, 400);
});

test('management limits prevent silently truncated SKU/attribute/tag edits', async () => {
  const p = await createProduct();
  await db.sku.createMany({ data: Array.from({ length: 19 }, () => ({ product_id: p.id, sku_code: unique('limit'), name: '边界规格', price: '0.00' })) });
  assert.equal((await request('POST', `/seller/products/${p.id}/skus`, sku())).statusCode, 409);
  assert.equal((await getProduct(p.id)).skus.length, 20);
  const data = product();
  assert.equal((await request('POST', '/seller/products', { ...data, tagIds: Array.from({ length: 11 }, () => randomUUID()) })).statusCode, 400);
  assert.equal((await request('POST', '/seller/products', { ...data, imageUrls: Array.from({ length: 9 }, () => 'https://example.com/picture.jpg') })).statusCode, 400);
  const eight = Array.from({ length: 8 }, (_, i) => `/demo-media/example-${i}.jpg`);
  const accepted = await request('POST', '/seller/products', { ...product(), imageUrls: eight });
  assert.equal(accepted.statusCode, 201, accepted.body);
  productIds.push(accepted.json<SellerProductDetailDto>().id);
  assert.deepEqual(accepted.json<SellerProductDetailDto>().imageUrls, eight);
  for (const image of ['data:image/png;base64,abc', 'javascript:alert(1)', '//example.com/a.jpg', '/demo-media/../private.jpg']) {
    assert.equal((await request('POST', '/seller/products', { ...product(), imageUrls: [image] })).statusCode, 400);
  }
  assert.equal((await request('POST', '/seller/products', { ...data, defaultSku: { ...data.defaultSku, attributes: Array.from({ length: 21 }, () => ({ attributeId: randomUUID(), value: '1' })) } })).statusCode, 400);
});

test('tag binding and merge cannot leave a new binding on an inactive source', async () => {
  const source = await createTag(), target = await createTag(), p = await createProduct();
  const [binding, merge] = await Promise.all([
    request('PUT', `/seller/products/${p.id}`, { ...productBody(p), tagIds: [source.id] }),
    request('POST', `/seller/tags/${source.id}/merge`, { targetId: target.id, version: source.version, targetVersion: target.version }),
  ]);
  assert.equal(merge.statusCode, 200, merge.body);
  assert.ok([200, 400].includes(binding.statusCode), binding.body);
  assert.equal(await db.productTag.count({ where: { tag_id: source.id } }), 0);
  assert.deepEqual((await getProduct(p.id)).tagIds, binding.statusCode === 200 ? [target.id] : []);
});

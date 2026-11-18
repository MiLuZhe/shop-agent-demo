import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import type { SavedAddressDto } from '@shop/contracts';
import { buildApp } from './app.ts';

test('saved addresses validate inputs, isolate owners, enforce three slots concurrently and reject stale writes', async () => {
  const db = createDatabase(), app = buildApp(db, false, { loginLimit: 200 });
  const ids = [randomUUID(), randomUUID()], prefix = `address_${randomUUID().slice(0, 8)}`, password = 'AddressTest123!';
  const cookies: string[] = [];
  const input = { recipientName: '测试收件人', recipientPhone: '13800000000', recipientAddress: '测试省测试市测试街道 1 号' };
  const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path = '', body?: unknown, user = 0) => app.inject({ method, url: `/api/account/addresses${path}`, headers: { cookie: cookies[user] ?? '', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  try {
    const password_hash = await hashPassword(password);
    await db.user.createMany({ data: ids.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: '测试', password_hash })) });
    for (let i = 0; i < ids.length; i++) {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_${i}`, password } });
      assert.equal(login.statusCode, 200, login.body); cookies[i] = String(login.headers['set-cookie']).split(';')[0]!;
    }
    assert.equal((await req('GET', '', undefined, -1)).statusCode, 401);
    for (const patch of [{ recipientName: ' ' }, { recipientPhone: '123' }, { recipientPhone: 'abcdefghi' }, { recipientAddress: '短' }, { recipientAddress: 'x'.repeat(501) }, { userId: ids[1] }, { slot: 4 }]) assert.equal((await req('POST', '', { ...input, ...patch })).statusCode, 400);
    const first = await req('POST', '', input); assert.equal(first.statusCode, 201, first.body); const address = first.json<SavedAddressDto>();
    assert.ok(!first.body.includes(ids[0]!));
    assert.equal((await req('POST', '', input)).statusCode, 200);
    assert.equal((await req('GET', '', undefined, 1)).json().items.length, 0);
    assert.equal((await req('PUT', `/${address.id}`, { ...input, version: address.version }, 1)).statusCode, 404);
    assert.equal((await req('DELETE', `/${address.id}`, { version: address.version }, 1)).statusCode, 404);
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, i) => req('POST', '', { ...input, recipientName: `测试收件人${i}` })));
    assert.equal(concurrent.filter((r) => r.statusCode === 201).length, 2);
    assert.equal(concurrent.filter((r) => r.statusCode === 409).length, 3);
    assert.equal(await db.savedAddress.count({ where: { user_id: ids[0] } }), 3);
    await assert.rejects(db.savedAddress.create({ data: { user_id: ids[0]!, slot: 4, recipient_name: '测试', recipient_phone: input.recipientPhone, recipient_address: input.recipientAddress } }));
    const changed = await req('PUT', `/${address.id}`, { ...input, recipientName: '更新收件人', version: address.version }); assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await req('PUT', `/${address.id}`, { ...input, version: address.version })).statusCode, 409);
    assert.equal((await req('DELETE', `/${address.id}`, { version: address.version })).statusCode, 409);
    assert.equal((await req('DELETE', `/${address.id}`, { version: changed.json<SavedAddressDto>().version })).statusCode, 200);
    assert.equal((await req('POST', '', input)).statusCode, 201);
    assert.equal((await req('POST', '', input, 1)).statusCode, 201);
    const crossSite = await app.inject({ method: 'POST', url: '/api/account/addresses', headers: { cookie: cookies[0], origin: 'https://untrusted.example' }, payload: input }); assert.equal(crossSite.statusCode, 403);
  } finally { await db.user.deleteMany({ where: { id: { in: ids } } }); await app.close(); await db.$disconnect(); }
});

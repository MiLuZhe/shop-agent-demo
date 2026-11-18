import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import type { Page, ShopMemberDto } from '@shop/contracts';
import { buildApp } from './app.ts';

const db = createDatabase(), app = buildApp(db, false, { loginLimit: 200 });
const prefix = `members_${randomUUID().slice(0, 8)}`, shops = [randomUUID(), randomUUID()];
// buyer, owner, manager, staff, platform admin, other-shop owner, new candidate.
const users = Array.from({ length: 7 }, () => randomUUID()), cookies: string[] = [];
const memberIds: string[] = [];
async function req(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, user = 1, shop = shops[0]) {
  return app.inject({ method, url: `/api${path}`, headers: { cookie: cookies[user] ?? '', 'x-shop-id': shop!,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
}
async function member(index: number) {
  const result = await req('GET', '/seller/members?pageSize=50');
  assert.equal(result.statusCode, 200, result.body);
  return result.json<Page<ShopMemberDto>>().items.find((row) => row.username === `${prefix}_${index}`)!;
}
function update(row: ShopMemberDto, patch: Record<string, unknown> = {}) {
  return { role: row.role, status: row.status, version: row.version, ...patch };
}
before(async () => {
  const password_hash = await hashPassword('Members123!');
  await db.user.createMany({ data: users.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: `成员测试${i}`, password_hash, account_kind: i === 6 ? 'work' : 'customer', platform_role: i === 4 ? 'admin' : 'user' })) });
  await db.shop.createMany({ data: shops.map((id, i) => ({ id, slug: `${prefix}_${i}`, name: `成员测试店${i}` })) });
  for (const [i, role, shop] of [[1, 'owner', 0], [2, 'manager', 0], [3, 'staff', 0], [5, 'owner', 1]] as const) {
    const row = await db.shopMember.create({ data: { shop_id: shops[shop]!, user_id: users[i]!, role } }); memberIds[i] = row.id;
  }
});
beforeEach(async () => {
  await db.shopMember.deleteMany({ where: { user_id: { in: [users[0]!, users[4]!, users[6]!] } } });
  await db.shop.updateMany({ where: { id: { in: shops } }, data: { status: 'active' } });
  for (const [i, role] of [[1, 'owner'], [2, 'manager'], [3, 'staff']] as const) {
    await db.shopMember.update({ where: { id: memberIds[i] }, data: { role, status: 'active' } });
  }
  for (let i = 0; i < users.length; i++) {
    await db.user.update({ where: { id: users[i] }, data: { status: 'active' } });
    const response = await req('POST', '/auth/login', { username: `${prefix}_${i}`, password: 'Members123!' }, -1);
    assert.equal(response.statusCode, 200, response.body); cookies[i] = String(response.headers['set-cookie']).split(';')[0]!;
  }
});
after(async () => {
  try { await db.shopMember.deleteMany({ where: { shop_id: { in: shops } } }); await db.shop.deleteMany({ where: { id: { in: shops } } }); await db.user.deleteMany({ where: { id: { in: users } } }); }
  finally { await app.close(); }
});
test('production member routes enforce the full role matrix and return safe, shop-scoped fields', async () => {
  const row = await member(3);
  for (const i of [-1, 0, 2, 3, 4, 5]) {
    for (const [method, path, body] of [
      ['GET', '/seller/members', undefined], ['POST', '/seller/members', { username: `${prefix}_6`, role: 'staff' }],
      ['PUT', `/seller/members/${row.id}`, update(row, { role: 'manager' })],
    ] as const) assert.equal((await req(method, path, body, i)).statusCode, i === -1 ? 401 : 403);
  }
  assert.equal((await req('GET', '/seller/members', undefined, 1, shops[1])).statusCode, 403);
  const response = await req('GET', '/seller/members?q=' + encodeURIComponent(prefix));
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.json().total, 3);
  assert.deepEqual(Object.keys(response.json().items[0]).sort(), ['displayName','id','role','status','userStatus','username','version']);
  assert.ok(!response.body.includes('password')); assert.ok(!response.body.includes('auth_version'));
});
test('owner can add existing users, change manager/staff, disable and restore without affecting platform identity', async () => {
  const original = await db.user.findUniqueOrThrow({ where: { id: users[6] } });
  const added = await req('POST', '/seller/members', { username: `${prefix}_6`.toUpperCase(), role: 'staff' });
  assert.equal(added.statusCode, 201, added.body); let row = added.json<ShopMemberDto>();
  assert.equal((await req('GET', '/seller/overview', undefined, 6)).statusCode, 200);
  assert.equal((await req('POST', '/seller/categories', { name: '禁止', description: null, isActive: true, sortOrder: 0 }, 6)).statusCode, 403);
  const promoted = await req('PUT', `/seller/members/${row.id}`, update(row, { role: 'manager' })); assert.equal(promoted.statusCode, 200, promoted.body); row = promoted.json();
  const category = await req('POST', '/seller/categories', { name: prefix, description: null, isActive: true, sortOrder: 0 }, 6); assert.equal(category.statusCode, 201, category.body);
  await db.category.delete({ where: { id: category.json().id } });
  const disabled = await req('PUT', `/seller/members/${row.id}`, update(row, { status: 'disabled' })); assert.equal(disabled.statusCode, 200, disabled.body); row = disabled.json();
  assert.equal((await req('GET', '/seller/overview', undefined, 6)).statusCode, 403); assert.equal((await req('GET', '/orders', undefined, 6)).statusCode, 403);
  assert.equal((await req('POST', '/seller/members', { username: `${prefix}_6`, role: 'staff' })).statusCode, 409);
  const restored = await req('PUT', `/seller/members/${row.id}`, update(row, { status: 'active', role: 'staff' })); assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((await req('GET', '/seller/overview', undefined, 6)).statusCode, 200);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: users[6] } }), original);
});
test('no owner creation, owner removal, self-demotion, platform grants, or cross-shop member mutation', async () => {
  const owner = await member(1), staff = await member(3);
  for (const patch of [{ role: 'staff' }, { role: 'manager', status: 'disabled' }]) assert.equal((await req('PUT', `/seller/members/${owner.id}`, update(owner, patch))).statusCode, 403);
  for (const role of ['owner','admin','root','__proto__']) {
    assert.equal((await req('POST', '/seller/members', { username: `${prefix}_6`, role })).statusCode, 400);
    assert.equal((await req('PUT', `/seller/members/${staff.id}`, update(staff, { role }))).statusCode, 400);
  }
  for (const extra of [{ shopId: shops[1] }, { userId: users[4] }, { platformRole: 'admin' }, { permissions: ['members:manage'] }]) {
    assert.equal((await req('PUT', `/seller/members/${staff.id}`, { ...update(staff), ...extra })).statusCode, 400);
  }
  assert.equal((await req('PUT', `/seller/members/${memberIds[5]}`, update(staff))).statusCode, 404);
  assert.equal((await member(1)).role, 'owner');
});
test('stale and concurrent updates cannot overwrite a newer membership decision', async () => {
  const row = await member(3);
  const results = await Promise.all([
    req('PUT', `/seller/members/${row.id}`, update(row, { status: 'disabled' })),
    req('PUT', `/seller/members/${row.id}`, update(row, { role: 'manager' })),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await req('PUT', `/seller/members/${row.id}`, update(row))).statusCode, 409);
});
test('concurrent additions serialize to one member; nonexistent and disabled accounts cannot join', async () => {
  const results = await Promise.all([0,1].map(() => req('POST', '/seller/members', { username: `${prefix}_6`, role: 'staff' })));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal((await req('POST', '/seller/members', { username: `${prefix}_missing`, role: 'staff' })).statusCode, 404);
  await db.user.update({ where: { id: users[0] }, data: { status: 'disabled' } });
  assert.equal((await req('POST', '/seller/members', { username: `${prefix}_0`, role: 'staff' })).statusCode, 404);
  const row = results.find((r) => r.statusCode === 201)!.json<ShopMemberDto>();
  assert.equal((await req('PUT', `/seller/members/${row.id}`, update(row, { status: 'disabled' }))).statusCode, 200);
  const disabled = await member(6); await db.user.update({ where: { id: users[6] }, data: { status: 'disabled' } });
  assert.equal((await req('PUT', `/seller/members/${row.id}`, update(disabled, { status: 'active' }))).statusCode, 409);
});
test('revoked and downgraded actors lose authority immediately; disabled shops reject member management', async () => {
  const row = await member(3);
  await db.shopMember.update({ where: { id: memberIds[1] }, data: { role: 'manager' } });
  assert.equal((await req('PUT', `/seller/members/${row.id}`, update(row))).statusCode, 403);
  await db.shopMember.update({ where: { id: memberIds[1] }, data: { role: 'owner', status: 'disabled' } });
  assert.equal((await req('GET', '/seller/members')).statusCode, 403);
  await db.shopMember.update({ where: { id: memberIds[1] }, data: { status: 'active' } });
  await db.shop.update({ where: { id: shops[0] }, data: { status: 'disabled' } });
  assert.equal((await req('POST', '/seller/members', { username: `${prefix}_6`, role: 'staff' })).statusCode, 403);
});
test('a request waiting for its transaction lock cannot retain revoked owner or account authority', async () => {
  const row = await member(3);
  for (const accountChange of [false, true]) {
    let pending: ReturnType<typeof req> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id = ${shops[0]}::uuid FOR UPDATE`;
      pending = req('PUT', `/seller/members/${row.id}`, update(row, { role: 'manager' }));
      // Observe that the request passed its initial guard and is now blocked at
      // the shop lock, then revoke authority before allowing it to proceed.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM shops WHERE id = %'`;
        if (Number(rows[0]!.count) > 0) { waiting = true; break; }
        await setTimeout(20);
      }
      assert.equal(waiting, true, 'member request should wait for the shop lock');
      if (accountChange) await tx.user.update({ where: { id: users[1] }, data: { status: 'disabled' } });
      else await tx.shopMember.update({ where: { id: memberIds[1] }, data: { role: 'manager' } });
    }, { timeout: 10000 });
    const response = await pending!;
    assert.equal(response.statusCode, accountChange ? 401 : 403, response.body);
    assert.equal((await db.shopMember.findUniqueOrThrow({ where: { id: row.id } })).role, 'staff');
    await db.shopMember.update({ where: { id: memberIds[1] }, data: { role: 'owner' } });
  }
});

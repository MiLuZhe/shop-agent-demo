import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { after, afterEach, beforeEach, test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword, verifyPassword } from '@shop/database/password';
import type { AccountDto, CartItemDto, OrderDetailDto, SessionDto } from '@shop/contracts';
import { buildApp } from './app.ts';

const db = createDatabase(); let time = Date.now();
const app = buildApp(db, false, { loginLimit: 200, now: () => time });
let users: string[], names: string[], cookies: string[], shop: string, product: string, sku: string;
const password = 'AccountTest123!';
async function req(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, user = 0, cookie = cookies[user] ?? '') {
  return app.inject({ method, url: `/api${path}`, headers: { cookie, 'x-shop-id': shop, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
}
async function login(index: number, username = names[index]!) {
  const response = await req('POST', '/auth/login', { username, password }, -1);
  assert.equal(response.statusCode, 200, response.body); cookies[index] = String(response.headers['set-cookie']).split(';')[0]!; return response;
}
async function account(index = 0) { const result = await req('GET', '/account', undefined, index); assert.equal(result.statusCode, 200, result.body); return result.json<AccountDto>(); }
async function rename(index: number, username: string, version?: string, currentPassword = password) {
  return req('PUT', '/account/username', { username, currentPassword, version: version ?? (await account(index)).version }, index);
}
beforeEach(async () => {
  time += 600_001;
  const prefix = `account_${randomUUID().slice(0, 8)}`;
  users = Array.from({ length: 3 }, () => randomUUID()); names = users.map((_, i) => `${prefix}_${i}`); cookies = [];
  shop = randomUUID(); product = randomUUID(); sku = randomUUID();
  const password_hash = await hashPassword(password);
  await db.user.createMany({ data: users.map((id, i) => ({ id, username: names[i]!, display_name: '同名用户', password_hash })) });
  await db.shop.create({ data: { id: shop, slug: prefix, name: '账号测试店' } });
  await db.shopMember.createMany({ data: [{ shop_id: shop, user_id: users[0]!, role: 'staff' }, { shop_id: shop, user_id: users[2]!, role: 'owner' }] });
  await db.product.create({ data: { id: product, shop_id: shop, name: prefix, status: 'active', skus: { create: { id: sku, sku_code: prefix, name: '默认', price: '1.23', stock_quantity: 10 } } } });
  for (let i = 0; i < users.length; i++) await login(i);
});
afterEach(async () => {
  const orders = await db.order.findMany({ where: { buyer_id: { in: users } }, select: { id: true } });
  await db.orderItem.deleteMany({ where: { order_id: { in: orders.map((row) => row.id) } } }); await db.order.deleteMany({ where: { buyer_id: { in: users } } });
  await db.cartItem.deleteMany({ where: { user_id: { in: users } } }); await db.sku.deleteMany({ where: { product_id: product } }); await db.product.deleteMany({ where: { id: product } });
  await db.shopMember.deleteMany({ where: { shop_id: shop } }); await db.shop.deleteMany({ where: { id: shop } }); await db.user.deleteMany({ where: { id: { in: users } } });
});
after(() => app.close());

test('password changes verify current credentials, revoke all sessions and preserve identity and roles', async () => {
  const firstCookie = cookies[0]!, next = 'ChangedPassword123!'; await login(0); const secondCookie = cookies[0]!;
  const before = await db.user.findUniqueOrThrow({ where: { id: users[0] } }), mine = await account();
  const response = await req('PUT', '/account/password', { currentPassword: password, newPassword: next, confirmPassword: next, version: mine.version });
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { username: names[0], reauthenticate: true }); assert.match(String(response.headers['set-cookie']), /Max-Age=0/);
  for (const cookie of [firstCookie, secondCookie]) assert.equal((await req('GET', '/account', undefined, 0, cookie)).statusCode, 401);
  assert.equal((await req('POST', '/auth/login', { username: names[0], password }, -1)).statusCode, 401);
  const signedIn = await req('POST', '/auth/login', { username: names[0], password: next }, -1); assert.equal(signedIn.statusCode, 200, signedIn.body);
  const after = await db.user.findUniqueOrThrow({ where: { id: users[0] } });
  assert.equal(after.auth_version, before.auth_version + 1); assert.ok(after.password_hash !== before.password_hash); assert.equal(await verifyPassword(next, after.password_hash), true);
  for (const key of ['id','username','display_name','platform_role','status'] as const) assert.equal(after[key], before[key]);
  assert.equal((await db.shopMember.findUniqueOrThrow({ where: { shop_id_user_id: { shop_id: shop, user_id: users[0]! } } })).role, 'staff');
  assert.ok(!response.body.includes(next)); assert.ok(!response.body.includes(users[0]!));
});
test('password changes reject wrong current passwords, invalid confirmations and forged identities', async () => {
  const mine = await account(), body = { currentPassword: password, newPassword: 'AnotherPassword123!', confirmPassword: 'AnotherPassword123!', version: mine.version };
  assert.equal((await req('PUT', '/account/password', { ...body, currentPassword: 'wrong' })).statusCode, 401);
  assert.equal((await req('GET', '/account')).statusCode, 200);
  const before = await db.user.findUniqueOrThrow({ where: { id: users[0] } });
  for (const patch of [{ newPassword: 'short', confirmPassword: 'short' }, { confirmPassword: 'DifferentPassword123!' }, { newPassword: password, confirmPassword: password }, { newPassword: ' '.repeat(12), confirmPassword: ' '.repeat(12) }, { newPassword: 'x'.repeat(129), confirmPassword: 'x'.repeat(129) }, { userId: users[1] }, { platformRole: 'admin' }, { role: 'owner' }]) {
    time += 600_001; assert.equal((await req('PUT', '/account/password', { ...body, ...patch })).statusCode, 400);
  }
  assert.equal((await req('PUT', '/account/password', body, -1)).statusCode, 401);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: users[0] } })).password_hash, before.password_hash);
  const crossSite = await app.inject({ method: 'PUT', url: '/api/account/password', headers: { cookie: cookies[0], origin: 'https://untrusted.example' }, payload: body }); assert.equal(crossSite.statusCode, 403);
});
test('password changes reject stale versions and serialize competing password decisions', async () => {
  const mine = await account(); assert.equal((await req('PUT', '/account/profile', { displayName: '较新昵称', version: mine.version })).statusCode, 200);
  const payload = { currentPassword: password, newPassword: 'WinnerPassword123!', confirmPassword: 'WinnerPassword123!', version: mine.version };
  assert.equal((await req('PUT', '/account/password', payload)).statusCode, 409);
  const latest = await account(), candidates = ['WinnerPassword123!','AnotherWinner123!'];
  const responses = await Promise.all(candidates.map((next) => req('PUT', '/account/password', { ...payload, newPassword: next, confirmPassword: next, version: latest.version })));
  assert.equal(responses.filter((result) => result.statusCode === 200).length, 1);
  assert.ok(responses.every((result) => [200,401,409].includes(result.statusCode)));
  const winner = responses.findIndex((result) => result.statusCode === 200);
  assert.equal(await verifyPassword(candidates[winner]!, (await db.user.findUniqueOrThrow({ where: { id: users[0] } })).password_hash), true);
});
test('password and account-name attempts share a per-user limit across sessions', async () => {
  for (let i = 0; i < 2; i++) assert.equal((await rename(0, `${names[0]}_try`, undefined, 'wrong')).statusCode, 401);
  for (let i = 0; i < 3; i++) assert.equal((await req('PUT', '/account/password', { currentPassword: 'wrong', newPassword: 'NewPassword123!', confirmPassword: 'NewPassword123!', version: (await account()).version })).statusCode, 401);
  await login(0);
  const result = await req('PUT', '/account/password', { currentPassword: password, newPassword: 'NewPassword123!', confirmPassword: 'NewPassword123!', version: (await account()).version });
  assert.equal(result.statusCode, 429); assert.ok(Number(result.headers['retry-after']) > 0);
});
test('account positions describe only active store jobs and keep platform authority separate', async () => {
  assert.deepEqual((await account()).shopPositions, [{ shopId: shop, shopName: '账号测试店', role: 'staff' }]);
  assert.deepEqual((await account(1)).shopPositions, []);
  await db.user.update({ where: { id: users[0] }, data: { platform_role: 'admin' } }); await login(0);
  const both = await account(); assert.equal(both.user.platformRole, 'admin'); assert.equal(both.shopPositions[0]!.role, 'staff');
  assert.equal((await req('POST', '/seller/categories', { name: '禁止', description: null, sortOrder: 0, isActive: true })).statusCode, 403);
  await db.shopMember.update({ where: { shop_id_user_id: { shop_id: shop, user_id: users[0]! } }, data: { status: 'disabled' } });
  assert.deepEqual((await account()).shopPositions, []);
  await db.shop.update({ where: { id: shop }, data: { status: 'disabled' } });
  assert.deepEqual((await account(2)).shopPositions, []);
});
test('password changes waiting on a user lock cannot bypass a concurrent credential revocation', async () => {
  const mine = await account(); let pending: ReturnType<typeof req> | undefined;
  const replacement = await hashPassword('ExternalPassword123!');
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${users[0]}::uuid FOR UPDATE`;
    pending = req('PUT', '/account/password', { currentPassword: password, newPassword: 'ShouldNotApply123!', confirmPassword: 'ShouldNotApply123!', version: mine.version });
    let waiting = false;
    for (let i = 0; i < 150; i++) {
      const [row] = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM users WHERE id = %'`;
      if (Number(row!.count)) { waiting = true; break; } await setTimeout(20);
    }
    assert.ok(waiting); await tx.user.update({ where: { id: users[0] }, data: { password_hash: replacement } });
  }, { timeout: 10000 });
  assert.equal((await pending!).statusCode, 401);
  assert.ok((await db.user.findUniqueOrThrow({ where: { id: users[0] } })).password_hash === replacement);
});

test('login, session, account and membership DTOs never expose internal user identities', async () => {
  const responses = [await login(0), await req('GET', '/auth/me'), await req('GET', '/account'), await req('GET', '/seller/members', undefined, 2)];
  for (const response of responses) {
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    for (const id of users) assert.ok(!response.body.includes(id));
    for (const key of ['password_hash','auth_version','userId','user_id','credentialVersion']) assert.ok(!response.body.includes(`"${key}"`));
  }
  assert.deepEqual(Object.keys(responses[0]!.json<SessionDto>().user!).sort(), ['canManageShops','canShop','displayName','platformRole','username']);
});
test('nicknames may repeat and change without changing credentials, ownership or login', async () => {
  const before = await db.user.findUniqueOrThrow({ where: { id: users[0] } }), mine = await account();
  const response = await req('PUT', '/account/profile', { displayName: '  同名用户  ', version: mine.version }); assert.equal(response.statusCode, 200, response.body);
  const changed = await req('PUT', '/account/profile', { displayName: '共享昵称', version: mine.version }); assert.equal(changed.statusCode, 200, changed.body);
  const other = await account(1); assert.equal((await req('PUT', '/account/profile', { displayName: '共享昵称', version: other.version }, 1)).statusCode, 200);
  const after = await db.user.findUniqueOrThrow({ where: { id: users[0] } }); assert.equal(after.auth_version, before.auth_version); assert.equal(after.password_hash, before.password_hash); assert.equal(after.id, before.id);
  assert.equal((await req('GET', '/seller/overview')).statusCode, 200);
  const nicknameLogin = await req('POST', '/auth/login', { username: '共享昵称', password }, -1); assert.equal(nicknameLogin.statusCode, 401);
  const uuidLogin = await req('POST', '/auth/login', { username: users[0], password }, -1); assert.equal(uuidLogin.statusCode, 401);
});
test('renaming requires the current password, retires the old account and revokes every old session', async () => {
  const oldCookie = cookies[0]!, second = await login(0); const currentCookie = cookies[0]!;
  const before = await db.user.findUniqueOrThrow({ where: { id: users[0] } }), current = await account(); const next = `${names[0]}_new`;
  assert.equal((await rename(0, next, current.version, 'wrong')).statusCode, 401);
  assert.equal((await req('GET', '/account', undefined, 0, oldCookie)).statusCode, 200);
  const response = await rename(0, `  ${next.toUpperCase()}  `, current.version); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { username: next, reauthenticate: true }); assert.match(String(response.headers['set-cookie']), /Max-Age=0/);
  for (const cookie of [oldCookie,currentCookie]) assert.equal((await req('GET', '/account', undefined, 0, cookie)).statusCode, 401);
  assert.equal((await req('POST', '/auth/login', { username: names[0], password }, -1)).statusCode, 401);
  await login(0, next);
  const after = await db.user.findUniqueOrThrow({ where: { id: users[0] } }); assert.equal(after.auth_version, before.auth_version + 1); assert.equal(after.password_hash, before.password_hash); assert.equal(after.id, before.id);
  assert.ok((await db.accountName.findUniqueOrThrow({ where: { username: names[0] } })).retired_at);
  assert.equal((await db.accountName.findUniqueOrThrow({ where: { username: next } })).retired_at, null);
  assert.equal((await req('GET', `/account/username-availability?username=${names[0]}`, undefined, 1)).json().available, false);
  assert.equal((await rename(0, names[0]!)).statusCode, 409);
  assert.equal((await rename(1, names[0]!)).statusCode, 409);
  assert.equal(second.statusCode, 200);
});
test('current and historical names are reserved by the database, including direct writes', async () => {
  assert.equal((await rename(0, names[1]!)).statusCode, 409);
  const next = `${names[0]}_next`; assert.equal((await rename(0, next)).statusCode, 200);
  await assert.rejects(db.user.update({ where: { id: users[1] }, data: { username: names[0] } }));
  await assert.rejects(db.user.create({ data: { username: names[0]!, display_name: '冒用旧账号' } }));
  await assert.rejects(db.user.update({ where: { id: users[1] }, data: { id: randomUUID() } }), /identity is immutable/);
  await assert.rejects(db.user.update({ where: { id: users[1] }, data: { username: names[1]!.toUpperCase() } }));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: users[1] } })).username, names[1]);
  assert.equal((await db.accountName.findUniqueOrThrow({ where: { username: names[1] } })).retired_at, null);
});
test('concurrent claims and stale profile writes cannot overwrite another account decision', async () => {
  const shared = `${names[0]}_shared`, versions = [(await account()).version, (await account(1)).version];
  const result = await Promise.all([rename(0, shared, versions[0]), rename(1, shared, versions[1])]);
  assert.deepEqual(result.map((r) => r.statusCode).sort(), [200,409]);
  const unchanged = result[0]!.statusCode === 409 ? 0 : 1, mine = await account(unchanged);
  const edits = await Promise.all(['昵称甲','昵称乙'].map((displayName) => req('PUT', '/account/profile', { displayName, version: mine.version }, unchanged)));
  assert.deepEqual(edits.map((r) => r.statusCode).sort(), [200,409]);
});
test('renaming a work account preserves historical purchases without allowing buyer operations', async () => {
  const cart = await db.cartItem.create({ data: { user_id: users[0]!, sku_id: sku, quantity: 2 } });
  const order = await db.order.create({ data: { buyer_id: users[0]!, shop_id: shop, shop_name: '账号测试店', order_no: randomUUID(), checkout_key: randomUUID(), checkout_payload_hash: 'a'.repeat(64), total_amount: '1.23', recipient_name: '测试买家', recipient_phone: '13800000000', recipient_address: '测试地址' } });
  const next = `${names[0]}_changed`; assert.equal((await rename(0, next)).statusCode, 200); await login(0, next);
  assert.equal((await req('GET', `/orders/${order.id}`)).statusCode, 403);
  assert.equal((await req('GET', '/cart')).statusCode, 403);
  assert.equal((await req('GET', '/seller/overview')).statusCode, 200);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).buyer_id, users[0]);
  assert.equal((await db.cartItem.findUniqueOrThrow({ where: { id: cart.id } })).quantity, 2);
});
test('staff invitations resolve the current exact account and reject retired accounts or duplicate nicknames', async () => {
  await db.user.update({ where: { id: users[1] }, data: { account_kind: 'work' } });
  const next = `${names[1]}_renamed`; assert.equal((await rename(1, next)).statusCode, 200);
  for (const username of [names[1], '同名用户']) assert.equal((await req('POST', '/seller/members', { username, role: 'staff' }, 2)).statusCode, 404);
  const response = await req('POST', '/seller/members', { username: next, role: 'staff' }, 2); assert.equal(response.statusCode, 201, response.body);
  assert.ok(!response.body.includes(users[1]!)); const row = await db.shopMember.findUniqueOrThrow({ where: { id: response.json().id } }); assert.equal(row.user_id, users[1]);
  await login(1, next); assert.equal((await req('GET', '/seller/overview', undefined, 1)).statusCode, 200);
});
test('profile mutations reject forged identities, platform roles and invalid account formats', async () => {
  for (const extra of [{ id: users[1] }, { userId: users[1] }, { platformRole: 'admin' }, { role: 'owner' }, { status: 'active' }]) {
    assert.equal((await req('PUT', '/account/profile', { displayName: '攻击者', version: (await account()).version, ...extra })).statusCode, 400);
  }
  for (const username of ['ab','名字','a-b','a b','x'.repeat(51)]) {
    time += 600_001; assert.equal((await rename(0, username)).statusCode, 400);
  }
  for (const [method, path, body] of [['GET','/account/username-availability?username=abc',undefined], ['PUT','/account/profile',{ displayName: '昵称', version: new Date().toISOString() }], ['PUT','/account/username',{ username: 'abc', currentPassword: password, version: new Date().toISOString() }]] as const) {
    assert.equal((await req(method, path, body, -1)).statusCode, 401);
  }
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: users[0] } })).platform_role, 'user');
});
test('rename attempts are limited across sessions; unchanged accounts do not invalidate login', async () => {
  assert.equal((await rename(0, names[0]!)).json().reauthenticate, false); assert.equal((await req('GET', '/account')).statusCode, 200);
  for (let i = 0; i < 4; i++) assert.equal((await rename(0, `${names[0]}_try`, undefined, 'wrong')).statusCode, 401);
  await login(0); const response = await rename(0, `${names[0]}_try`); assert.equal(response.statusCode, 429); assert.ok(Number(response.headers['retry-after']) > 0);
});
test('account mutation waiting on a row lock rechecks sensitive account revocation', async () => {
  const mine = await account(); let pending: ReturnType<typeof req> | undefined;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${users[0]}::uuid FOR UPDATE`;
    pending = req('PUT', '/account/profile', { displayName: '不应生效', version: mine.version });
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const [row] = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM users WHERE id = %'`;
      if (Number(row!.count)) { waiting = true; break; } await setTimeout(20);
    }
    assert.ok(waiting); await tx.user.update({ where: { id: users[0] }, data: { status: 'disabled' } });
  }, { timeout: 10000 });
  assert.equal((await pending!).statusCode, 401); assert.equal((await db.user.findUniqueOrThrow({ where: { id: users[0] } })).display_name, '同名用户');
});

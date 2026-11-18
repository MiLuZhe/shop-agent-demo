import { DEFAULT_SHOP_ID } from '@shop/contracts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword, verifyPassword } from '@shop/database/password';
import type { SessionDto } from '@shop/contracts';
import { buildApp } from './app.ts';
import { requirePlatformAdmin } from './auth/index.ts';

const db = createDatabase();
let time = Date.now();
const app = buildApp(db, false, { now: () => time, ttlMs: 60_000, loginLimit: 100 });
app.get('/test/admin-only', { preHandler: requirePlatformAdmin }, async (request) => ({ id: request.identity!.userId }));
const suffix = randomUUID().slice(0, 8);
const password = 'AuthTest123!';
const accounts = {
  buyer: { id: randomUUID(), username: `auth_buyer_${suffix}`, display_name: '测试买家甲' },
  other: { id: randomUUID(), username: `auth_other_${suffix}`, display_name: '测试买家乙' },
  seller: { id: randomUUID(), username: `auth_seller_${suffix}`, display_name: '测试卖家' },
  disabled: { id: randomUUID(), username: `auth_disabled_${suffix}`, display_name: '停用账号' },
  noPassword: { id: randomUUID(), username: `auth_nopass_${suffix}`, display_name: '未配置密码账号' },
};
before(async () => {
  const password_hash = await hashPassword(password);
  await db.user.createMany({ data: Object.entries(accounts).map(([key, value]) => ({ ...value,
    password_hash: key === 'noPassword' ? null : password_hash, status: key === 'disabled' ? 'disabled' : 'active',
  })) });
  await db.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: accounts.seller.id } });
  await app.ready();
});
after(async () => {
  try { await db.shopMember.deleteMany({ where: { user_id: { in: Object.values(accounts).map((a) => a.id) } } }); await db.user.deleteMany({ where: { id: { in: Object.values(accounts).map((a) => a.id) } } }); }
  finally { await app.close(); }
});
async function login(username = accounts.buyer.username, cookie?: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, headers: cookie ? { cookie } : {} });
  assert.equal(response.statusCode, 200, response.body);
  return { response, cookie: String(response.headers['set-cookie']).split(';')[0]! };
}

test('salted password hashes verify without storing plaintext', async () => {
  const one = await hashPassword(password);
  const two = await hashPassword(password);
  assert.notEqual(one, two);
  assert.ok(!one.includes(password));
  assert.equal(await verifyPassword(password, one), true);
  assert.equal(await verifyPassword('wrong', one), false);
  assert.equal(await verifyPassword(password, 'broken-hash'), false);
});
test('guest can browse but cannot access protected account or seller resources', async () => {
  assert.equal((await app.inject('/api/products')).statusCode, 200);
  assert.deepEqual((await app.inject('/api/auth/me')).json(), { user: null, expiresAt: null });
  for (const url of ['/api/account', '/api/seller/overview', '/test/admin-only']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'AUTH_REQUIRED');
  }
});
test('login normalizes usernames, rotates cookies and exposes only public identity', async () => {
  const first = await login(`  ${accounts.buyer.username.toUpperCase()}  `);
  assert.match(String(first.response.headers['set-cookie']), /HttpOnly/);
  assert.match(String(first.response.headers['set-cookie']), /SameSite=Lax/);
  assert.match(String(first.response.headers['set-cookie']), /Max-Age=60/);
  assert.equal(first.response.headers['cache-control'], 'no-store');
  assert.equal(first.response.json<SessionDto>().user?.username, accounts.buyer.username);
  assert.ok(!first.response.body.includes('password'));
  assert.ok(!first.response.body.includes('shop_session'));
  const second = await login(accounts.buyer.username, first.cookie);
  assert.notEqual(second.cookie, first.cookie);
  assert.equal((await app.inject({ url: '/api/account', headers: { cookie: first.cookie } })).statusCode, 401);
  const restored = await app.inject({ url: '/api/auth/me', headers: { cookie: second.cookie } });
  assert.equal(restored.json<SessionDto>().user?.username, accounts.buyer.username);
});
test('wrong password, unknown, disabled and passwordless users share the same error', async () => {
  const responses = [];
  for (const [username, inputPassword] of [
    [accounts.buyer.username, 'wrong'], [`missing_${suffix}`, password], [accounts.disabled.username, password], [accounts.noPassword.username, password],
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: inputPassword } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['set-cookie'], undefined);
    responses.push(response.json().error.message);
  }
  assert.equal(new Set(responses).size, 1);
});
test('forged user IDs, roles, cookies and headers do not authorize another account', async () => {
  const { cookie } = await login();
  const mine = await app.inject({ url: `/api/account?userId=${accounts.other.id}`, headers: { cookie, 'x-user-id': accounts.other.id, 'x-role': 'seller' } });
  assert.equal(mine.json().user.username, accounts.buyer.username);
  assert.equal((await app.inject({ url: '/api/seller/overview', headers: { cookie, 'x-role': 'seller' } })).statusCode, 403);
  for (const forged of ['shop_session=abc', `shop_session=${'0'.repeat(64)}`, `${cookie}; ${cookie}`]) {
    assert.equal((await app.inject({ url: '/api/account', headers: { cookie: forged } })).statusCode, 401);
  }
  assert.equal((await app.inject({ url: '/api/account', headers: { 'x-user-id': accounts.seller.id } })).statusCode, 401);
  const injectedRole = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: accounts.buyer.username, password, platformRole: 'admin' } });
  assert.equal(injectedRole.statusCode, 400);
});
test('shop authority comes from membership; platform role changes invalidate existing sessions', async () => {
  const buyer = await login(), seller = await login(accounts.seller.username);
  assert.equal((await app.inject({ url: '/api/seller/overview', headers: { cookie: buyer.cookie } })).statusCode, 403);
  const response = await app.inject({ url: '/api/seller/overview', headers: { cookie: seller.cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().productCount, await db.product.count({ where: { shop_id: DEFAULT_SHOP_ID } }));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ url: '/test/admin-only', headers: { cookie: seller.cookie } })).statusCode, 403);
  try {
    await db.user.update({ where: { id: accounts.seller.id }, data: { platform_role: 'admin' } });
    assert.equal((await app.inject({ url: '/test/admin-only', headers: { cookie: seller.cookie } })).statusCode, 401);
    const elevated = await login(accounts.seller.username);
    assert.equal((await app.inject({ url: '/test/admin-only', headers: { cookie: elevated.cookie } })).statusCode, 200);
    await db.user.update({ where: { id: accounts.seller.id }, data: { platform_role: 'user' } });
    assert.equal((await app.inject({ url: '/test/admin-only', headers: { cookie: elevated.cookie } })).statusCode, 401);
  } finally { await db.user.update({ where: { id: accounts.seller.id }, data: { platform_role: 'user' } }); }
});
test('disabled account invalidates an existing session, including after reactivation', async () => {
  const { cookie } = await login(accounts.other.username);
  try {
    await db.user.update({ where: { id: accounts.other.id }, data: { status: 'disabled' } });
    assert.equal((await app.inject({ url: '/api/account', headers: { cookie } })).statusCode, 401);
  } finally { await db.user.update({ where: { id: accounts.other.id }, data: { status: 'active' } }); }
  assert.equal((await app.inject({ url: '/api/account', headers: { cookie } })).statusCode, 401);
});
test('password change invalidates old sessions without adding a table', async () => {
  const { cookie } = await login(accounts.other.username);
  try {
    await db.user.update({ where: { id: accounts.other.id }, data: { password_hash: await hashPassword('Changed123!') } });
    assert.equal((await app.inject({ url: '/api/account', headers: { cookie } })).statusCode, 401);
  } finally { await db.user.update({ where: { id: accounts.other.id }, data: { password_hash: await hashPassword(password) } }); }
});
test('logout revokes the server session and is idempotent', async () => {
  const { cookie } = await login();
  const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await app.inject({ url: '/api/account', headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode, 200);
});
test('expired sessions are rejected and the browser cookie is cleared', async () => {
  const { cookie } = await login();
  time += 60_001;
  const response = await app.inject({ url: '/api/account', headers: { cookie } });
  assert.equal(response.statusCode, 401);
  assert.match(String(response.headers['set-cookie']), /Max-Age=0/);
});
test('untrusted origins and cross-site mutations are rejected before login/logout', async () => {
  const { cookie } = await login();
  for (const headers of [{ origin: 'https://untrusted.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie } })).statusCode, 403);
  }
  assert.equal((await app.inject({ url: '/api/account', headers: { cookie } })).statusCode, 200);
  const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://127.0.0.1:5173', cookie } });
  assert.equal(response.statusCode, 200);
});
test('login input is bounded and rate limit cannot be bypassed with X-Forwarded-For', async () => {
  for (const payload of [{ username: accounts.buyer.username }, { username: '', password }, { username: accounts.buyer.username, password: 'x'.repeat(129) }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload })).statusCode, 400);
  }
  const limited = buildApp(createDatabase(), false, { loginLimit: 1 });
  try {
    const payload = { username: accounts.buyer.username, password: 'wrong' };
    assert.equal((await limited.inject({ method: 'POST', url: '/api/auth/login', payload })).statusCode, 401);
    const blocked = await limited.inject({ method: 'POST', url: '/api/auth/login', payload, headers: { 'x-forwarded-for': '9.9.9.9' } });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
  } finally { await limited.close(); }
});
test('production cookies set Secure and new server instances do not retain sessions', async () => {
  const { cookie } = await login();
  const secureApp = buildApp(createDatabase(), false, { secureCookie: true });
  try {
    assert.equal((await secureApp.inject({ url: '/api/account', headers: { cookie } })).statusCode, 401);
    const response = await secureApp.inject({ method: 'POST', url: '/api/auth/login', payload: { username: accounts.buyer.username, password } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['set-cookie']), /; Secure/);
  } finally { await secureApp.close(); }
});

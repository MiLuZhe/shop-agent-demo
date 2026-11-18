import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import type { ChatChannelDto, ChatMessageDto, ChatMessagesDto, ChatRoundDto } from '@shop/contracts';
import { buildApp } from './app.ts';
import type { AgentOptions } from './chat/agent-runtime.ts';

async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, now?: () => number, options: AgentOptions = {}) {
  const f = await setup(now, options);
  try { await work(f); } finally { await f.cleanup(); }
}
async function setup(now?: () => number, options: AgentOptions = {}) {
  const db = createDatabase(), app = buildApp(db, false, { loginLimit: 200, now }, options), prefix = `chat_${randomUUID().slice(0, 8)}`;
  // Buyers, owner, manager, two staff, foreign staff, platform admin.
  const users: string[] = Array.from({ length: 8 }, () => randomUUID()), shops: string[] = [randomUUID(), randomUUID()], members: string[] = [];
  const password = 'ChatTests123!', password_hash = await hashPassword(password), cookies: string[] = [];
  await db.user.createMany({ data: users.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: `同名客户`, password_hash, platform_role: i === 7 ? 'admin' : 'user' })) });
  await db.shop.createMany({ data: shops.map((id, i) => ({ id, slug: `${prefix}_${i}`, name: `测试店铺${i}`, chat_capacity: 1 })) });
  for (const [user, shop, role] of [[2, 0, 'owner'], [3, 0, 'manager'], [4, 0, 'staff'], [5, 0, 'staff'], [6, 1, 'staff']] as const) {
    const row = await db.shopMember.create({ data: { user_id: users[user]!, shop_id: shops[shop]!, role } }); members[user] = row.id;
  }
  for (let i = 0; i < users.length; i++) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${prefix}_${i}`, password } }); assert.equal(response.statusCode, 200, response.body);
    cookies[i] = String(response.headers['set-cookie']).split(';')[0]!;
  }
  const req = async (method: 'GET' | 'POST', path: string, body?: unknown, user = 0, shop = 0) => app.inject({ method, url: `/api${path}`, headers: { cookie: cookies[user] ?? '', 'x-shop-id': shops[shop]! }, ...(body === undefined ? {} : { payload: JSON.stringify(body), headers: { cookie: cookies[user] ?? '', 'x-shop-id': shops[shop]!, 'content-type': 'application/json' } }) });
  const send = (content: string, key = randomUUID(), user = 0, shop = 0) => req('POST', `/chat/shops/${shops[shop]}/messages`, { content, clientMessageId: key }, user, shop);
  const channel = async (user = 0, shop = 0) => {
    const response = await req('GET', `/chat/shops/${shops[shop]}`, undefined, user, shop); assert.equal(response.statusCode, 200, response.body);
    return response.json<{ channel: ChatChannelDto | null }>().channel;
  };
  const round = async () => (await channel())!.activeRound!;
  const assign = async (user = 4) => {
    const r = await round();
    const online = await req('POST', '/seller/chat/availability', { available: true }, user); assert.equal(online.statusCode, 200, online.body);
    await req('POST', '/seller/chat/availability', { available: false }, user);
    return req('GET', `/seller/chat/rounds/${r.id}`, undefined, user).then((response) => ({ statusCode: response.statusCode, body: response.body, json: () => response.json().round }));
  };
  return { db, app, users, shops, members, cookies, req, send, channel, round, assign, cleanup: async () => {
    // Stop the periodic dispatcher before removing its fixture rows.
    await app.close();
    const rounds = await db.conversation.findMany({ where: { shop_id: { in: shops } }, select: { id: true } }); const ids = rounds.map((r) => r.id);
    await db.inquiry.deleteMany({ where: { conversation_id: { in: ids } } }); await db.message.deleteMany({ where: { conversation_id: { in: ids } } });
    await db.conversation.deleteMany({ where: { id: { in: ids } } }); await db.chatChannel.deleteMany({ where: { shop_id: { in: shops } } });
    await db.sku.deleteMany({ where: { product: { shop_id: { in: shops } } } }); await db.product.deleteMany({ where: { shop_id: { in: shops } } });
    await db.shopMember.deleteMany({ where: { shop_id: { in: shops } } }); await db.shop.deleteMany({ where: { id: { in: shops } } });
    await db.user.deleteMany({ where: { id: { in: users } } }); await app.close(); await db.$disconnect();
  } };
}

test('chat opening is read-only; authenticated buyer/shop ownership, admin isolation and strict payloads', async () => fixture(async (f) => {
  const { req, channel, send, db, shops, users, app, cookies } = f;
  assert.equal((await req('GET', '/chat/channels', undefined, -1)).statusCode, 401);
  assert.equal(await channel(), null); assert.equal(await db.chatChannel.count({ where: { shop_id: { in: shops } } }), 0);
  for (const payload of [{ content: ' ' }, { content: 'x'.repeat(4001) }, { content: '含\0字符' }, { clientMessageId: 'wrong' }, { senderType: 'system' }, { buyerId: users[1] }]) assert.equal((await req('POST', `/chat/shops/${shops[0]}/messages`, { clientMessageId: randomUUID(), content: '你好', ...payload })).statusCode, 400);
  assert.equal((await send('你好')).statusCode, 201); const c = (await channel())!;
  const privatePath = `/chat/channels/${c.id}`;
  const roundPath = `/seller/chat/rounds/${c.activeRound!.id}`;
  assert.equal((await req('GET', roundPath, undefined, 4)).statusCode, 404);
  assert.equal((await req('GET', roundPath, undefined, 3)).statusCode, 200);
  assert.equal((await req('GET', roundPath, undefined, 6, 1)).statusCode, 404);
  assert.equal((await req('GET', roundPath, undefined, 7)).statusCode, 403);
  for (const suffix of ['', '/messages', '/rounds']) {
    assert.equal((await req('GET', privatePath + suffix, undefined, 1)).statusCode, 404);
    assert.equal((await req('GET', privatePath + suffix, undefined, 7)).statusCode, 403);
    assert.equal((await req('GET', `/seller${privatePath}${suffix}`, undefined, 6, 1)).statusCode, 404);
    const result = await req('GET', `/seller${privatePath}${suffix}`, undefined, 3); assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.headers['cache-control'], 'no-store'); for (const user of users) assert.ok(!result.body.includes(user));
  }
  assert.equal((await req('GET', '/seller/chat/rounds', undefined, 7)).statusCode, 403);
  assert.equal((await req('GET', '/seller/chat/agents', undefined, 4)).json().items.length, 4);
  assert.equal((await req('GET', '/seller/chat/agents', undefined, 6, 1)).json().items.length, 1);
  const own = await req('GET', privatePath); assert.equal(own.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ method: 'POST', url: `/api/chat/shops/${shops[0]}/messages`, headers: { cookie: cookies[0], origin: 'https://evil.example' }, payload: { content: '跨站', clientMessageId: randomUUID() } })).statusCode, 403);
  await send('另一个客户', randomUUID(), 1); await send('另一家店', randomUUID(), 0, 1);
  assert.equal((await req('GET', '/chat/channels')).json().total, 2); assert.equal((await req('GET', '/chat/channels', undefined, 1)).json().total, 1);
  assert.equal((await req('GET', '/seller/chat/rounds', undefined, 4)).json().total, 0);
  assert.equal((await req('GET', '/seller/chat/rounds', undefined, 3)).json().total, 2);
}));

test('automatic assignment uses online idle members, preserves FIFO and immediately reuses released capacity', async () => fixture(async ({ req, send, channel, round, db, members }) => {
  await send('先来的买家'); await send('后来的买家', randomUUID(), 1);
  assert.equal((await round()).status, 'waiting_seller');
  const online = await req('POST', '/seller/chat/availability', { available: true }, 4);
  assert.equal(online.statusCode, 200, online.body); assert.equal(online.json().activeCount, 1);
  let first = await round(), second = (await channel(1))!.activeRound!;
  assert.equal(first.assignedSeller!.username.endsWith('_4'), true);
  assert.equal(second.status, 'waiting_seller');
  const key = randomUUID(); await send('接待中追加消息', key); await send('接待中追加消息', key);
  assert.equal(await db.message.count({ where: { conversation_id: first.id, sender_type: 'system' } }), 1);
  assert.equal((await req('POST', `/seller/chat/rounds/${first.id}/close`, { version: first.version, resolution: '已处理' }, 4)).statusCode, 200);
  second = (await channel(1))!.activeRound!;
  assert.equal(second.assignedSeller!.username.endsWith('_4'), true);
  assert.equal((await req('GET', '/seller/chat/availability', undefined, 4)).json().activeCount, 1);
  await req('POST', '/seller/chat/availability', { available: false }, 4);
  assert.equal((await req('POST', '/seller/chat/heartbeat', {}, 4)).json().available, false, 'heartbeat cannot bring paused agents online');
  await send('再次排队'); first = await round(); assert.equal(first.status, 'waiting_seller');
  assert.equal((await req('POST', `/seller/chat/rounds/${first.id}/transfer`, { version: first.version, memberId: members[4] }, 3)).json().error.code, 'CHAT_RECIPIENT_BUSY');
  // Going offline never takes an existing conversation away from its assignee.
  assert.equal((await channel(1))!.activeRound!.assignedSeller!.username.endsWith('_4'), true);
}));

test('simultaneous arrivals and availability changes assign distinct idle agents once', async () => fixture(async ({ req, send, db, shops, round, channel }) => {
  await Promise.all([4, 5].map((actor) => req('POST', '/seller/chat/availability', { available: true }, actor)));
  const result = await Promise.all([send('同时咨询一'), send('同时咨询二', randomUUID(), 1), req('POST', '/seller/chat/heartbeat', {}, 4), req('POST', '/seller/chat/heartbeat', {}, 5)]);
  assert.ok(result.every((r) => [200, 201].includes(r.statusCode)), result.map((r) => r.body).join('\n'));
  const rounds = await db.conversation.findMany({ where: { shop_id: shops[0] } });
  assert.equal(rounds.length, 2); assert.equal(new Set(rounds.map((r) => r.assigned_seller_id)).size, 2); assert.ok(rounds.every((r) => r.status === 'seller'));
  assert.equal(await db.message.count({ where: { channel: { shop_id: shops[0] }, sender_type: 'system' } }), 2);
  assert.equal(await db.inquiry.count({ where: { conversation_id: { in: rounds.map((r) => r.id) }, status: 'processing' } }), 2);
  assert.ok((await round()).assignedSeller); assert.ok((await channel(1))!.activeRound!.assignedSeller);
}));

test('presence requires shop authority; stale, logged out and revoked agents never get new consultations', async () => {
  let time = Date.now();
  await fixture(async ({ req, send, round, db, members, app, cookies, users }) => {
    for (const actor of [-1, 0, 1, 6, 7]) assert.equal((await req('POST', '/seller/chat/availability', { available: true }, actor)).statusCode, actor < 0 ? 401 : 403);
    for (const body of [{ available: 'true' }, { available: true, userId: users[5] }, {}]) assert.equal((await req('POST', '/seller/chat/availability', body, 4)).statusCode, 400);
    assert.equal((await req('POST', '/seller/chat/heartbeat', { available: true }, 4)).statusCode, 400);
    assert.equal((await req('POST', '/seller/chat/availability', { available: true }, 6, 1)).statusCode, 200);
    await req('POST', '/seller/chat/availability', { available: true }, 4);
    time += 45_001;
    assert.equal((await req('POST', '/seller/chat/heartbeat', {}, 4)).json().available, false);
    await send('掉线以后仍然排队'); assert.equal((await round()).status, 'waiting_seller');
    // A fresh lease with a revoked member is not eligible, even with a valid login.
    await req('POST', '/seller/chat/availability', { available: true }, 5);
    const r = await round();
    await req('POST', `/seller/chat/rounds/${r.id}/close`, { version: r.version, resolution: '已处理' }, 5);
    await db.shopMember.update({ where: { id: members[5] }, data: { status: 'disabled' } });
    await send('成员停用后排队'); assert.equal((await round()).status, 'waiting_seller');
    await req('POST', '/seller/chat/availability', { available: true }, 2);
    const owned = await round(); await req('POST', `/seller/chat/rounds/${owned.id}/close`, { version: owned.version, resolution: '已处理' }, 2);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: cookies[2] } });
    await send('退出登录后排队'); assert.equal((await round()).status, 'waiting_seller');
    await req('POST', '/seller/chat/availability', { available: true }, 3);
    const managed = await round(); await req('POST', `/seller/chat/rounds/${managed.id}/close`, { version: managed.version, resolution: '已处理' }, 3);
    await db.user.update({ where: { id: users[3] }, data: { username: `renamed_${randomUUID().replaceAll('-', '')}` } });
    await send('凭据撤销后排队'); assert.equal((await round()).status, 'waiting_seller');
    assert.equal((await req('POST', '/seller/chat/availability', { available: true }, 4)).statusCode, 200);
    assert.equal((await round()).assignedSeller!.username.endsWith('_4'), true);
  }, () => time);
});

test('product consultations validate buyer, shop and SKU, snapshot server data and keep retries stable', async () => fixture(async ({ db, req, shops, users, channel, round, assign }) => {
  const ids = [randomUUID(), randomUUID(), randomUUID()], sku = randomUUID(), inactive = randomUUID(), foreignSku = randomUUID();
  for (const [i, shop, status] of [[0, 0, 'active'], [1, 1, 'active'], [2, 0, 'draft']] as const) await db.product.create({ data: { id: ids[i], shop_id: shops[shop]!, name: `商品快照${i}`, image_urls: ['/demo-media/test.jpg'], status, skus: { create: { id: i === 0 ? sku : i === 1 ? foreignSku : randomUUID(), sku_code: randomUUID(), name: '绿色规格', price: '9.99', stock_quantity: 0 } } } });
  await db.sku.create({ data: { id: inactive, product_id: ids[0]!, sku_code: randomUUID(), name: '停用规格', price: '1.00', is_active: false } });
  const body = { clientMessageId: randomUUID(), content: '请介绍这件商品', productId: ids[0], skuId: sku };
  const sendProduct = (input: object, actor = 0) => req('POST', `/chat/shops/${shops[0]}/messages`, input, actor);
  for (const actor of [-1, 2, 3, 4, 5, 6, 7]) assert.equal((await sendProduct(body, actor)).statusCode, actor < 0 ? 401 : 403);
  for (const extra of [{ product: { name: '伪造商品' } }, { productName: '伪造名称' }, { shopId: shops[1] }]) assert.equal((await sendProduct({ ...body, ...extra })).statusCode, 400);
  for (const patch of [{ productId: ids[1] }, { productId: ids[2] }, { productId: randomUUID() }, { skuId: inactive }, { skuId: foreignSku }]) assert.equal((await sendProduct({ ...body, ...patch })).statusCode, 404);
  assert.equal((await sendProduct({ content: '孤立规格', clientMessageId: randomUUID(), skuId: sku })).statusCode, 400);
  assert.equal(await db.chatChannel.count({ where: { buyer_id: users[0] } }), 0, 'failed validation must not leave empty channels');
  const first = await sendProduct(body); assert.equal(first.statusCode, 201, first.body);
  const message = first.json<ChatMessageDto>(); assert.deepEqual(message.product, { id: ids[0], name: '商品快照0', imageUrl: '/demo-media/test.jpg', skuId: sku, skuName: '绿色规格' });
  assert.equal((await sendProduct(body)).json().id, message.id);
  assert.equal((await sendProduct({ ...body, skuId: undefined })).statusCode, 409);
  assert.equal((await sendProduct({ content: body.content, clientMessageId: body.clientMessageId })).statusCode, 409);
  assert.equal((await assign()).statusCode, 200);
  const c = (await channel())!, r = await round();
  const sellerHistory = await req('GET', `/seller/chat/channels/${c.id}/messages`, undefined, 3);
  assert.deepEqual(sellerHistory.json<ChatMessagesDto>().items.find((m) => m.id === message.id)!.product, message.product);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { ...body, version: r.version }, 4)).statusCode, 400, 'seller cannot inject buyer product metadata');
  await db.product.update({ where: { id: ids[0] }, data: { name: '商品已改名', status: 'inactive' } });
  await db.sku.update({ where: { id: sku }, data: { is_active: false } });
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/close`, { version: r.version, resolution: '解答完成' }, 4)).statusCode, 200);
  const retry = await sendProduct(body); assert.equal(retry.statusCode, 200); assert.deepEqual(retry.json<ChatMessageDto>().product, message.product); assert.equal((await channel())!.activeRound, null);
  assert.equal((await sendProduct({ ...body, clientMessageId: randomUUID() })).statusCode, 404);
  const plain = await sendProduct({ content: '继续咨询其他问题', clientMessageId: randomUUID() }); assert.equal(plain.statusCode, 201); assert.equal(plain.json<ChatMessageDto>().product, null);
}));

test('concurrent first sends share one channel/round; retry keys, cursor paging and per-round filters are stable', async () => fixture(async (f) => {
  const { send, db, shops, channel, req } = f, sameKey = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => send('相同消息', sameKey)));
  assert.equal(results.filter(r => r.statusCode === 201).length, 1); assert.equal(results.filter(r => r.statusCode === 200).length, 4);
  const first = results[0]!.json<ChatMessageDto>(); assert.ok(results.every(r => r.json().id === first.id));
  assert.equal((await send('替换内容', sameKey)).statusCode, 409);
  const different = await Promise.all(Array.from({ length: 5 }, (_, i) => send(`消息${i}`)));
  assert.ok(different.every(r => r.statusCode === 201), different.map(r => r.body).join('\n'));
  assert.equal(await db.chatChannel.count({ where: { shop_id: shops[0] } }), 1); assert.equal(await db.conversation.count({ where: { shop_id: shops[0] } }), 1);
  const c = (await channel())!, path = `/chat/channels/${c.id}/messages`;
  const latest = (await req('GET', `${path}?limit=2`)).json<ChatMessagesDto>(); assert.deepEqual(latest.items.map(r => r.sequence), [5, 6]); assert.equal(latest.hasMore, true); assert.equal(latest.nextCursor, 5);
  const older = (await req('GET', `${path}?before=${latest.nextCursor}&limit=2`)).json<ChatMessagesDto>(); assert.deepEqual(older.items.map(r => r.sequence), [3, 4]);
  const newer = (await req('GET', `${path}?after=0&limit=3`)).json<ChatMessagesDto>(); assert.deepEqual(newer.items.map(r => r.sequence), [1, 2, 3]); assert.equal(newer.nextCursor, 3);
  assert.deepEqual((await req('GET', `${path}?after=3`)).json<ChatMessagesDto>().items.map(r => r.sequence), [4, 5, 6]);
  assert.equal((await req('GET', `${path}?before=3&after=1`)).statusCode, 400);
  assert.equal((await req('GET', `${path}?after=2147483648`)).statusCode, 400);
  assert.equal((await req('GET', `${path}?roundId=${randomUUID()}`)).statusCode, 404);
  assert.equal((await req('GET', `${path}?roundId=${c.activeRound!.id}`)).json().items.length, 6);
}));

test('owner manager and staff share assignment rules; management never grants unassigned reply or close', async () => fixture(async ({ send, req, round, assign, members }) => {
  for (const actor of [2, 3, 4]) {
    assert.equal((await send('按角色测试接待')).statusCode, 201);
    assert.equal((await assign(actor)).statusCode, 200);
    let r = await round();
    for (const other of [2, 3, 4, 5].filter((i) => i !== actor)) {
      assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { version: r.version, content: '越权回复', clientMessageId: randomUUID() }, other)).statusCode, 403);
      assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/close`, { version: r.version, resolution: '越权关闭' }, other)).statusCode, 403);
    }
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[5] }, 5)).statusCode, 403);
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { version: r.version, content: '本人正常回复', clientMessageId: randomUUID() }, actor)).statusCode, 201);
    await req('POST', '/seller/chat/availability', { available: true }, 5);
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[5] }, actor)).statusCode, 200);
    r = await round();
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { version: r.version, content: '转出后不能回复', clientMessageId: randomUUID() }, actor)).statusCode, 403);
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/close`, { version: r.version, resolution: '已处理' }, 5)).statusCode, 200);
    await req('POST', '/seller/chat/availability', { available: false }, 5);
  }
  await send('管理转接'); await assign();
  for (const actor of [2, 3]) {
    const r = await round();
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[actor], allowOffline: true }, actor)).statusCode, 200);
  }
}));

test('one assignee wins; transfer, takeover and close keep history and round versions consistent', async () => fixture(async (f) => {
  const { send, req, round, channel, members, users, db, shops } = f;
  const buyerKey = randomUUID(); const first = await send('咨询一个问题', buyerKey); const original = await round();
  const online = await Promise.all([4, 5].map(user => req('POST', '/seller/chat/availability', { available: true }, user)));
  assert.ok(online.every((r) => r.statusCode === 200));
  const assigned = await round();
  const winner = assigned.assignedSeller!.username.endsWith('_4') ? 4 : 5, other = winner === 4 ? 5 : 4;
  for (const actor of [4, 5]) await req('POST', '/seller/chat/availability', { available: false }, actor);
  let r = await round(); const replyKey = randomUUID(); const replyBody = { content: '客服回复', clientMessageId: replyKey, version: r.version };
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, replyBody, other)).statusCode, 403);
  const answer = await req('POST', `/seller/chat/rounds/${r.id}/messages`, replyBody, winner); assert.equal(answer.statusCode, 201, answer.body);
  assert.equal((await round()).version, r.version, 'incoming messages must not invalidate the assignee control version');
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[6] }, winner)).statusCode, 404);
  await req('POST', '/seller/chat/availability', { available: true }, other);
  const transfer = await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[other] }, winner); assert.equal(transfer.statusCode, 200, transfer.body);
  const newRound = await round(); assert.notEqual(newRound.version, r.version); assert.equal(newRound.id, r.id);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, replyBody, winner)).statusCode, 200, 'an acknowledged original reply can be retried after transfer');
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { ...replyBody, clientMessageId: randomUUID() }, winner)).statusCode, 409);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { ...replyBody, version: newRound.version, clientMessageId: randomUUID() }, winner)).statusCode, 403);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: newRound.version, memberId: members[winner] }, winner)).statusCode, 403);
  const takeover = await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: newRound.version, memberId: members[3], allowOffline: true }, 3); assert.equal(takeover.statusCode, 200, takeover.body);
  r = await round(); assert.equal(r.assignedSeller!.username.endsWith('_3'), true);
  await req('POST', '/seller/chat/availability', { available: false }, other);
  const close = await req('POST', `/seller/chat/rounds/${r.id}/close`, { version: r.version, resolution: '已解答' }, 3); assert.equal(close.statusCode, 200, close.body);
  assert.equal(close.json<ChatRoundDto>().status, 'closed'); assert.ok(close.json<ChatRoundDto>().endedAt);
  assert.equal((await channel())!.activeRound, null);
  const retry = await send('咨询一个问题', buyerKey); assert.equal(retry.statusCode, 200); assert.equal(retry.json().id, first.json().id); assert.equal((await channel())!.activeRound, null);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { content: '旧轮次不能补发', clientMessageId: randomUUID(), version: r.version }, 3)).statusCode, 409);
  const next = await send('再次咨询'); assert.equal(next.statusCode, 201); assert.notEqual(next.json().roundId, r.id);
  const c = (await channel())!; assert.equal(c.activeRound!.status, 'waiting_seller');
  assert.equal((await req('GET', `/chat/channels/${c.id}/rounds`)).json().total, 2);
  assert.equal((await req('GET', `/seller/chat/rounds?view=closed`, undefined, 4)).json().total, 0);
  assert.equal((await req('GET', `/seller/chat/rounds?view=closed`, undefined, 3)).json().total, 1);
  const history = await req('GET', `/chat/channels/${c.id}/messages`); for (const user of users) assert.ok(!history.body.includes(user));
  const oldReply = history.json<ChatMessagesDto>().items.find(m => m.id === answer.json().id)!; assert.equal(oldReply.sender!.username.endsWith(`_${winner}`), true);
  const inquiry = await db.inquiry.findFirstOrThrow({ where: { conversation_id: r.id } }); assert.equal(inquiry.status, 'resolved'); assert.equal(inquiry.assigned_seller_id, users[3]);
  const stored = await db.message.findMany({ where: { channel_id: c.id, sender_type: 'system' }, orderBy: { sequence: 'asc' } }); assert.deepEqual(stored.map(m => (m.event_data as { type: string }).type), ['auto_assigned', 'transferred', 'reassigned', 'closed']);
  assert.equal((await db.conversation.findFirstOrThrow({ where: { channel_id: c.id, status: 'waiting_seller' } })).requirement_state && JSON.stringify((await db.conversation.findFirstOrThrow({ where: { channel_id: c.id, status: 'waiting_seller' } })).requirement_state), '{}');
  assert.equal(await db.chatChannel.count({ where: { shop_id: shops[0] } }), 1);
}));

test('disabled assignees lose access immediately and managers can recover their work; self-service is forbidden', async () => fixture(async (f) => {
  const { send, assign, round, req, db, members, channel, shops, users } = f;
  await send('需要协助'); assert.equal((await assign()).statusCode, 200); let r = await round();
  await db.shopMember.update({ where: { id: members[4] }, data: { status: 'disabled' } });
  assert.equal((await req('GET', `/seller/chat/channels/${(await channel())!.id}`, undefined, 4)).statusCode, 403);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { version: r.version, content: '不能回复', clientMessageId: randomUUID() }, 4)).statusCode, 403);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[3], allowOffline: true }, 3)).statusCode, 200);
  r = await round(); assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[4] }, 3)).statusCode, 409);
  assert.equal((await send('我自己购买', randomUUID(), 5)).statusCode, 403);
  // Legacy channels remain protected from self-service after migration.
  const selfChannel = await db.chatChannel.create({ data: { shop_id: shops[0]!, buyer_id: users[5]! } });
  const selfRound = await db.conversation.create({ data: { channel_id: selfChannel.id, shop_id: shops[0]!, buyer_id: users[5]!, status: 'waiting_seller' } });
  await db.message.create({ data: { channel_id: selfChannel.id, conversation_id: selfRound.id, sequence: 1, sender_type: 'buyer', sender_user_id: users[5]!, content: '旧咨询' } });
  assert.equal((await req('POST', `/seller/chat/rounds/${selfRound.id}/claim`, { version: selfRound.updated_at.toISOString() }, 5)).statusCode, 404);
  assert.equal((await req('POST', `/seller/chat/rounds/${selfRound.id}/transfer`, { version: selfRound.updated_at.toISOString(), memberId: members[5] }, 3)).statusCode, 403);
  // Changing a mutable username cannot move or lose the UUID-owned channel.
  await db.user.update({ where: { id: users[0] }, data: { username: `renamed_${randomUUID().replaceAll('-', '')}` } });
  assert.equal(await db.chatChannel.count({ where: { buyer_id: users[0], shop_id: shops[0] } }), 1);
  assert.equal((await req('GET', '/chat/channels')).statusCode, 401, 'username changes revoke the old session');
}));

test('a reply waiting at the shop lock rechecks revoked membership and live credentials', async () => fixture(async (f) => {
  const { send, assign, round, req, db, shops, members, users } = f;
  await send('并发撤权'); assert.equal((await assign()).statusCode, 200); const r = await round();
  for (const accountChange of [false, true]) {
    let pending: ReturnType<typeof req> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${shops[0]}::uuid FOR UPDATE`;
      pending = req('POST', `/seller/chat/rounds/${r.id}/messages`, { version: r.version, content: '不应写入', clientMessageId: randomUUID() }, 4);
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM shops WHERE id=%'`;
        if (Number(rows[0]!.count)) { waiting = true; break; } await setTimeout(20);
      }
      assert.ok(waiting, 'reply must have passed its guard and reached the transaction lock');
      if (accountChange) await tx.user.update({ where: { id: users[4] }, data: { status: 'disabled' } });
      else await tx.shopMember.update({ where: { id: members[4] }, data: { status: 'disabled' } });
    }, { timeout: 10000 });
    const response = await pending!; assert.equal(response.statusCode, accountChange ? 401 : 403, response.body);
    assert.equal(await db.message.count({ where: { conversation_id: r.id, sender_type: 'seller' } }), 0);
    if (!accountChange) await db.shopMember.update({ where: { id: members[4] }, data: { status: 'active' } });
  }
}));

test('database rejects channel reassignment, competing rounds, forged buyer and moving or editing messages', async () => fixture(async (f) => {
  const { send, db, channel, users, shops } = f;
  const sent = (await send('历史不可改写')).json<ChatMessageDto>(), c = (await channel())!, r = c.activeRound!;
  await assert.rejects(db.chatChannel.update({ where: { id: c.id }, data: { buyer_id: users[1] } }), /immutable/);
  await assert.rejects(db.conversation.create({ data: { channel_id: c.id, shop_id: shops[0]!, buyer_id: users[0]!, status: 'waiting_seller' } }), /Unique constraint/);
  await assert.rejects(db.conversation.create({ data: { channel_id: c.id, shop_id: shops[0]!, buyer_id: users[1]!, status: 'closed', ended_at: new Date() } }), /Foreign key constraint/);
  await assert.rejects(db.message.create({ data: { channel_id: c.id, conversation_id: r.id, sequence: 2, sender_type: 'buyer', sender_user_id: users[1]!, content: '冒充买家' } }), /must own/);
  await assert.rejects(db.message.update({ where: { id: sent.id }, data: { content: '修改历史' } }), /immutable/);
  await assert.rejects(db.conversation.update({ where: { id: r.id }, data: { status: 'closed' } }), /conversations_ended_check/);
  await send('其他通道', randomUUID(), 1); const other = (await channel(1))!;
  await assert.rejects(db.message.create({ data: { channel_id: other.id, conversation_id: r.id, sequence: 2, sender_type: 'buyer', sender_user_id: users[0]!, content: '跨通道挂载' } }), /Foreign key constraint/);
}));

test('reply/close and buyer-send/close races never append a late reply to a new round or create two active rounds', async () => fixture(async (f) => {
  const { send, assign, round, req, db, channel } = f;
  await send('结束竞争测试'); assert.equal((await assign()).statusCode, 200); const r = await round();
  const replyKey = randomUUID();
  const [answer, closed] = await Promise.all([
    req('POST', `/seller/chat/rounds/${r.id}/messages`, { version: r.version, content: '与结束同时发送', clientMessageId: replyKey }, 4),
    req('POST', `/seller/chat/rounds/${r.id}/close`, { version: r.version, resolution: '本次已结束' }, 4),
  ]);
  assert.equal(closed.statusCode, 200, closed.body); assert.ok([201, 409].includes(answer.statusCode), answer.body);
  assert.equal(await db.message.count({ where: { conversation_id: r.id, sender_type: 'seller' } }), answer.statusCode === 201 ? 1 : 0);
  const nextMessage = await send('下一次咨询'); assert.equal(nextMessage.statusCode, 201);
  const nextRound = await round(); assert.notEqual(nextRound.id, r.id);
  if (answer.statusCode === 201) assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { version: r.version, content: '与结束同时发送', clientMessageId: replyKey }, 4)).json().id, answer.json().id);
  assert.equal(await db.message.count({ where: { conversation_id: nextRound.id, sender_type: 'seller' } }), 0);
  assert.equal((await assign()).statusCode, 200); const current = await round();
  const key = randomUUID();
  const [buyer, end] = await Promise.all([
    send('结束边界上的新消息', key),
    req('POST', `/seller/chat/rounds/${current.id}/close`, { version: current.version, resolution: '边界测试结束' }, 4),
  ]);
  assert.equal(buyer.statusCode, 201, buyer.body); assert.equal(end.statusCode, 200, end.body);
  const active = (await channel())!.activeRound;
  if (buyer.json<ChatMessageDto>().roundId === current.id) assert.equal(active, null);
  else assert.equal(active!.id, buyer.json<ChatMessageDto>().roundId);
  const repeated = await send('结束边界上的新消息', key); assert.equal(repeated.statusCode, 200); assert.equal(repeated.json().id, buyer.json().id);
  const c = (await channel())!; assert.ok(await db.conversation.count({ where: { channel_id: c.id, status: { not: 'closed' } } }) <= 1);
}));

async function extraBuyer(f: Awaited<ReturnType<typeof setup>>) {
  const user = await f.db.user.create({ data: { username: `capacity_${randomUUID().replaceAll('-', '')}`, display_name: '容量测试买家', password_hash: (await f.db.user.findUniqueOrThrow({ where: { id: f.users[0] } })).password_hash } });
  const index = f.users.push(user.id) - 1;
  const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user.username, password: 'ChatTests123!' } });
  assert.equal(login.statusCode, 200); f.cookies[index] = String(login.headers['set-cookie']).split(';')[0]!;
  return index;
}

test('capacity settings default to three, validate limits, isolate shops and allow only the owner with a fresh version', async () => fixture(async (f) => {
  const { db, shops, users, req } = f;
  const fresh = await db.shop.create({ data: { slug: `capacity_${randomUUID()}`, name: '默认容量' } }); shops.push(fresh.id);
  await db.shopMember.create({ data: { shop_id: fresh.id, user_id: users[2]!, role: 'owner' } });
  assert.equal(fresh.chat_capacity, 3);
  const settings = (await req('GET', '/seller/chat/settings', undefined, 2)).json();
  for (const actor of [3, 4, 5]) {
    assert.equal((await req('GET', '/seller/chat/settings', undefined, actor)).json().canEdit, false);
    assert.equal((await req('POST', '/seller/chat/settings', { capacity: 3, version: settings.version }, actor)).statusCode, 403);
  }
  for (const actor of [-1, 0, 1, 6, 7]) assert.equal((await req('POST', '/seller/chat/settings', { capacity: 3, version: settings.version }, actor)).statusCode, actor < 0 ? 401 : 403);
  for (const capacity of [0, 11, 1.5, '3', null]) assert.equal((await req('POST', '/seller/chat/settings', { capacity, version: settings.version }, 2)).statusCode, 400);
  assert.equal((await req('POST', '/seller/chat/settings', { capacity: 2, version: settings.version, shopId: shops[1] }, 2)).statusCode, 400);
  const changed = await req('POST', '/seller/chat/settings', { capacity: 4, version: settings.version }, 2); assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await req('POST', '/seller/chat/settings', { capacity: 2, version: settings.version }, 2)).statusCode, 409);
  assert.equal((await db.shop.findUniqueOrThrow({ where: { id: shops[1] } })).chat_capacity, 1);
  assert.equal((await db.shop.findUniqueOrThrow({ where: { id: fresh.id } })).chat_capacity, 3);
  await assert.rejects(db.shop.update({ where: { id: fresh.id }, data: { chat_capacity: 0 } }), /shops_chat_capacity_check/);
}));

test('concurrent dispatch fills capacity without oversubscription, lower capacity preserves work, and FIFO resumes on release', async () => fixture(async (f) => {
  const { db, req, shops, users, send } = f;
  await db.shop.update({ where: { id: shops[0] }, data: { chat_capacity: 3 } });
  const buyers = [0, 1]; for (let i = 0; i < 6; i++) buyers.push(await extraBuyer(f));
  await Promise.all([4, 5].map(actor => req('POST', '/seller/chat/availability', { available: true }, actor)));
  const results = await Promise.all(buyers.map((actor, i) => send(`并发买家${i}`, randomUUID(), actor)));
  assert.ok(results.every(result => result.statusCode === 201));
  const active = () => db.conversation.findMany({ where: { shop_id: shops[0], status: 'seller' } });
  const rounds = await active(); assert.equal(rounds.length, 6);
  for (const actor of [4, 5]) assert.equal(rounds.filter(round => round.assigned_seller_id === users[actor]).length, 3);
  const pending = await db.inquiry.findMany({ where: { conversation: { shop_id: shops[0] }, status: 'pending' }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] }); assert.equal(pending.length, 2);
  let settings = (await req('GET', '/seller/chat/settings', undefined, 2)).json();
  assert.equal((await req('POST', '/seller/chat/settings', { version: settings.version, capacity: 2 }, 2)).statusCode, 200);
  assert.equal((await active()).length, 6, 'lowering the cap never unassigns existing work');
  const owned = rounds.filter(round => round.assigned_seller_id === users[4]);
  for (let i = 0; i < 2; i++) {
    const round = owned[i]!; assert.equal((await req('POST', `/seller/chat/rounds/${round.id}/close`, { version: round.updated_at.toISOString(), resolution: '释放容量' }, 4)).statusCode, 200);
    if (i === 0) assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: pending[0]!.conversation_id } })).status, 'waiting_seller');
  }
  assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: pending[0]!.conversation_id } })).assigned_seller_id, users[4]);
  assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: pending[1]!.conversation_id } })).status, 'waiting_seller');
  settings = (await req('GET', '/seller/chat/settings', undefined, 2)).json();
  await req('POST', '/seller/chat/settings', { version: settings.version, capacity: 3 }, 2);
  assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: pending[1]!.conversation_id } })).assigned_seller_id, users[4], 'lower load receives the next queued customer');
  assert.equal((await req('GET', '/seller/chat/availability', undefined, 4)).json().activeCount, 3);
}));

test('new consultations prefer the online agent with the lowest current load', async () => fixture(async (f) => {
  await f.db.shop.update({ where: { id: f.shops[0] }, data: { chat_capacity: 3 } });
  await f.req('POST', '/seller/chat/availability', { available: true }, 4);
  await f.send('第一位'); await f.send('第二位', randomUUID(), 1);
  await f.req('POST', '/seller/chat/availability', { available: true }, 5);
  const buyer = await extraBuyer(f); await f.send('优先空闲人员', randomUUID(), buyer);
  assert.equal((await f.channel(buyer))!.activeRound!.assignedSeller!.username.endsWith('_5'), true);
}));

test('ordinary transfers require online capacity; explicit offline assignment is restricted to management', async () => fixture(async (f) => {
  const { req, send, assign, round, members, db, shops } = f;
  await send('转接验证'); await assign(); let r = await round();
  const path = `/seller/chat/rounds/${r.id}/transfer`, body = { version: r.version, memberId: members[5] };
  assert.equal((await req('POST', path, body, 4)).json().error.code, 'CHAT_RECIPIENT_OFFLINE');
  assert.equal((await req('POST', path, { ...body, allowOffline: true }, 4)).statusCode, 403);
  assert.equal((await req('POST', path, body, 3)).json().error.code, 'CHAT_RECIPIENT_OFFLINE');
  assert.equal((await round()).version, r.version, 'a failed transfer leaves the original assignee and version intact');
  assert.equal((await req('POST', path, { ...body, allowOffline: true }, 3)).statusCode, 200);
  r = await round(); assert.equal(r.assignedSeller!.username.endsWith('_5'), true);
  await db.shop.update({ where: { id: shops[0] }, data: { chat_capacity: 2 } });
  await req('POST', '/seller/chat/availability', { available: true }, 4);
  const second = await extraBuyer(f); await send('另一轮', randomUUID(), second);
  await req('POST', '/seller/chat/availability', { available: true }, 5);
  assert.equal((await req('POST', path, { version: r.version, memberId: members[4] }, 5)).statusCode, 200, 'one active round does not mean full capacity');
  assert.equal((await req('GET', '/seller/chat/availability', undefined, 4)).json().activeCount, 2);
}));

test('personal unread cursors are persistent, monotonic, authorized and never advanced by list polling', async () => fixture(async (f) => {
  const { req, send, assign, channel, db, users, members } = f;
  await send('第一条未读'); await assign(); const c = (await channel())!, r = c.activeRound!;
  const read = `/seller/chat/channels/${c.id}/read`, feed = '/seller/chat/notifications';
  let alerts = (await req('GET', feed, undefined, 4)).json();
  assert.equal(alerts.conversationCount, 1); assert.equal(alerts.unreadCount, 1); assert.equal(alerts.items[0].assignmentUnread, true);
  await req('GET', '/seller/chat/rounds?view=mine', undefined, 4); await req('GET', `/seller/chat/channels/${c.id}/messages`, undefined, 4);
  assert.equal(await db.chatReadState.count({ where: { channel_id: c.id } }), 0);
  const latest = alerts.items[0].latestSequence;
  assert.equal((await req('POST', read, { sequence: latest }, 5)).statusCode, 404);
  assert.equal((await req('POST', read, { sequence: latest }, 3)).statusCode, 200);
  assert.equal((await req('GET', feed, undefined, 4)).json().unreadCount, 1, 'another reader cannot acknowledge my notifications');
  for (const actor of [-1, 0, 1, 7]) assert.equal((await req('POST', read, { sequence: latest }, actor)).statusCode, actor < 0 ? 401 : 403);
  assert.equal((await req('POST', read, { sequence: latest }, 6, 1)).statusCode, 404);
  for (const payload of [{ sequence: latest + 100 }, { sequence: -1 }, { sequence: .5 }, { sequence: latest, userId: users[5] }]) assert.equal((await req('POST', read, payload, 4)).statusCode, 400);
  const acknowledgements = await Promise.all([latest, 1, 0].map(sequence => req('POST', read, { sequence }, 4))); assert.ok(acknowledgements.every(result => result.statusCode === 200));
  assert.equal((await db.chatReadState.findUniqueOrThrow({ where: { channel_id_user_id: { channel_id: c.id, user_id: users[4]! } } })).read_sequence, latest);
  assert.equal((await req('GET', feed, undefined, 4)).json().conversationCount, 0);
  const key = randomUUID(); await send('追加未读', key); await send('追加未读', key);
  alerts = (await req('GET', feed, undefined, 4)).json(); assert.equal(alerts.unreadCount, 1); assert.equal(alerts.items[0].assignmentUnread, false);
  for (const user of users) assert.ok(!JSON.stringify(alerts).includes(user), 'no internal user identifiers in notifications');
  assert.equal((await req('POST', read, { sequence: alerts.items[0].latestSequence }, 5)).statusCode, 404);
  await req('POST', '/seller/chat/availability', { available: true }, 5);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[5] }, 4)).statusCode, 200);
  assert.equal((await req('GET', feed, undefined, 4)).json().conversationCount, 0);
  alerts = (await req('GET', feed, undefined, 5)).json(); assert.equal(alerts.items[0].unreadCount, 2); assert.equal(alerts.items[0].assignmentUnread, true, 'new assignee has an independent unread cursor');
  await db.shopMember.update({ where: { id: members[5] }, data: { status: 'disabled' } });
  assert.equal((await req('POST', read, { sequence: alerts.items[0].latestSequence }, 5)).statusCode, 403);
  assert.equal((await req('GET', feed, undefined, 5)).statusCode, 403);
}));

test('competing transfers share the capacity lock and cannot overfill the last slot', async () => fixture(async (f) => {
  const { req, send, assign, channel, users, members, db, shops } = f;
  await send('原负责人甲'); await assign(4); await send('原负责人乙', randomUUID(), 1);
  await req('POST', '/seller/chat/availability', { available: true }, 5); await req('POST', '/seller/chat/availability', { available: false }, 5);
  const rounds = [(await channel())!.activeRound!, (await channel(1))!.activeRound!];
  await req('POST', '/seller/chat/availability', { available: true }, 3);
  const results = await Promise.all(rounds.map((round, index) => req('POST', `/seller/chat/rounds/${round.id}/transfer`, { version: round.version, memberId: members[3] }, 4 + index)));
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
  assert.equal(await db.conversation.count({ where: { shop_id: shops[0], status: 'seller', assigned_seller_id: users[3] } }), 1);
  const loser = results.findIndex(result => result.statusCode === 409);
  assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: rounds[loser]!.id } })).assigned_seller_id, users[4 + loser]);
}));

test('a transfer waiting for the channel lock rechecks a recipient who pauses reception', async () => fixture(async (f) => {
  const { req, send, assign, channel, round, members, db } = f;
  await send('转接期间下线'); await assign(); const c = (await channel())!, r = await round();
  await req('POST', '/seller/chat/availability', { available: true }, 5);
  let transfer: ReturnType<typeof req> | undefined, pause: ReturnType<typeof req> | undefined;
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${c.id}::uuid FOR UPDATE`;
    transfer = req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[5] }, 4);
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM chat_channels WHERE id=%'`;
      if (Number(rows[0]!.count)) { waiting = true; break; } await setTimeout(20);
    }
    assert.ok(waiting);
    pause = req('POST', '/seller/chat/availability', { available: false }, 5);
    for (let i = 0; i < 100; i++) {
      if (!(await req('GET', '/seller/chat/availability', undefined, 5)).json().available) return;
      await setTimeout(20);
    }
    assert.fail('recipient must become unavailable before transfer commits');
  }, { timeout: 10000 });
  assert.equal((await transfer!).json().error.code, 'CHAT_RECIPIENT_OFFLINE'); assert.equal((await pause!).statusCode, 200);
  assert.equal((await round()).version, r.version);
}));

test('waiting for buyer remains capacity-bound, guards new messages, clears on reply and enforces assignee rights', async () => fixture(async ({ req, send, round, channel, assign, db }) => {
  await send('咨询中'); await assign();
  let r = await round(), c = (await channel())!;
  const path = `/seller/chat/rounds/${r.id}/waiting`;
  const body = { version: r.version, lastSequence: c.latestSequence, waiting: true };
  for (const actor of [2, 3, 5]) assert.equal((await req('POST', path, body, actor)).statusCode, 403);
  assert.equal((await req('POST', path, { ...body, waiting: 'yes' }, 4)).statusCode, 400);
  await send('刚到达的问题');
  assert.equal((await req('POST', path, body, 4)).json().error.code, 'CHAT_NEW_MESSAGES');
  c = (await channel())!;
  assert.equal((await req('POST', path, { ...body, lastSequence: c.latestSequence }, 4)).statusCode, 200);
  r = await round(); assert.ok(r.waitingBuyerSince);
  assert.equal((await req('GET', '/seller/chat/availability', undefined, 4)).json().activeCount, 1);
  await send('另一个买家', randomUUID(), 1); assert.equal((await channel(1))!.activeRound!.status, 'waiting_seller');
  await send('买家继续追问'); r = await round(); assert.equal(r.waitingBuyerSince, null);
  assert.equal((await req('POST', path, { ...body, version: r.version, lastSequence: (await channel())!.latestSequence }, 4)).statusCode, 200);
  r = await round();
  const key = randomUUID(), message = { version: r.version, content: '人工继续回复', clientMessageId: key };
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, message, 4)).statusCode, 201);
  assert.equal((await round()).waitingBuyerSince, null);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, message, 4)).statusCode, 200, 'retry must not change the waiting state again');
  assert.equal(await db.conversation.count({ where: { id: r.id, status: 'seller' } }), 1);
}));

test('leave requeues after older waiters, pauses reception, validates complete versions and remains human-only', async () => fixture(async ({ req, send, round, channel, db, users }) => {
  await req('POST', '/seller/chat/availability', { available: true }, 4);
  await send('先接待后离岗'); const original = await round();
  await send('已排队买家', randomUUID(), 1);
  const preview = (await req('GET', '/seller/chat/leave', undefined, 4)).json();
  assert.equal(preview.roundVersions.length, 1);
  assert.equal((await req('POST', '/seller/chat/leave', { roundVersions: [] }, 4)).statusCode, 409);
  assert.equal((await req('POST', '/seller/chat/leave', preview, 5)).statusCode, 409);
  for (const actor of [-1, 0, 7]) assert.equal((await req('POST', '/seller/chat/leave', preview, actor)).statusCode, actor < 0 ? 401 : 403);
  const response = await req('POST', '/seller/chat/leave', preview, 4); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().available, false); assert.equal(response.json().activeCount, 0);
  assert.equal((await round()).status, 'waiting_seller');
  assert.equal((await req('POST', '/seller/chat/heartbeat', {}, 4)).json().available, false);
  assert.equal((await req('POST', '/seller/chat/leave', preview, 4)).statusCode, 409);
  await req('POST', '/seller/chat/availability', { available: true }, 5);
  assert.equal((await channel(1))!.activeRound!.assignedSeller!.username.endsWith('_5'), true, 'existing waiter is ahead of the handed-back round');
  assert.equal((await round()).status, 'waiting_seller');
  const inquiry = await db.inquiry.findFirstOrThrow({ where: { conversation_id: original.id } });
  assert.equal(inquiry.status, 'pending'); assert.equal(inquiry.assigned_seller_id, null);
  assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: original.id } })).auto_requeue_count, 0);
  assert.equal(await db.message.count({ where: { conversation_id: original.id, sender_type: 'system', content: { contains: '交接' } } }), 1);
  assert.ok(users[4]);
}));

test('concurrent arrivals and leave either require a fresh confirmation or atomically hand over every owned round', async () => fixture(async ({ db, shops, req, send, channel, users }) => {
  await db.shop.update({ where: { id: shops[0] }, data: { chat_capacity: 2 } });
  await req('POST', '/seller/chat/availability', { available: true }, 4); await send('已有咨询');
  const preview = (await req('GET', '/seller/chat/leave', undefined, 4)).json();
  const [leave, incoming] = await Promise.all([req('POST', '/seller/chat/leave', preview, 4), send('并发咨询', randomUUID(), 1)]);
  assert.equal(incoming.statusCode, 201); assert.ok([200, 409].includes(leave.statusCode), leave.body);
  if (leave.statusCode === 409) {
    const fresh = (await req('GET', '/seller/chat/leave', undefined, 4)).json();
    assert.equal((await req('POST', '/seller/chat/leave', fresh, 4)).statusCode, 200);
  }
  assert.equal(await db.conversation.count({ where: { shop_id: shops[0], status: 'seller', assigned_seller_id: users[4] } }), 0);
  assert.equal((await channel(1))!.activeRound!.status, 'waiting_seller');
}));

test('unexpected offline has a grace window, explicit return preserves ownership, and pause never releases work', async () => {
  let now = Date.now();
  await fixture(async ({ req, send, round, users, db }) => {
    await req('POST', '/seller/chat/availability', { available: true }, 4); await send('网络中断'); const id = (await round()).id;
    now += 45_001; await req('POST', '/seller/chat/heartbeat', {}, 5);
    assert.ok((await round()).offlineSince); assert.equal((await round()).assignedSeller!.username.endsWith('_4'), true);
    now += 119_000; await req('POST', '/seller/chat/heartbeat', {}, 5); assert.equal((await round()).status, 'seller');
    await req('POST', '/seller/chat/availability', { available: true }, 4);
    assert.equal((await round()).offlineSince, null); assert.equal((await db.conversation.findUniqueOrThrow({ where: { id } })).assigned_seller_id, users[4]);
    await req('POST', '/seller/chat/availability', { available: false }, 4);
    now += 500_000; await req('POST', '/seller/chat/heartbeat', {}, 5);
    assert.equal((await round()).status, 'seller'); assert.equal((await round()).offlineSince, null, 'explicit pause retains current assignments');
  }, () => now);
});

test('offline timeout preserves FIFO, is capped at three requeues and allows manual rescue', async () => {
  let now = Date.now();
  await fixture(async ({ req, send, round, channel, db, members }) => {
    await req('POST', '/seller/chat/availability', { available: true }, 4); await send('多次断线');
    const id = (await round()).id;
    for (let cycle = 1; cycle <= 4; cycle++) {
      now += 45_001; await req('POST', '/seller/chat/heartbeat', {}, 5);
      now += 120_000; await req('POST', '/seller/chat/heartbeat', {}, 5);
      const row = await db.conversation.findUniqueOrThrow({ where: { id } });
      assert.equal(row.auto_requeue_count, Math.min(cycle, 3));
      if (cycle <= 3) {
        assert.equal(row.status, 'waiting_seller');
        await req('POST', '/seller/chat/availability', { available: true }, 4);
        assert.equal((await round()).status, 'seller');
      } else {
        assert.equal(row.status, 'seller'); assert.equal((await round()).needsHandoff, true);
      }
    }
    await req('POST', '/seller/chat/availability', { available: true }, 5);
    const current = (await channel())!.activeRound!;
    assert.equal((await req('POST', `/seller/chat/rounds/${id}/transfer`, { version: current.version, memberId: members[5] }, 3)).statusCode, 200);
    assert.equal((await round()).needsHandoff, false);
    assert.equal(await db.message.count({ where: { conversation_id: id, content: { contains: '连接中断' } } }), 3);
  }, () => now);
});

test('buyer end enforces owner and message snapshot, releases capacity, keeps history and rejects duplicate close', async () => fixture(async ({ req, send, round, channel, db }) => {
  await req('POST', '/seller/chat/availability', { available: true }, 4); await send('准备结束');
  let c = (await channel())!, r = c.activeRound!; const path = `/chat/rounds/${r.id}/end`, snapshot = { version: r.version, lastSequence: c.latestSequence };
  assert.equal((await req('POST', path, snapshot, 1)).statusCode, 404);
  assert.equal((await req('POST', path, snapshot, 4)).statusCode, 403);
  assert.equal((await req('POST', path, { ...snapshot, userId: randomUUID() })).statusCode, 400);
  await req('POST', `/seller/chat/rounds/${r.id}/messages`, { content: '刚到的回复', clientMessageId: randomUUID(), version: r.version }, 4);
  assert.equal((await req('POST', path, snapshot)).json().error.code, 'CHAT_NEW_MESSAGES');
  c = (await channel())!; r = c.activeRound!;
  await send('排队下一位', randomUUID(), 1);
  const results = await Promise.all([req('POST', path, { version: r.version, lastSequence: c.latestSequence }), req('POST', path, { version: r.version, lastSequence: c.latestSequence })]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal((await channel())!.activeRound, null);
  assert.equal((await channel(1))!.activeRound!.status, 'seller');
  assert.equal((await db.inquiry.findFirstOrThrow({ where: { conversation_id: r.id } })).status, 'resolved');
  const history = await db.message.count({ where: { channel_id: c.id } });
  await send('重新咨询'); assert.notEqual((await round()).id, r.id); assert.equal((await channel())!.id, c.id);
  assert.ok(await db.message.count({ where: { channel_id: c.id } }) > history);
}));

test('buyer can close a waiting round without an assigned seller or unfinished inquiry', async () => fixture(async ({ req, send, channel, db }) => {
  await send('等待中取消咨询'); const c = (await channel())!, r = c.activeRound!;
  assert.equal((await req('POST', `/chat/rounds/${r.id}/end`, { version: r.version, lastSequence: c.latestSequence })).statusCode, 200);
  assert.equal((await channel())!.activeRound, null);
  assert.equal(await db.inquiry.count({ where: { conversation_id: r.id, status: { in: ['pending', 'processing'] } } }), 0);
}));

test('revoked or logged-out paused staff stop retaining work after the offline grace', async () => {
  let now = Date.now();
  await fixture(async ({ req, send, assign, round, db, members }) => {
    await send('暂停后撤权'); await assign(); const r = await round();
    await db.shopMember.update({ where: { id: members[4] }, data: { status: 'disabled' } });
    await req('POST', '/seller/chat/heartbeat', {}, 5); assert.ok((await round()).offlineSince);
    now += 120_001; await req('POST', '/seller/chat/heartbeat', {}, 5);
    assert.equal((await round()).status, 'waiting_seller');
    assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: r.id } })).auto_requeue_count, 1);
  }, () => now);
});

test('restarting reception grants a fresh grace period without replaying assignments', async () => {
  let now = Date.now(); const f = await setup(() => now); let restarted: ReturnType<typeof buildApp> | undefined;
  try {
    await f.req('POST', '/seller/chat/availability', { available: true }, 4); await f.send('重启保留接待'); const r = await f.round();
    await f.db.conversation.update({ where: { id: r.id }, data: { assigned_offline_at: new Date(now - 500_000) } });
    await f.app.close(); now += 1000;
    restarted = buildApp(createDatabase(), false, { now: () => now }, { recoverOnStart: false, recoverReceptionOnStart: true, recoveryShopIds: f.shops }); await restarted.ready();
    const verify = createDatabase();
    try {
      let row = await verify.conversation.findUniqueOrThrow({ where: { id: r.id } });
      assert.equal(row.status, 'seller'); assert.equal(row.assigned_seller_id, f.users[4]); assert.equal(row.assigned_offline_at!.getTime(), now);
      const actor = await verify.user.findUniqueOrThrow({ where: { id: f.users[5] } });
      const login = await restarted.inject({ method: 'POST', url: '/api/auth/login', payload: { username: actor.username, password: 'ChatTests123!' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      now += 120_001;
      const tick = await restarted.inject({ method: 'POST', url: '/api/seller/chat/heartbeat', headers: { cookie, 'x-shop-id': f.shops[0]! }, payload: {} }); assert.equal(tick.statusCode, 200, tick.body);
      row = await verify.conversation.findUniqueOrThrow({ where: { id: r.id } }); assert.equal(row.status, 'waiting_seller'); assert.equal(row.auto_requeue_count, 1);
    } finally { await verify.$disconnect(); }
  } finally { await restarted?.close(); await f.cleanup(); }
});

test('an offline recovery blocked on a channel lock rechecks an operator returning online', async () => {
  let now = Date.now();
  await fixture(async ({ req, send, round, channel, db }) => {
    await req('POST', '/seller/chat/availability', { available: true }, 4); await send('重连与离线回收竞争');
    const c = (await channel())!, r = await round(); now += 45_001;
    await req('POST', '/seller/chat/heartbeat', {}, 5); now += 120_001;
    let sweep: ReturnType<typeof req> | undefined, returning: ReturnType<typeof req> | undefined;
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${c.id}::uuid FOR UPDATE`;
      sweep = req('POST', '/seller/chat/heartbeat', {}, 5); await setTimeout(50);
      returning = req('POST', '/seller/chat/availability', { available: true }, 4);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await req('GET', '/seller/chat/availability', undefined, 4)).json().available) break;
        await setTimeout(10);
      }
    }, { timeout: 5000 });
    assert.equal((await sweep!).statusCode, 200); assert.equal((await returning!).statusCode, 200);
    assert.equal((await round()).assignedSeller!.username.endsWith('_4'), true);
    const row = await db.conversation.findUniqueOrThrow({ where: { id: r.id } }); assert.equal(row.auto_requeue_count, 0); assert.equal(row.assigned_offline_at, null);
  }, () => now);
});

test('background offline recovery progresses with no live leases and no further HTTP requests', async () => {
  let now = Date.now();
  await fixture(async ({ req, send, round, db }) => {
    await req('POST', '/seller/chat/availability', { available: true }, 4); await send('无人在线时后台回收'); const id = (await round()).id;
    const waitFor = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await setTimeout(100); } assert.fail('background dispatcher did not progress'); };
    now += 45_001;
    await waitFor(async () => !!(await db.conversation.findUniqueOrThrow({ where: { id } })).assigned_offline_at);
    now += 120_001;
    await waitFor(async () => (await db.conversation.findUniqueOrThrow({ where: { id } })).status === 'waiting_seller');
    const row = await db.conversation.findUniqueOrThrow({ where: { id } }); assert.equal(row.auto_requeue_count, 1); assert.equal(row.assigned_seller_id, null);
    assert.equal((await db.inquiry.findFirstOrThrow({ where: { conversation_id: id } })).status, 'pending');
  }, () => now);
});

test('staff reads are limited to current ownership and own closed rounds, including all cursors and metadata', async () => fixture(async ({ req, send, assign, channel, round, members }) => {
  await send('只应由接待人员读取'); const c = (await channel())!, initial = await round();
  for (const actor of [4, 5]) {
    for (const path of [`/seller/chat/rounds/${initial.id}`, `/seller/chat/rounds/${initial.id}/context`, `/seller/chat/channels/${c.id}`, `/seller/chat/channels/${c.id}/messages?after=0`, `/seller/chat/channels/${c.id}/rounds`]) assert.equal((await req('GET', path, undefined, actor)).statusCode, 404);
    assert.equal((await req('GET', '/seller/chat/rounds?view=all', undefined, actor)).json().total, 0);
  }
  await assign(); let r = await round();
  assert.equal((await req('GET', `/seller/chat/rounds/${r.id}/context`, undefined, 4)).statusCode, 200);
  await req('POST', '/seller/chat/availability', { available: true }, 5);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[5] }, 4)).statusCode, 200);
  for (const suffix of ['', '/messages?before=999', '/rounds']) assert.equal((await req('GET', `/seller/chat/channels/${c.id}${suffix}`, undefined, 4)).statusCode, 404);
  assert.equal((await req('POST', `/seller/chat/channels/${c.id}/read`, { sequence: 1 }, 4)).statusCode, 404);
  r = await round(); await req('POST', `/seller/chat/rounds/${r.id}/close`, { version: r.version, resolution: '本人已处理' }, 5);
  const lastAccessible = (await req('GET', `/seller/chat/channels/${c.id}`, undefined, 5)).json();
  assert.equal(lastAccessible.activeRound, null);
  assert.equal((await req('GET', `/seller/chat/channels/${c.id}/messages?roundId=${r.id}`, undefined, 5)).statusCode, 200);
  assert.equal((await req('GET', `/seller/chat/channels/${c.id}/messages`, undefined, 5)).statusCode, 404);
  await req('POST', '/seller/chat/availability', { available: false }, 5); await send('后续不属于原接待人员的消息'); await assign(4);
  const after = (await req('GET', `/seller/chat/channels/${c.id}`, undefined, 5)).json();
  assert.equal(after.activeRound, null); assert.equal(after.latestSequence, lastAccessible.latestSequence); assert.equal(after.lastMessageAt, lastAccessible.lastMessageAt);
  const rounds = (await req('GET', `/seller/chat/channels/${c.id}/rounds`, undefined, 5)).json(); assert.equal(rounds.total, 1); assert.equal(rounds.items[0].id, r.id);
  const current = await round();
  assert.equal((await req('GET', `/seller/chat/channels/${c.id}/messages?roundId=${current.id}`, undefined, 5)).statusCode, 404);
  const context = await req('GET', `/seller/chat/rounds/${r.id}/context`, undefined, 5); assert.ok(!context.body.includes('后续不属于'));
  assert.equal((await req('GET', `/seller/chat/channels/${c.id}/messages`, undefined, 4)).statusCode, 200, 'current assignee can read channel history to continue service');
  assert.equal((await req('GET', '/seller/chat/rounds?view=all', undefined, 3)).json().total, 2);
}));

test('copilot generates private drafts only, binds role and snapshot, supports edited manual send and idempotent retry', async () => {
  let calls = 0;
  await fixture(async ({ req, send, assign, round, channel, db, users }) => {
    await send('请介绍这个商品'); await assign(); const r = await round(), c = (await channel())!;
    const path = `/seller/chat/rounds/${r.id}/suggestions`, input = { version: r.version, lastSequence: c.latestSequence };
    const before = await db.message.count({ where: { conversation_id: r.id } });
    const summary = await req('GET', `/seller/chat/rounds/${r.id}/context`, undefined, 4); assert.equal(summary.statusCode, 200, summary.body); assert.equal(summary.json().canSuggest, true); assert.equal(calls, 0);
    for (const actor of [0, 1, 5, 7]) assert.ok([403, 404].includes((await req('POST', path, input, actor)).statusCode));
    assert.equal((await req('POST', path, input, 3)).statusCode, 403, 'management cannot generate replies without becoming assignee');
    assert.equal((await req('POST', path, { ...input, userId: users[4] }, 4)).statusCode, 400);
    const proposal = await req('POST', path, input, 4); assert.equal(proposal.statusCode, 200, proposal.body); const draft = proposal.json();
    assert.equal(calls, 1); assert.equal(await db.message.count({ where: { conversation_id: r.id } }), before); assert.equal((await round()).version, r.version);
    for (const user of users) assert.ok(!proposal.body.includes(user));
    const message = { version: r.version, content: '人工审核并修改后的回复', suggestionId: draft.id, clientMessageId: randomUUID() };
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, message, 4)).statusCode, 201);
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, message, 4)).statusCode, 200);
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { ...message, clientMessageId: randomUUID() }, 4)).statusCode, 409);
    const row = await db.message.findFirstOrThrow({ where: { conversation_id: r.id, sender_type: 'seller' } }); assert.equal(row.content, message.content); assert.equal(row.sender_user_id, users[4]);
  }, undefined, { copilotModel: async () => { calls++; return { content: '建议初稿' }; } });
});

test('copilot drafts become stale after buyer messages, close or reassignment and never overwrite conversation memory', async () => fixture(async ({ req, send, assign, round, channel, members, db }) => {
  await send('第一问'); await assign(); let r = await round();
  const draft = (await req('POST', `/seller/chat/rounds/${r.id}/suggestions`, { version: r.version, lastSequence: (await channel())!.latestSequence }, 4)).json();
  await send('补充新条件');
  const reply = { version: r.version, content: draft.content, suggestionId: draft.id, clientMessageId: randomUUID() };
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, reply, 4)).json().error.code, 'CHAT_SUGGESTION_STALE');
  await req('POST', '/seller/chat/availability', { available: true }, 5);
  await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[5] }, 4); r = await round();
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/messages`, { ...reply, version: r.version }, 5)).statusCode, 409);
  assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/suggestions`, { version: r.version, lastSequence: (await channel())!.latestSequence }, 4)).statusCode, 404);
  assert.deepEqual((await db.conversation.findUniqueOrThrow({ where: { id: r.id } })).requirement_state, {});
  assert.equal(await db.message.count({ where: { conversation_id: r.id, sender_type: { in: ['seller', 'agent'] } } }), 0);
}, undefined, { copilotModel: async () => ({ content: '旧草稿' }) }));

test('copilot rechecks in-flight source changes and revocation, rejecting late model output', async () => {
  for (const mutation of ['message', 'membership', 'transfer', 'close'] as const) {
    let release!: () => void, started = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await fixture(async ({ req, send, assign, round, channel, db, members }) => {
      await send('生成期间变化'); await assign(); const r = await round();
      const pending = req('POST', `/seller/chat/rounds/${r.id}/suggestions`, { version: r.version, lastSequence: (await channel())!.latestSequence }, 4);
      for (let i = 0; i < 100 && !started; i++) await setTimeout(10); assert.ok(started);
      if (mutation === 'message') await send('刚补充的需求');
      else if (mutation === 'membership') await db.shopMember.update({ where: { id: members[4] }, data: { status: 'disabled' } });
      else if (mutation === 'transfer') { await req('POST', '/seller/chat/availability', { available: true }, 5); await req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: members[5] }, 4); }
      else await req('POST', `/seller/chat/rounds/${r.id}/close`, { version: r.version, resolution: '生成期间关闭' }, 4);
      release(); const result = await pending; assert.ok([403, 404, 409].includes(result.statusCode), result.body);
      assert.equal(await db.message.count({ where: { conversation_id: r.id, sender_type: { in: ['seller', 'agent'] } } }), 0);
    }, undefined, { copilotModel: async () => { started = true; await gate; return { content: '过期结果' }; } });
  }
});

test('copilot tool allowlist is enforced even if adapter swallows errors; timeout and rate remain bounded', async () => {
  await fixture(async ({ req, send, assign, round, channel, db }) => {
    await send('尝试越权'); await assign(); const r = await round();
    const response = await req('POST', `/seller/chat/rounds/${r.id}/suggestions`, { version: r.version, lastSequence: (await channel())!.latestSequence }, 4);
    assert.equal(response.statusCode, 403, response.body); assert.equal((await round()).status, 'seller');
    assert.equal(await db.inquiry.count({ where: { conversation_id: r.id } }), 1);
  }, undefined, { copilotModel: async context => { await context.call('handoffToSeller' as never, {}).catch(() => {}); return { content: '吞掉错误也不能发布' }; } });
  await fixture(async ({ req, send, assign, round, channel }) => {
    await send('超时'); await assign(); const r = await round();
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/suggestions`, { version: r.version, lastSequence: (await channel())!.latestSequence }, 4)).statusCode, 504);
  }, undefined, { copilotTimeoutMs: 30, copilotModel: async () => new Promise(() => {}) });
  await fixture(async ({ req, send, assign, round, channel }) => {
    await send('限频'); await assign(); const r = await round(), body = { version: r.version, lastSequence: (await channel())!.latestSequence };
    for (let i = 0; i < 3; i++) assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/suggestions`, body, 4)).statusCode, 200);
    assert.equal((await req('POST', `/seller/chat/rounds/${r.id}/suggestions`, body, 4)).statusCode, 429);
  }, undefined, { copilotModel: async () => ({ content: '限频草稿' }) });
});

test('copilot concurrency is globally and per-actor bounded, and expired drafts cannot be sent', async t => {
  let release!: () => void, starts = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  await fixture(async f => {
    const { req, send, round, channel, db } = f;
    await req('POST', '/seller/chat/availability', { available: true }, 4); await send('甲的咨询');
    await req('POST', '/seller/chat/availability', { available: false }, 4);
    await req('POST', '/seller/chat/availability', { available: true }, 5); await send('乙的咨询', randomUUID(), 1);
    await req('POST', '/seller/chat/availability', { available: false }, 5);
    const buyer = await extraBuyer(f); await send('丙的咨询', randomUUID(), buyer); await req('POST', '/seller/chat/availability', { available: true }, 3);
    const a = await round(), b = (await channel(1))!.activeRound!, c = (await channel(buyer))!.activeRound!;
    const payload = async (r: ChatRoundDto, user = 0) => ({ version: r.version, lastSequence: (await channel(user))!.latestSequence });
    const input = await payload(a), p = req('POST', `/seller/chat/rounds/${a.id}/suggestions`, input, 4), q = req('POST', `/seller/chat/rounds/${b.id}/suggestions`, await payload(b, 1), 5);
    for (let i = 0; i < 100 && starts < 2; i++) await setTimeout(10); assert.equal(starts, 2);
    assert.equal((await req('POST', `/seller/chat/rounds/${a.id}/suggestions`, input, 4)).statusCode, 429);
    assert.equal((await req('POST', `/seller/chat/rounds/${c.id}/suggestions`, await payload(c, buyer), 3)).statusCode, 429);
    release(); const [first, second] = await Promise.all([p, q]); assert.equal(first.statusCode, 200, first.body); assert.equal(second.statusCode, 200);
    const draft = first.json(), realNow = Date.now;
    t.mock.method(Date, 'now', () => realNow() + 300001);
    try { assert.equal((await req('POST', `/seller/chat/rounds/${a.id}/messages`, { version: a.version, content: draft.content, suggestionId: draft.id, clientMessageId: randomUUID() }, 4)).json().error.code, 'CHAT_SUGGESTION_STALE'); }
    finally { t.mock.restoreAll(); }
    assert.equal(await db.message.count({ where: { channel: { shop_id: f.shops[0] }, sender_type: 'seller' } }), 0);
  }, undefined, { copilotModel: async () => { starts++; await gate; return { content: '有界并发建议' }; } });
});

// app.inject buffers responses; these tests use real HTTP sockets to verify
// framing, disconnects, long-lived auth and cleanup.
async function eventClient(f: Awaited<ReturnType<typeof setup>>, path: string, actor = 0, cookie?: string) {
  const address = f.app.server.address(); assert.ok(address && typeof address === 'object');
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, { headers: { cookie: cookie ?? f.cookies[actor]!, 'x-shop-id': f.shops[0]!, accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, no-transform'); assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const events: { event: string; data: any }[] = []; let done = false;
  const read = (async () => {
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }); let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const lines = buffer.slice(0, index).split('\n'); buffer = buffer.slice(index + 2);
          const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data = lines.find(line => line.startsWith('data:'))?.slice(5).trim();
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { done = true; await reader.cancel().catch(() => {}); }
  })();
  return { events, get done() { return done; }, close: async () => { controller.abort(); await read; } };
}
async function eventUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await setTimeout(20); }
  assert.fail('Expected an authorized SSE update within 4 seconds');
}
const eventGate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('SSE opening is read-only, validates buyer/work/shop scopes, rejects URL credentials and bounds connections', async () => fixture(async f => {
  await f.app.listen({ host: '127.0.0.1', port: 0 }); const path = `/chat/shops/${f.shops[0]}/events`;
  for (const actor of [-1, 2, 4, 7]) assert.equal((await f.req('GET', path, undefined, actor)).statusCode, actor < 0 ? 401 : 403);
  assert.equal((await f.req('GET', path+'?token=not-supported')).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api'+path, headers: { cookie: f.cookies[0], 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
  const clients: Awaited<ReturnType<typeof eventClient>>[] = [];
  try {
    for (let i = 0; i < 4; i++) clients.push(await eventClient(f, path));
    await eventUntil(() => clients.every(c => c.events.length > 0));
    assert.ok(clients.every(c => c.events[0]!.data.channelId === null && c.events[0]!.data.progress === null));
    assert.equal(await f.db.chatChannel.count({ where: { shop_id: f.shops[0] } }), 0);
    assert.equal((await f.req('GET', path)).statusCode, 429);
    await clients.pop()!.close(); await setTimeout(50); clients.push(await eventClient(f, path));
  } finally { await Promise.all(clients.map(c => c.close())); }
}));

test('SSE reports real guide stages, lookup context and checked completion without leaking message or user data', async () => {
  const begin = eventGate(), lookup = eventGate(), finish = eventGate();
  await fixture(async f => {
    await f.app.listen({ host: '127.0.0.1', port: 0 }); const client = await eventClient(f, `/chat/shops/${f.shops[0]}/events`);
    try {
      await f.send('请查询商品'); await eventUntil(() => client.events.some(e => e.data.progress?.phase === 'understanding'));
      begin.resolve(); await eventUntil(() => client.events.some(e => e.data.progress?.phase === 'composing' && e.data.progress.lastAction === 'searching'));
      lookup.resolve(); await eventUntil(() => client.events.some(e => e.data.progress?.phase === 'details'));
      finish.resolve(); await eventUntil(() => client.events.some(e => e.data.round?.agentRun?.status === 'completed' && e.data.progress === null));
      const r = await f.round(), latest = client.events.filter(e => e.event === 'snapshot').at(-1)!.data;
      assert.equal(latest.latestSequence, (await f.channel())!.latestSequence);
      assert.equal(await f.db.message.count({ where: { conversation_id: r.id, sender_type: 'agent', content: '核对后回复' } }), 1);
      const wire = JSON.stringify(client.events); for (const user of f.users) assert.ok(!wire.includes(user));
      assert.ok(!wire.includes('toolName') && !wire.includes('核对后回复') && !wire.includes('sessionKey'));
    } finally { begin.resolve(); lookup.resolve(); finish.resolve(); await client.close(); }
  }, undefined, { mode: 'mock', recoverOnStart: false, model: async c => { await begin.promise; await c.call('searchProducts', {}); await c.reportProgress?.('composing'); await lookup.promise; await c.reportProgress?.('details'); await finish.promise; return { content: '核对后回复' }; } });
});

test('SSE revokes transferred staff and cannot expose later rounds through closed staff metadata', async () => fixture(async f => {
  await f.send('首轮'); await f.assign(); await f.req('POST', '/seller/chat/availability', { available: true }, 5); const r = await f.round();
  await f.app.listen({ host: '127.0.0.1', port: 0 }); const old = await eventClient(f, `/seller/chat/rounds/${r.id}/events`, 4);
  try {
    assert.equal((await f.req('GET', `/seller/chat/rounds/${r.id}/events`, undefined, 5)).statusCode, 404);
    assert.equal((await f.req('GET', `/seller/chat/rounds/${r.id}/events`, undefined, 6, 1)).statusCode, 404);
    assert.equal((await f.req('GET', `/seller/chat/rounds/${r.id}/events`, undefined, 7)).statusCode, 403);
    assert.equal((await f.req('POST', `/seller/chat/rounds/${r.id}/transfer`, { version: r.version, memberId: f.members[5] }, 4)).statusCode, 200);
    await eventUntil(() => old.done); assert.deepEqual(old.events.at(-1), { event: 'unavailable', data: { denied: true, sessionExpired: false } });
    const current = await f.round(); assert.equal((await f.req('POST', `/seller/chat/rounds/${r.id}/close`, { version: current.version, resolution: '完成' }, 5)).statusCode, 200);
    const closed = await eventClient(f, `/seller/chat/rounds/${r.id}/events`, 5);
    try {
      await eventUntil(() => closed.events.length > 0); const sequence = closed.events[0]!.data.latestSequence;
      await f.req('POST', '/seller/chat/availability', { available: false }, 5); await f.req('POST', '/seller/chat/availability', { available: true }, 4); await f.send('后续内容不可泄露'); await setTimeout(1150);
      const snapshots = closed.events.filter(e => e.event === 'snapshot'); assert.ok(snapshots.every(e => e.data.latestSequence === sequence && e.data.round.id === r.id && e.data.round.status === 'closed'));
    } finally { await closed.close(); }
  } finally { await old.close(); }
}));

test('SSE long-lived streams stop after logout, member revocation, session expiry and account changes', async () => {
  for (const mutation of ['logout', 'member', 'expiry', 'disabled', 'password'] as const) {
    let time = Date.now();
    await fixture(async f => {
      await f.send('授权变化'); await f.assign(); const r = await f.round(); await f.app.listen({ host: '127.0.0.1', port: 0 });
      const client = await eventClient(f, `/seller/chat/rounds/${r.id}/events`, 4);
      try {
        await eventUntil(() => client.events.length > 0);
        if (mutation === 'logout') await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: f.cookies[4] } });
        if (mutation === 'member') await f.db.shopMember.update({ where: { id: f.members[4] }, data: { status: 'disabled' } });
        if (mutation === 'disabled') await f.db.user.update({ where: { id: f.users[4] }, data: { status: 'disabled' } });
        if (mutation === 'password') await f.db.user.update({ where: { id: f.users[4] }, data: { password_hash: await hashPassword('ChangedForSseTest123!') } });
        if (mutation === 'expiry') time += 8 * 60 * 60 * 1000 + 1;
        await eventUntil(() => client.done); assert.equal(client.events.at(-1)!.event, 'unavailable'); assert.equal(client.events.at(-1)!.data.denied, true);
      } finally { await client.close(); }
    }, () => time);
  }
});

test('SSE suggestion progress is private to the generating login and vanishes when buyer facts change', async () => {
  const finish = eventGate();
  await fixture(async f => {
    await f.send('请人工核对'); await f.assign(); const r = await f.round(), sequence = (await f.channel())!.latestSequence;
    const user = await f.db.user.findUniqueOrThrow({ where: { id: f.users[4] } });
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user.username, password: 'ChatTests123!' } });
    const secondCookie = String(login.headers['set-cookie']).split(';')[0]!; await f.app.listen({ host: '127.0.0.1', port: 0 });
    const clients: Awaited<ReturnType<typeof eventClient>>[] = [];
    try {
      clients.push(await eventClient(f, `/seller/chat/rounds/${r.id}/events`, 4));
      clients.push(await eventClient(f, `/seller/chat/rounds/${r.id}/events`, 3));
      clients.push(await eventClient(f, `/seller/chat/rounds/${r.id}/events`, 4, secondCookie));
      clients.push(await eventClient(f, `/chat/shops/${f.shops[0]}/events`));
      const requestId = randomUUID(), generation = f.req('POST', `/seller/chat/rounds/${r.id}/suggestions`, { version: r.version, lastSequence: sequence, requestId }, 4);
      await eventUntil(() => clients[0]!.events.some(e => e.data.progress?.requestId === requestId && e.data.progress.lastAction === 'searching'));
      await setTimeout(60); for (const client of clients.slice(1)) assert.ok(client.events.filter(e => e.event === 'snapshot').every(e => e.data.progress === null));
      assert.equal(await f.db.message.count({ where: { conversation_id: r.id, sender_type: 'seller' } }), 0);
      await f.send('新条件'); await eventUntil(() => clients[0]!.events.filter(e => e.event === 'snapshot').at(-1)?.data.progress === null);
      finish.resolve(); assert.equal((await generation).statusCode, 409);
    } finally { finish.resolve(); await Promise.all(clients.map(c => c.close())); }
  }, undefined, { recoverOnStart: false, copilotModel: async c => { await c.call('searchProducts', {}); await finish.promise; return { content: '过期建议不能提交' }; } });
});

test('SSE rejects superseded stages, clears ended guide work and closes idle streams on shutdown', async () => {
  const finish = eventGate(); let old: import('./chat/agent-runtime.ts').AgentContext | undefined;
  await fixture(async f => {
    await f.app.listen({ host: '127.0.0.1', port: 0 }); const client = await eventClient(f, `/chat/shops/${f.shops[0]}/events`);
    try {
      await f.send('旧问题'); await eventUntil(() => !!old); const previous = old!;
      await f.send('新问题'); await assert.rejects(previous.reportProgress!('details'));
      const r = await f.round(), c = (await f.channel())!;
      assert.equal((await f.req('POST', `/chat/rounds/${r.id}/end`, { version: r.version, lastSequence: c.latestSequence })).statusCode, 200);
      finish.resolve(); await eventUntil(() => client.events.filter(e => e.event === 'snapshot').at(-1)?.data.round === null);
      assert.equal(await f.db.message.count({ where: { conversation_id: r.id, sender_type: 'agent' } }), 0);
      await f.app.close(); await eventUntil(() => client.done);
    } finally { finish.resolve(); await client.close(); }
  }, undefined, { mode: 'mock', recoverOnStart: false, model: async c => { old ??= c; await finish.promise; await c.reportProgress?.('composing'); return { content: '旧结果不能入库' }; } });
});

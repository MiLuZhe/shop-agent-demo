import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import { agentCardSchema, chatAvailabilitySchema, chatHeartbeatSchema, chatCloseSchema, chatEndSchema, chatLeaveSchema, chatWaitingSchema, chatInboxSchema, chatListSchema, chatMessagesQuerySchema, chatProductSnapshotSchema, chatReplySchema, chatSendSchema, chatTransferSchema, chatSettingsSchema, chatReadSchema, uuidSchema, type ChatChannelDto, type ChatMessageDto, type ChatProductDto, type ChatRoundDto, type AgentRunStatus } from '@shop/contracts';
import { HttpError, requireLiveIdentity, requireBuyer, requireLiveBuyer } from '../auth/index.ts';
import { requireShop } from '../shops/access.ts';
import { append, messageInclude } from './storage.ts';
import { createDispatch, lockDispatch } from './dispatch.ts';
import type { AuthSessions } from '../auth/index.ts';
import { nextStamp } from '../transactions/locks.ts';
import { createAgentRuntime, type AgentOptions } from './agent-runtime.ts';
import { notifications } from './notifications.ts';
import { requeueRound } from './lifecycle.ts';
import { canReadRound, managesChat, staffRounds } from './access.ts';
import { registerReceptionAssist } from './reception-assist.ts';
import { createChatLive } from './live.ts';

type Tx = Prisma.TransactionClient;
const personSelect = { username: true, display_name: true } as const;
const person = (u: { username: string; display_name: string }) => ({ username: u.username, displayName: u.display_name });
const roundInclude = { assigned_seller: { select: personSelect } } as const;
const channelInclude = { shop: { select: { name: true } }, buyer: { select: personSelect }, conversations: { where: { status: { not: 'closed' } }, include: roundInclude } } as const;
type Round = Prisma.ConversationGetPayload<{ include: typeof roundInclude }>;
type Channel = Prisma.ChatChannelGetPayload<{ include: typeof channelInclude }>;
type Message = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;
const missing = () => new HttpError(404, 'CHAT_NOT_FOUND', '咨询不存在或不可访问');
function roundDto(row: Round, request: FastifyRequest, role?: string, mode: AgentOptions['mode'] = 'disabled'): ChatRoundDto {
  const actor = request.identity!.userId, staff = !!role && row.buyer_id !== actor;
  return { id: row.id, channelId: row.channel_id, status: row.status as ChatRoundDto['status'], version: row.updated_at.toISOString(), createdAt: row.created_at.toISOString(), endedAt: row.ended_at?.toISOString() ?? null,
    assignedSeller: row.assigned_seller ? person(row.assigned_seller) : null,
    waitingBuyerSince: row.waiting_buyer_since?.toISOString() ?? null, offlineSince: row.assigned_offline_at?.toISOString() ?? null, needsHandoff: !!row.assigned_offline_at && row.auto_requeue_count >= 3,
    agentRun: row.status === 'agent' ? { status: row.agent_run_status as AgentRunStatus, mode } : null,
    canReply: staff && row.status === 'seller' && row.assigned_seller_id === actor,
    canReadHistory: staff && (managesChat(role) || (row.status === 'seller' && row.assigned_seller_id === actor)),
    canManage: staff && ['owner','manager'].includes(role!) && row.status !== 'closed' };
}
function channelDto(row: Channel, request: FastifyRequest, role?: string, mode: AgentOptions['mode'] = 'disabled'): ChatChannelDto {
  return { id: row.id, shopId: row.shop_id, shopName: row.shop.name, buyer: person(row.buyer), latestSequence: row.next_sequence, lastMessageAt: row.last_message_at?.toISOString() ?? null,
    activeRound: row.conversations[0] ? roundDto(row.conversations[0], request, role, mode) : null };
}
function messageDto(row: Message): ChatMessageDto {
  // Never spread raw models: event_data contains private actor identifiers.
  const product = chatProductSnapshotSchema.safeParse(row.product_context);
  const cards = agentCardSchema.array().max(6).safeParse(row.product_cards);
  return { id: row.id, channelId: row.channel_id, roundId: row.conversation_id, sequence: row.sequence, createdAt: row.created_at.toISOString(), senderType: row.sender_type as ChatMessageDto['senderType'], sender: row.sender_user ? person(row.sender_user) : null, content: row.content, product: product.success ? product.data : null, productCards: cards.success ? cards.data : [] };
}
const paramsId = (request: FastifyRequest) => uuidSchema.parse((request.params as { id: string }).id).toLowerCase();

// Ordinary reads/sends: shop -> sorted users -> members -> channel.
// Assignment/control operations insert the dispatch lock after the shop lock.
// SHARE shop lock excludes membership writers (which take UPDATE) but allows independent chats.
async function authorize(tx: Tx, request: FastifyRequest, shopId: string, seller: boolean) {
  await tx.$queryRaw`SELECT id FROM shops WHERE id=${shopId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM users WHERE id=${request.identity!.userId}::uuid FOR SHARE`;
  await requireLiveIdentity(request, tx);
  const shop = await tx.shop.findUnique({ where: { id: shopId } });
  if (shop?.status !== 'active') throw missing();
  if (!seller) { await requireLiveBuyer(request, tx); return undefined; }
  await tx.$queryRaw`SELECT id FROM shop_members WHERE shop_id=${shopId}::uuid AND user_id=${request.identity!.userId}::uuid FOR SHARE`;
  const member = await tx.shopMember.findUnique({ where: { shop_id_user_id: { shop_id: shopId, user_id: request.identity!.userId } } });
  if (member?.status !== 'active') throw new HttpError(403, 'CHAT_FORBIDDEN', '你没有该店铺的咨询权限');
  return member.role;
}
async function channelAccess(tx: Tx, request: FastifyRequest, id: string, seller: boolean) {
  const initial = await tx.chatChannel.findFirst({ where: { id, ...(seller ? { shop_id: request.shopId! } : { buyer_id: request.identity!.userId }) } });
  if (!initial) throw missing();
  const role = await authorize(tx, request, initial.shop_id, seller);
  if (seller) await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${id}::uuid FOR SHARE`;
  const row = await tx.chatChannel.findUniqueOrThrow({ where: { id }, include: channelInclude });
  const fullHistory = !seller || managesChat(role) || row.conversations.some(r => r.status === 'seller' && r.assigned_seller_id === request.identity!.userId && r.buyer_id !== request.identity!.userId);
  if (seller && (row.buyer_id === request.identity!.userId || (!fullHistory && !await tx.conversation.count({ where: { channel_id: id, ...staffRounds(request.identity!.userId) } })))) throw missing();
  return { row, role, fullHistory };
}
async function scopedChannel(tx: Tx, row: Channel, request: FastifyRequest, role?: string) {
  if (!role || managesChat(role) || row.conversations.some(r => r.status === 'seller' && r.assigned_seller_id === request.identity!.userId)) return row;
  const latest = await tx.message.findFirst({ where: { channel_id: row.id, conversation: staffRounds(request.identity!.userId) }, orderBy: { sequence: 'desc' } });
  return { ...row, conversations: [], last_message_at: latest?.created_at ?? null, next_sequence: latest?.sequence ?? 0 };
}
async function duplicate(tx: Tx, channelId: string, actorId: string, senderType: string, input: { clientMessageId: string; content: string; productId?: string; skuId?: string }, roundId?: string) {
  const old = await tx.message.findFirst({ where: { channel_id: channelId, sender_user_id: actorId, sender_type: senderType, client_message_id: input.clientMessageId }, include: messageInclude });
  const product = old ? messageDto(old).product : null;
  if (old && (old.content !== input.content || (roundId && old.conversation_id !== roundId) || (product?.id ?? null) !== (input.productId ?? null) || (product?.skuId ?? null) !== (input.skuId ?? null))) throw new HttpError(409, 'CHAT_MESSAGE_KEY_REUSED', '重试标识已经用于另一条消息，请重新发送');
  return old;
}
async function consultedProduct(tx: Tx, shopId: string, input: { productId?: string; skuId?: string }): Promise<ChatProductDto | undefined> {
  if (!input.productId) return undefined;
  // Snapshot only public, currently published goods from this conversation's shop.
  await tx.$queryRaw`SELECT id FROM products WHERE id=${input.productId}::uuid AND shop_id=${shopId}::uuid FOR SHARE`;
  const product = await tx.product.findFirst({ where: { id: input.productId, shop_id: shopId, status: 'active', skus: { some: { is_active: true } } }, select: { id: true, name: true, image_urls: true } });
  if (!product) throw new HttpError(404, 'CHAT_PRODUCT_UNAVAILABLE', '商品不存在、已下架或不属于当前店铺');
  let sku: { id: string; name: string } | null = null;
  if (input.skuId) {
    sku = await tx.sku.findFirst({ where: { id: input.skuId, product_id: product.id, is_active: true }, select: { id: true, name: true } });
    if (!sku) throw new HttpError(404, 'CHAT_PRODUCT_UNAVAILABLE', '规格不存在、已停用或不属于当前商品');
  }
  return { id: product.id, name: product.name, imageUrl: Array.isArray(product.image_urls) && typeof product.image_urls[0] === 'string' ? product.image_urls[0] : null, skuId: sku?.id ?? null, skuName: sku?.name ?? null };
}
async function write<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>) {
  try { return await db.$transaction(work, { maxWait: 10000, timeout: 15000 }); }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2028'].includes(error.code)) throw new HttpError(409, 'CHAT_BUSY', '咨询正在更新，请刷新后重试');
    throw error;
  }
}
function controlVersion(round: Pick<Round, 'status' | 'updated_at'>, version: string) {
  if (round.status === 'closed') throw new HttpError(409, 'CHAT_CLOSED', '本轮接待已结束');
  if (round.updated_at.toISOString() !== version) throw new HttpError(409, 'CHAT_CHANGED', '接待状态已更新，请刷新后重试');
}
const mustNotSelfServe = (buyerId: string, actorId: string) => { if (buyerId === actorId) throw new HttpError(403, 'CHAT_SELF_SERVICE', '不能作为客服接待自己发起的咨询'); };

export function registerChat(app: FastifyInstance, db: PrismaClient, sessions: AuthSessions, agentOptions: AgentOptions = {}) {
  const roundView = (row: Round, request: FastifyRequest, role?: string) => roundDto(row, request, role, agentOptions.mode ?? 'disabled');
  const channelView = (row: Channel, request: FastifyRequest, role?: string) => channelDto(row, request, role, agentOptions.mode ?? 'disabled');
  const dispatch = createDispatch(app, db, sessions, agentOptions.recoverReceptionOnStart, agentOptions.recoveryShopIds);
  const live = createChatLive(app);
  const agent = createAgentRuntime(app, db, dispatch, agentOptions, live.notify);
  const liveAuthorize = async (tx: Tx, request: FastifyRequest, shopId: string, seller: boolean) => {
    const role = await authorize(tx, request, shopId, seller);
    const user = await tx.user.findUniqueOrThrow({ where: { id: request.identity!.userId } });
    if (!request.sessionKey || !sessions.isLive(request.sessionKey, user)) throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
    return role;
  };
  const assist = registerReceptionAssist(app, db, agentOptions, liveAuthorize, live.notify);
  const sellerGuard = requireShop(db, 'catalog:read');
  app.get('/api/chat/shops/:id/events', { preHandler: requireBuyer }, async (request, reply) => {
    const shopId = paramsId(request);
    return live.stream(request, reply, () => write(db, async tx => {
      await liveAuthorize(tx, request, shopId, false);
      const channel = await tx.chatChannel.findUnique({ where: { shop_id_buyer_id: { shop_id: shopId, buyer_id: request.identity!.userId } }, include: channelInclude });
      const round = channel?.conversations[0];
      return { channelId: channel?.id ?? null, latestSequence: channel?.next_sequence ?? 0, round: round ? roundView(round, request) : null, progress: round ? agent.progress(round) : null };
    }));
  });
  app.get('/api/seller/chat/rounds/:id/events', { preHandler: sellerGuard }, async (request, reply) => {
    const id = paramsId(request);
    return live.stream(request, reply, () => write(db, async tx => {
      const role = await liveAuthorize(tx, request, request.shopId!, true);
      const initial = await tx.conversation.findFirst({ where: { id, shop_id: request.shopId! } });
      if (!initial) throw missing();
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${initial.channel_id}::uuid FOR SHARE`;
      const round = await tx.conversation.findUniqueOrThrow({ where: { id }, include: roundInclude });
      if (!canReadRound(round, request.identity!.userId, role)) throw missing();
      const channel = await tx.chatChannel.findUniqueOrThrow({ where: { id: round.channel_id }, include: channelInclude });
      const scoped = await scopedChannel(tx, channel, request, role);
      return { channelId: channel.id, latestSequence: scoped.next_sequence, round: roundView(round, request, role), progress: agent.progress(round) ?? assist.progress(request, round, scoped.next_sequence) };
    }));
  });
  app.get('/api/seller/chat/settings', { preHandler: sellerGuard }, async (request) => write(db, async (tx) => {
    const role = await authorize(tx, request, request.shopId!, true);
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: request.shopId! } });
    return { capacity: shop.chat_capacity, version: shop.updated_at.toISOString(), canEdit: role === 'owner' };
  }));
  app.post('/api/seller/chat/settings', { preHandler: sellerGuard }, async (request) => {
    const input = chatSettingsSchema.parse(request.body);
    const result = await write(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${request.shopId!}::uuid FOR UPDATE`;
      await lockDispatch(tx, request.shopId!);
      const role = await authorize(tx, request, request.shopId!, true);
      if (role !== 'owner') throw new HttpError(403, 'CHAT_SETTINGS_FORBIDDEN', '只有店长可以设置接待容量');
      const shop = await tx.shop.findUniqueOrThrow({ where: { id: request.shopId! } });
      if (shop.updated_at.toISOString() !== input.version) throw new HttpError(409, 'CHAT_SETTINGS_CHANGED', '接待设置已更新，请重新打开后再修改');
      const updated = await tx.shop.update({ where: { id: shop.id }, data: { chat_capacity: input.capacity, updated_at: nextStamp(shop) } });
      return { capacity: updated.chat_capacity, version: updated.updated_at.toISOString(), canEdit: true };
    });
    await dispatch.run(request.shopId!);
    return result;
  });
  app.get('/api/seller/chat/notifications', { preHandler: sellerGuard }, async (request) => write(db, async (tx) => {
    await authorize(tx, request, request.shopId!, true);
    return notifications(tx, request.shopId!, request.identity!.userId);
  }));
  app.post('/api/seller/chat/channels/:id/read', { preHandler: sellerGuard }, async (request) => {
    const channelId = paramsId(request), input = chatReadSchema.parse(request.body);
    return write(db, async (tx) => {
      const access = await channelAccess(tx, request, channelId, true);
      if (!access.fullHistory) throw missing();
      if (input.sequence && !await tx.message.findUnique({ where: { channel_id_sequence: { channel_id: channelId, sequence: input.sequence } }, select: { id: true } })) throw new HttpError(400, 'CHAT_READ_SEQUENCE', '已读位置不属于当前聊天记录');
      // GREATEST makes out-of-order acknowledgements and parallel tabs monotonic.
      const rows = await tx.$queryRaw<{ read_sequence: number }[]>`INSERT INTO chat_read_states(channel_id,user_id,read_sequence)
        VALUES (${channelId}::uuid,${request.identity!.userId}::uuid,${input.sequence})
        ON CONFLICT (channel_id,user_id) DO UPDATE SET read_sequence=GREATEST(chat_read_states.read_sequence,EXCLUDED.read_sequence),updated_at=CURRENT_TIMESTAMP
        RETURNING read_sequence`;
      return { sequence: rows[0]!.read_sequence };
    });
  });
  app.get('/api/chat/shops/:id', { preHandler: requireBuyer }, async (request) => write(db, async (tx) => {
    const shopId = paramsId(request); await authorize(tx, request, shopId, false);
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
    const channel = await tx.chatChannel.findUnique({ where: { shop_id_buyer_id: { shop_id: shopId, buyer_id: request.identity!.userId } }, include: channelInclude });
    return { shopId: shop.id, shopName: shop.name, channel: channel ? channelView(channel, request) : null };
  }));
  app.get('/api/chat/channels', { preHandler: requireBuyer }, async (request) => {
    const q = chatListSchema.parse(request.query);
    return write(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${request.identity!.userId}::uuid FOR SHARE`;
      await requireLiveBuyer(request, tx);
      const where = { buyer_id: request.identity!.userId, shop: { status: 'active' } };
      const rows = await tx.chatChannel.findMany({ where, include: channelInclude, orderBy: [{ last_message_at: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }); const total = await tx.chatChannel.count({ where });
      return { items: rows.map((row) => channelView(row, request)), total, page: q.page, pageSize: q.pageSize };
    });
  });
  app.post('/api/chat/shops/:id/messages', { preHandler: requireBuyer }, async (request, reply) => {
    const shopId = paramsId(request), input = chatSendSchema.parse(request.body), actorId = request.identity!.userId;
    const result = await write(db, async (tx) => {
      await authorize(tx, request, shopId, false);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${shopId}:${actorId}`}, 9301))::text`;
      const h = await tx.chatChannel.upsert({ where: { shop_id_buyer_id: { shop_id: shopId, buyer_id: actorId } }, create: { shop_id: shopId, buyer_id: actorId }, update: {} });
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${h.id}::uuid FOR UPDATE`;
      const old = await duplicate(tx, h.id, actorId, 'buyer', input);
      if (old) return { row: old, created: false, fresh: false };
      const product = await consultedProduct(tx, shopId, input);
      let round = await tx.conversation.findFirst({ where: { channel_id: h.id, status: { not: 'closed' } } });
      const fresh = !round;
      round ??= await tx.conversation.create({ data: { channel_id: h.id, shop_id: shopId, buyer_id: actorId, title: input.content.slice(0, 120), status: 'waiting_seller' } });
      const row = await append(tx, h.id, round.id, input.content, { sender_type: 'buyer', sender_user_id: actorId, client_message_id: input.clientMessageId, ...(product ? { product_context: product } : {}) });
      if (round.waiting_buyer_since) await tx.conversation.update({ where: { id: round.id }, data: { waiting_buyer_since: null, updated_at: nextStamp(round) } });
      if (fresh) await tx.inquiry.create({ data: { conversation_id: round.id, trigger_message_id: row.id, question: input.content, reason: 'user_request' } });
      if (round.status === 'agent') await agent.queue(tx, round.id, row.sequence);
      return { row, created: true, fresh };
    });
    if (result.created) {
      await dispatch.run(shopId, result.fresh && agent.enabled ? (tx) => agent.activate(tx, result.row.conversation_id) : undefined);
      // Generation is detached from delivery acknowledgement. This only admits
      // the durable task; the model itself is never awaited by this request.
      await agent.schedule(result.row.conversation_id);
    }
    return reply.code(result.created ? 201 : 200).send(messageDto(result.row));
  });
  app.post('/api/chat/rounds/:id/handoff', { preHandler: requireBuyer }, async (request) => {
    chatHeartbeatSchema.parse(request.body);
    const id = paramsId(request), shopId = await db.conversation.findFirst({ where: { id, buyer_id: request.identity!.userId }, select: { shop_id: true } });
    if (!shopId) throw missing();
    await write(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${shopId.shop_id}::uuid FOR SHARE`;
      await lockDispatch(tx, shopId.shop_id);
      await authorize(tx, request, shopId.shop_id, false);
      const initial = await tx.conversation.findUniqueOrThrow({ where: { id } });
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${initial.channel_id}::uuid FOR UPDATE`;
      const current = await tx.conversation.findUniqueOrThrow({ where: { id } });
      if (current.status === 'closed') throw new HttpError(409, 'CHAT_CLOSED', '本轮接待已结束');
      await agent.handoff(tx, id, { reason: 'user_request', question: '买家请求人工客服继续接待' });
    });
    agent.cancel(id); await dispatch.run(shopId.shop_id);
    return write(db, async (tx) => { await authorize(tx, request, shopId.shop_id, false); return roundView(await tx.conversation.findUniqueOrThrow({ where: { id }, include: roundInclude }), request); });
  });
  // Buyer can end their own active round; management can end an Agent round
  // without pretending to be its human assignee. A message snapshot prevents
  // closing over a reply which arrived while the confirmation was open.
  for (const seller of [false, true]) app.post(`${seller ? '/api/seller/chat' : '/api/chat'}/rounds/:id/end`, { preHandler: seller ? sellerGuard : requireBuyer }, async request => {
    const input = chatEndSchema.parse(request.body), id = paramsId(request);
    const initial = await db.conversation.findFirst({ where: { id, ...(seller ? { shop_id: request.shopId! } : { buyer_id: request.identity!.userId }) } });
    if (!initial) throw missing();
    await write(db, async tx => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${initial.shop_id}::uuid FOR SHARE`;
      await lockDispatch(tx, initial.shop_id);
      const role = await authorize(tx, request, initial.shop_id, seller);
      if (seller) mustNotSelfServe(initial.buyer_id, request.identity!.userId);
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${initial.channel_id}::uuid FOR UPDATE`;
      const round = await tx.conversation.findUniqueOrThrow({ where: { id } });
      if (seller && (!['owner', 'manager'].includes(role!) || round.status !== 'agent')) throw new HttpError(403, 'CHAT_END_FORBIDDEN', '只有店长或经理可以在此结束导购接待');
      controlVersion(round, input.version);
      const channel = await tx.chatChannel.findUniqueOrThrow({ where: { id: round.channel_id } });
      if (channel.next_sequence !== input.lastSequence) throw new HttpError(409, 'CHAT_NEW_MESSAGES', '收到新消息，请查看后再结束咨询');
      await tx.conversation.update({ where: { id }, data: { status: 'closed', ended_at: new Date(sessions.now()), waiting_buyer_since: null, assigned_offline_at: null, agent_run_status: 'cancelled', agent_generation: { increment: 1 }, updated_at: nextStamp(round) } });
      await tx.inquiry.updateMany({ where: { conversation_id: id, status: { in: ['pending', 'processing'] } }, data: { status: 'resolved', resolved_at: new Date(sessions.now()), resolution: seller ? '店铺管理人员结束导购接待' : '买家主动结束咨询' } });
      await append(tx, round.channel_id, id, seller ? '店铺已结束本轮导购接待。' : '买家已结束本轮咨询。', { sender_type: 'system', event_data: { type: seller ? 'agent_closed_by_manager' : 'buyer_closed', actorUserId: request.identity!.userId } });
    });
    agent.cancel(id); await dispatch.run(initial.shop_id);
    return { ended: true };
  });
  for (const seller of [false, true]) {
    const base = seller ? '/api/seller/chat/channels' : '/api/chat/channels';
    const preHandler = seller ? sellerGuard : requireBuyer;
    app.get(`${base}/:id`, { preHandler }, async (request) => write(db, async (tx) => {
      const { row, role } = await channelAccess(tx, request, paramsId(request), seller); return channelView(await scopedChannel(tx, row, request, role), request, role);
    }));
    app.get(`${base}/:id/rounds`, { preHandler }, async (request) => {
      const q = chatListSchema.parse(request.query), channelId = paramsId(request);
      return write(db, async (tx) => {
        const { role, fullHistory } = await channelAccess(tx, request, channelId, seller);
        const where = { channel_id: channelId, ...(!fullHistory ? staffRounds(request.identity!.userId) : {}) };
        const rows = await tx.conversation.findMany({ where, include: roundInclude, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }); const total = await tx.conversation.count({ where });
        return { items: rows.map((row) => roundView(row, request, role)), total, page: q.page, pageSize: q.pageSize };
      });
    });
    app.get(`${base}/:id/messages`, { preHandler }, async (request) => {
      const q = chatMessagesQuerySchema.parse(request.query), channelId = paramsId(request);
      return write(db, async (tx) => {
        const { fullHistory } = await channelAccess(tx, request, channelId, seller);
        if (!fullHistory && (!q.roundId || !await tx.conversation.findFirst({ where: { id: q.roundId, channel_id: channelId, ...staffRounds(request.identity!.userId) } }))) throw missing();
        if (q.roundId && !await tx.conversation.findFirst({ where: { id: q.roundId, channel_id: channelId } })) throw missing();
        const rows = await tx.message.findMany({ where: { channel_id: channelId, ...(q.roundId ? { conversation_id: q.roundId } : {}), sequence: { ...(q.before === undefined ? {} : { lt: q.before }), ...(q.after === undefined ? {} : { gt: q.after }) } }, include: messageInclude, orderBy: { sequence: q.after === undefined ? 'desc' : 'asc' }, take: q.limit + 1 });
        const hasMore = rows.length > q.limit, page = rows.slice(0, q.limit);
        const nextCursor = page.at(-1)?.sequence ?? null;
        if (q.after === undefined) page.reverse();
        return { items: page.map(messageDto), hasMore, nextCursor };
      });
    });
  }
  app.get('/api/seller/chat/rounds/:id', { preHandler: sellerGuard }, async (request) => write(db, async (tx) => {
    const row = await tx.conversation.findFirst({ where: { id: paramsId(request), shop_id: request.shopId! }, include: { ...roundInclude, channel: { include: channelInclude } } });
    if (!row) throw missing();
    const role = await authorize(tx, request, request.shopId!, true);
    await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${row.channel_id}::uuid FOR SHARE`;
    // Re-read after the authorization locks so control state cannot predate a permission wait.
    const current = await tx.conversation.findUniqueOrThrow({ where: { id: row.id }, include: { ...roundInclude, channel: { include: channelInclude } } });
    if (!canReadRound(current, request.identity!.userId, role)) throw missing();
    return { round: roundView(current, request, role), channel: channelView(await scopedChannel(tx, current.channel, request, role), request, role) };
  }));
  app.get('/api/seller/chat/availability', { preHandler: sellerGuard }, async (request) => write(db, async (tx) => {
    await authorize(tx, request, request.shopId!, true);
    return dispatch.state(tx, request);
  }));
  app.get('/api/seller/chat/leave', { preHandler: sellerGuard }, async request => write(db, async tx => {
    await authorize(tx, request, request.shopId!, true);
    const rounds = await tx.conversation.findMany({ where: { shop_id: request.shopId!, status: 'seller', assigned_seller_id: request.identity!.userId }, orderBy: { id: 'asc' } });
    return { roundVersions: rounds.map(r => ({ id: r.id, version: r.updated_at.toISOString() })) };
  }));
  app.post('/api/seller/chat/leave', { preHandler: sellerGuard }, async request => {
    const input = chatLeaveSchema.parse(request.body);
    await write(db, async tx => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${request.shopId!}::uuid FOR SHARE`;
      await lockDispatch(tx, request.shopId!);
      await authorize(tx, request, request.shopId!, true);
      const rounds = await tx.conversation.findMany({ where: { shop_id: request.shopId!, status: 'seller', assigned_seller_id: request.identity!.userId }, orderBy: { id: 'asc' } });
      if (rounds.length !== input.roundVersions.length || new Set(input.roundVersions.map(r => r.id)).size !== rounds.length || rounds.some(r => !input.roundVersions.some(v => v.id === r.id && v.version === r.updated_at.toISOString()))) throw new HttpError(409, 'CHAT_LEAVE_CHANGED', '你的接待列表已变化，请重新确认离岗交接');
      for (const round of rounds) {
        await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${round.channel_id}::uuid FOR UPDATE`;
        const current = await tx.conversation.findUniqueOrThrow({ where: { id: round.id } });
        controlVersion(current, round.updated_at.toISOString());
        await requeueRound(tx, current, 'leave', new Date(sessions.now()));
      }
      // Fail closed if commit fails: a leaving operator must not receive new work.
      dispatch.touch(request, false);
    });
    await dispatch.run(request.shopId!);
    return write(db, async tx => { await authorize(tx, request, request.shopId!, true); return dispatch.state(tx, request); });
  });
  for (const action of ['availability', 'heartbeat'] as const) app.post(`/api/seller/chat/${action}`, { preHandler: sellerGuard }, async (request) => {
    const available = action === 'availability' ? chatAvailabilitySchema.parse(request.body).available : (chatHeartbeatSchema.parse(request.body), undefined);
    await write(db, async (tx) => {
      await authorize(tx, request, request.shopId!, true);
      dispatch.touch(request, available);
    });
    await dispatch.run(request.shopId!);
    return write(db, async (tx) => { await authorize(tx, request, request.shopId!, true); return dispatch.state(tx, request); });
  });
  app.get('/api/seller/chat/agents', { preHandler: sellerGuard }, async (request) => write(db, async (tx) => {
    await authorize(tx, request, request.shopId!, true);
    const rows = await tx.shopMember.findMany({ where: { shop_id: request.shopId!, status: 'active', user: { status: 'active', password_hash: { not: null } } }, include: { user: true }, orderBy: { id: 'asc' } });
    const counts = await dispatch.counts(tx, request.shopId!);
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: request.shopId! }, select: { chat_capacity: true } });
    return { items: rows.map((m) => ({ memberId: m.id, ...person(m.user), role: m.role, online: dispatch.online(request.shopId!, m.user), activeCount: counts.get(m.user_id) ?? 0, capacity: shop.chat_capacity })) };
  }));
  app.get('/api/seller/chat/rounds', { preHandler: sellerGuard }, async (request) => {
    const q = chatInboxSchema.parse(request.query);
    return write(db, async (tx) => {
      const role = await authorize(tx, request, request.shopId!, true);
      const where: Prisma.ConversationWhereInput = { shop_id: request.shopId!, buyer_id: { not: request.identity!.userId }, AND: [!managesChat(role) ? staffRounds(request.identity!.userId) : {}, q.view === 'waiting' ? { status: 'waiting_seller' } : q.view === 'mine' ? { status: 'seller', assigned_seller_id: request.identity!.userId } : q.view === 'closed' ? { status: 'closed' } : {}] };
      const rows = await tx.conversation.findMany({ where, include: { ...roundInclude, channel: { include: channelInclude } }, orderBy: [{ last_message_at: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }); const total = await tx.conversation.count({ where });
      const alerts = new Map((await notifications(tx, request.shopId!, request.identity!.userId)).items.map((item) => [item.roundId, item]));
      return { items: await Promise.all(rows.map(async row => ({ round: roundView(row, request, role), channel: channelView(await scopedChannel(tx, row.channel, request, role), request, role), unreadCount: alerts.get(row.id)?.unreadCount ?? 0, assignmentUnread: alerts.get(row.id)?.assignmentUnread ?? false }))), canViewAll: managesChat(role), total, page: q.page, pageSize: q.pageSize };
    });
  });
  for (const action of ['transfer', 'close', 'messages', 'waiting'] as const) app.post(`/api/seller/chat/rounds/:id/${action}`, { preHandler: sellerGuard }, async (request, reply) => {
    const id = paramsId(request);
    const input = action === 'messages' ? chatReplySchema.parse(request.body) : action === 'transfer' ? chatTransferSchema.parse(request.body) : action === 'waiting' ? chatWaitingSchema.parse(request.body) : chatCloseSchema.parse(request.body);
    const result = await write(db, async (tx) => {
      const initial = await tx.conversation.findFirst({ where: { id, shop_id: request.shopId! } });
      if (!initial) throw missing();
      // Transfer locks both actor and recipient users in ID order before member/channel locks.
      const target = action === 'transfer' ? await tx.shopMember.findFirst({ where: { id: chatTransferSchema.parse(input).memberId, shop_id: request.shopId! } }) : null;
      if (action === 'transfer' && !target) throw new HttpError(404, 'CHAT_RECIPIENT_UNAVAILABLE', '接待人员不存在或不可用');
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${request.shopId!}::uuid FOR SHARE`;
      await lockDispatch(tx, request.shopId!);
      for (const userId of [...new Set([request.identity!.userId, ...(target ? [target.user_id] : [])])].sort()) await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR SHARE`;
      const role = await authorize(tx, request, request.shopId!, true);
      if (target) await tx.$queryRaw`SELECT id FROM shop_members WHERE id=${target.id}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${initial.channel_id}::uuid FOR UPDATE`;
      const round = await tx.conversation.findUniqueOrThrow({ where: { id }, include: roundInclude }), actorId = request.identity!.userId;
      mustNotSelfServe(round.buyer_id, actorId);
      if (action === 'messages') {
        const message = chatReplySchema.parse(input), old = await duplicate(tx, round.channel_id, actorId, 'seller', message, round.id);
        if (old) return { message: messageDto(old), created: false };
      }
      controlVersion(round, input.version);
      const assignedToMe = round.status === 'seller' && round.assigned_seller_id === actorId;
      if (action === 'waiting') {
        if (!assignedToMe) throw new HttpError(403, 'CHAT_NOT_ASSIGNED', '只有当前接待人员可以标记等待买家');
        const { waiting, lastSequence } = chatWaitingSchema.parse(input);
        if ((await tx.chatChannel.findUniqueOrThrow({ where: { id: round.channel_id } })).next_sequence !== lastSequence) throw new HttpError(409, 'CHAT_NEW_MESSAGES', '收到新消息，请查看后再更新接待状态');
        const updated = await tx.conversation.update({ where: { id }, data: { waiting_buyer_since: waiting ? round.waiting_buyer_since ?? new Date(sessions.now()) : null, updated_at: nextStamp(round) }, include: roundInclude });
        return { round: roundView(updated, request, role) };
      }
      if (action === 'messages') {
        if (!assignedToMe) throw new HttpError(403, 'CHAT_NOT_ASSIGNED', '只有当前接待人员可以回复');
        const message = chatReplySchema.parse(input);
        await assist.check(tx, request, round, message.suggestionId);
        const row = await append(tx, round.channel_id, id, message.content, { sender_type: 'seller', sender_user_id: actorId, client_message_id: message.clientMessageId });
        assist.consume(message.suggestionId);
        if (round.waiting_buyer_since) await tx.conversation.update({ where: { id }, data: { waiting_buyer_since: null, updated_at: nextStamp(round) } });
        return { message: messageDto(row), created: true };
      }
      let assignedId: string, eventType: string, content: string;
      if (action === 'close') {
        if (!assignedToMe) throw new HttpError(403, 'CHAT_NOT_ASSIGNED', '只有当前接待人员可以结束接待');
        assignedId = actorId; eventType = 'closed'; content = '本轮接待已结束';
      } else {
        if (!assignedToMe && !['owner', 'manager'].includes(role!)) throw new HttpError(403, 'CHAT_NOT_ASSIGNED', '不能转接其他客服负责的咨询');
        const recipient = await tx.shopMember.findFirst({ where: { id: target!.id, shop_id: request.shopId!, status: 'active', user: { status: 'active', password_hash: { not: null } } }, include: { user: true } });
        if (!recipient) throw new HttpError(409, 'CHAT_RECIPIENT_UNAVAILABLE', '接待人员已停用或不可用');
        mustNotSelfServe(round.buyer_id, recipient.user_id);
        const allowOffline = chatTransferSchema.parse(input).allowOffline;
        if (allowOffline && !['owner', 'manager'].includes(role!)) throw new HttpError(403, 'CHAT_OFFLINE_ASSIGN_FORBIDDEN', '只有店长或经理可以指派离线人员');
        const capacity = (await tx.shop.findUniqueOrThrow({ where: { id: request.shopId! }, select: { chat_capacity: true } })).chat_capacity;
        if (await tx.conversation.count({ where: { shop_id: request.shopId!, status: 'seller', assigned_seller_id: recipient.user_id, id: { not: id } } }) >= capacity) throw new HttpError(409, 'CHAT_RECIPIENT_BUSY', '该客服已达到接待容量，请选择其他同事');
        if (!allowOffline && !dispatch.online(request.shopId!, recipient.user)) throw new HttpError(409, 'CHAT_RECIPIENT_OFFLINE', '该客服当前未上线，请选择在线同事');
        if (round.assigned_seller_id === recipient.user_id) throw new HttpError(409, 'CHAT_SAME_ASSIGNEE', '该咨询已由此客服接待');
        assignedId = recipient.user_id; eventType = assignedToMe ? 'transferred' : 'reassigned'; content = '咨询已转交客服接待';
      }
      const closed = action === 'close', stamp = nextStamp(round);
      if (round.status === 'agent') {
        const trigger = await tx.message.findFirstOrThrow({ where: { conversation_id: id, sender_type: 'buyer' }, orderBy: { sequence: 'desc' } });
        await tx.inquiry.create({ data: { conversation_id: id, trigger_message_id: trigger.id, question: trigger.content, reason: 'user_request' } });
      }
      const updated = await tx.conversation.update({ where: { id }, data: { status: closed ? 'closed' : 'seller', assigned_seller_id: assignedId, ended_at: closed ? new Date() : null, waiting_buyer_since: null, assigned_offline_at: null, updated_at: stamp, agent_run_status: 'cancelled', agent_generation: { increment: 1 } }, include: roundInclude });
      const changed = await tx.inquiry.updateMany({ where: { conversation_id: id, status: { in: ['pending', 'processing'] } }, data: { status: closed ? 'resolved' : 'processing', assigned_seller_id: assignedId, ...(closed ? { resolution: chatCloseSchema.parse(input).resolution, resolved_at: new Date() } : {}) } });
      if (changed.count !== 1) throw new HttpError(409, 'CHAT_INQUIRY_CHANGED', '咨询待办状态异常，请刷新后重试');
      await append(tx, round.channel_id, id, content, { sender_type: 'system', event_data: { type: eventType, actorUserId: actorId, fromUserId: round.assigned_seller_id, toUserId: assignedId } });
      return { round: roundView(updated, request, role) };
    });
    if ('message' in result) return reply.code(result.created ? 201 : 200).send(result.message);
    if (action !== 'waiting') agent.cancel(id);
    await dispatch.run(request.shopId!);
    return result.round;
  });
}

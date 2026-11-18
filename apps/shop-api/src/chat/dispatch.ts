import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import { HttpError, type AuthSessions } from '../auth/index.ts';
import { nextStamp } from '../transactions/locks.ts';
import { append } from './storage.ts';
import { requeueRound } from './lifecycle.ts';

type Tx = Prisma.TransactionClient;
const leaseMs = 45_000;
const graceMs = 120_000;
// All assignment changes use this lock before locking users/members/channels.
// Presence is ephemeral, but capacity and queue assignments are transactional.
export async function lockDispatch(tx: Tx, shopId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${shopId}, 9302))::text`;
}
export function createDispatch(app: FastifyInstance, db: PrismaClient, sessions: AuthSessions, recoverOnStart = false, recoveryShopIds?: string[]) {
  const leases = new Map<string, { shopId: string; userId: string; sessionKey: string; expiresAt: number }>();
  const paused = new Map<string, string>();
  const shops = new Set<string>();
  const bootTime = sessions.now();
  const key = (shopId: string, userId: string) => `${shopId}:${userId}`;
  function online(shopId: string, user: Parameters<AuthSessions['isLive']>[1]) {
    const lease = leases.get(key(shopId, user.id));
    return !!lease && lease.expiresAt > sessions.now() && sessions.isLive(lease.sessionKey, user);
  }
  function touch(request: FastifyRequest, available?: boolean) {
    const shopId = request.shopId!, userId = request.identity!.userId, k = key(shopId, userId);
    shops.add(shopId);
    if (available === false) {
      if (!paused.has(k) && paused.size >= 10000) throw new HttpError(503, 'CHAT_PRESENCE_CAPACITY', '接待服务繁忙，请稍后重试');
      leases.delete(k); paused.set(k, request.sessionKey!); return;
    }
    const old = leases.get(k);
    // A heartbeat renews an existing lease, never switches an offline account online.
    if (available === undefined && (!old || old.sessionKey !== request.sessionKey || old.expiresAt <= sessions.now())) return;
    if (!old && leases.size >= 10000) throw new HttpError(503, 'CHAT_PRESENCE_CAPACITY', '接待服务繁忙，请稍后重试');
    paused.delete(k);
    leases.set(k, { shopId, userId, sessionKey: request.sessionKey!, expiresAt: sessions.now() + leaseMs });
  }
  async function counts(tx: Tx, shopId: string) {
    const rows = await tx.conversation.groupBy({ by: ['assigned_seller_id'], where: { shop_id: shopId, status: 'seller' }, _count: true });
    return new Map(rows.filter((r) => r.assigned_seller_id).map((r) => [r.assigned_seller_id!, r._count]));
  }
  async function state(tx: Tx, request: FastifyRequest) {
    const lease = leases.get(key(request.shopId!, request.identity!.userId));
    const available = !!lease && lease.sessionKey === request.sessionKey && lease.expiresAt > sessions.now();
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: request.shopId! }, select: { chat_capacity: true } });
    return { available, capacity: shop.chat_capacity, expiresAt: available ? new Date(lease.expiresAt).toISOString() : null,
      activeCount: await tx.conversation.count({ where: { shop_id: request.shopId!, status: 'seller', assigned_seller_id: request.identity!.userId } }) };
  }
  async function processQueue(shopId: string, afterQueue?: (tx: Tx) => Promise<void>) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${shopId}::uuid FOR SHARE`;
      await lockDispatch(tx, shopId);
      const shop = await tx.shop.findUnique({ where: { id: shopId } });
      if (shop?.status !== 'active') {
        shops.delete(shopId);
        for (const [k, lease] of leases) if (lease.shopId === shopId) leases.delete(k);
        for (const k of paused.keys()) if (k.startsWith(`${shopId}:`)) paused.delete(k);
        return;
      }
      const capacity = shop.chat_capacity;
      // Lock all involved identities before any channel, including disconnected
      // assignees. The same order is used by transfer, leave and close.
      const active = await tx.conversation.findMany({ where: { shop_id: shopId, status: 'seller' }, orderBy: { id: 'asc' } });
      const people = [...new Set([...active.flatMap(r => r.assigned_seller_id ? [r.assigned_seller_id] : []), ...[...leases.values()].filter(l => l.shopId === shopId).map(l => l.userId)])].sort();
      for (const userId of people) await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR SHARE`;
      for (const userId of people) await tx.$queryRaw`SELECT id FROM shop_members WHERE shop_id=${shopId}::uuid AND user_id=${userId}::uuid FOR SHARE`;
      const validMembers = await tx.shopMember.findMany({ where: { shop_id: shopId, user_id: { in: people }, status: 'active' }, include: { user: true } });
      for (const k of paused.keys()) if (k.startsWith(`${shopId}:`)) {
        const member = validMembers.find(m => key(shopId, m.user_id) === k);
        if (!member || !sessions.isLive(paused.get(k)!, member.user)) paused.delete(k);
      }
      for (const initial of active) {
        const member = validMembers.find(m => m.user_id === initial.assigned_seller_id);
        const k = key(shopId, initial.assigned_seller_id!);
        const intentionallyPaused = member && paused.has(k) && sessions.isLive(paused.get(k)!, member.user);
        if (member && (online(shopId, member.user) || intentionallyPaused)) {
          if (initial.assigned_offline_at) await tx.$executeRaw`UPDATE conversations SET assigned_offline_at=NULL WHERE id=${initial.id}::uuid`;
          continue;
        }
        await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${initial.channel_id}::uuid FOR UPDATE`;
        const round = await tx.conversation.findUniqueOrThrow({ where: { id: initial.id } });
        if (round.status !== 'seller' || round.assigned_seller_id !== initial.assigned_seller_id) continue;
        // Presence can change while waiting for the channel; do not detach an
        // operator who just returned or explicitly paused with work retained.
        if (member && (online(shopId, member.user) || (paused.has(k) && sessions.isLive(paused.get(k)!, member.user)))) {
          if (round.assigned_offline_at) await tx.$executeRaw`UPDATE conversations SET assigned_offline_at=NULL WHERE id=${round.id}::uuid`;
          continue;
        }
        // A restart gets a fresh grace window, since process-local presence was lost.
        const disconnectedAt = Math.max(bootTime, round.assigned_offline_at?.getTime() ?? Math.min(leases.get(k)?.expiresAt ?? sessions.now(), sessions.now()));
        if (sessions.now() - disconnectedAt >= graceMs && round.auto_requeue_count < 3) await requeueRound(tx, round, 'offline', new Date(sessions.now()));
        else if (round.assigned_offline_at?.getTime() !== disconnectedAt) await tx.$executeRaw`UPDATE conversations SET assigned_offline_at=${new Date(disconnectedAt)} WHERE id=${round.id}::uuid`;
      }
      async function assignWaiting() {
        const candidates = [...leases.values()].filter((l) => l.shopId === shopId && l.expiresAt > sessions.now()).sort((a, b) => a.userId.localeCompare(b.userId));
        if (!candidates.length) return;
        // Lock sorted identities and memberships before any channel; live DB state and
        // session validity both matter, including logout and password/name changes.
        const members = validMembers;
        const load = await counts(tx, shopId);
        const free = members.filter((m) => {
          const lease = leases.get(key(shopId, m.user_id));
          return lease && lease.expiresAt > sessions.now() && sessions.isLive(lease.sessionKey, m.user) && (load.get(m.user_id) ?? 0) < capacity;
        });
        if (!free.length) return;
        // An old Agent round joins the human queue at handoff time, not at the
        // original conversation creation time. Inquiry timestamps remain stable
        // on retries, so handoff cannot jump or reset the waiting order.
        const queue = await tx.inquiry.findMany({ where: { status: 'pending', conversation: { shop_id: shopId, status: 'waiting_seller', assigned_seller_id: null } }, include: { conversation: true }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 100 });
        for (const { conversation: waiting } of queue) {
          if (!free.length) break;
          const possible = free.filter((m) => m.user_id !== waiting.buyer_id && (load.get(m.user_id) ?? 0) < capacity);
          if (!possible.length) continue;
          const minimum = Math.min(...possible.map((m) => load.get(m.user_id) ?? 0));
          const leastLoaded = possible.filter((m) => (load.get(m.user_id) ?? 0) === minimum);
          const chosen = leastLoaded[randomInt(leastLoaded.length)]!;
          // A browser may pause/logout while this transaction is waiting for a lock.
          const lease = leases.get(key(shopId, chosen.user_id));
          if (!lease || lease.expiresAt <= sessions.now() || !sessions.isLive(lease.sessionKey, chosen.user)) { free.splice(free.indexOf(chosen), 1); continue; }
          await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${waiting.channel_id}::uuid FOR UPDATE`;
          const round = await tx.conversation.findUniqueOrThrow({ where: { id: waiting.id } });
          if (round.status !== 'waiting_seller' || round.assigned_seller_id) continue;
          // Recheck after the channel wait as well, with no await before the update.
          if (leases.get(key(shopId, chosen.user_id)) !== lease || lease.expiresAt <= sessions.now() || !sessions.isLive(lease.sessionKey, chosen.user)) { free.splice(free.indexOf(chosen), 1); continue; }
          await tx.conversation.update({ where: { id: round.id }, data: { status: 'seller', assigned_seller_id: chosen.user_id, waiting_buyer_since: null, assigned_offline_at: null, updated_at: nextStamp(round) } });
          const changed = await tx.inquiry.updateMany({ where: { conversation_id: round.id, status: 'pending' }, data: { status: 'processing', assigned_seller_id: chosen.user_id } });
          if (changed.count !== 1) throw new HttpError(409, 'CHAT_INQUIRY_CHANGED', '咨询待办状态异常');
          await append(tx, round.channel_id, round.id, '已为你分配客服，客服会在这里回复', { sender_type: 'system', event_data: { type: 'auto_assigned', fromUserId: null, toUserId: chosen.user_id } });
          load.set(chosen.user_id, (load.get(chosen.user_id) ?? 0) + 1);
          if (load.get(chosen.user_id)! >= capacity) free.splice(free.indexOf(chosen), 1);
        }
      }
      await assignWaiting();
      await afterQueue?.(tx);
      if (!await tx.conversation.count({ where: { shop_id: shopId, status: { in: ['seller', 'waiting_seller'] } } }) && ![...leases.values()].some(l => l.shopId === shopId && l.expiresAt > sessions.now())) shops.delete(shopId);
    }, { maxWait: 10000, timeout: 15000 });
  }
  async function run(shopId: string, afterQueue?: (tx: Tx) => Promise<void>) {
    shops.add(shopId);
    // Sending the buyer's message has already committed. Dispatch failure must not
    // report a failed send: leave the durable queue for the next heartbeat/tick.
    try { await processQueue(shopId, afterQueue); }
    catch (err) { app.log.error({ err, shopId }, 'automatic chat assignment deferred'); }
  }
  let tick: Promise<void> | undefined, stopped = false;
  const timer = setInterval(() => {
    if (tick || stopped || !shops.size) return;
    tick = (async () => {
      for (const shopId of [...shops]) { if (stopped) break; await run(shopId); }
      // Keep expired leases during grace so its start is the actual expiry.
      for (const [k, lease] of leases) if (lease.expiresAt + graceMs < sessions.now()) leases.delete(k);
    })().finally(() => { tick = undefined; });
  }, 3000);
  timer.unref();
  app.addHook('onReady', async () => {
    if (!recoverOnStart) return;
    const rows = await db.conversation.findMany({ where: { status: { in: ['seller', 'waiting_seller'] }, ...(recoveryShopIds ? { shop_id: { in: recoveryShopIds } } : {}) }, select: { shop_id: true }, distinct: ['shop_id'] });
    for (const row of rows) await run(row.shop_id);
  });
  app.addHook('preClose', async () => { stopped = true; clearInterval(timer); await tick; leases.clear(); paused.clear(); shops.clear(); });
  return { touch, state, counts, online, run };
}

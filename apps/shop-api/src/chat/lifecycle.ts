import { Prisma } from '@shop/database';
import { HttpError } from '../auth/index.ts';
import { nextStamp } from '../transactions/locks.ts';
import { append } from './storage.ts';

// Caller holds the shop dispatch lock and the channel lock.
export async function requeueRound(tx: Prisma.TransactionClient, round: Prisma.ConversationGetPayload<{}>, reason: 'leave' | 'offline', now: Date) {
  const updated = await tx.conversation.update({ where: { id: round.id }, data: {
    status: 'waiting_seller', assigned_seller_id: null, waiting_buyer_since: null, assigned_offline_at: null,
    ...(reason === 'offline' ? { auto_requeue_count: { increment: 1 } } : {}), updated_at: nextStamp(round),
  } });
  const changed = await tx.inquiry.updateMany({ where: { conversation_id: round.id, status: 'processing' }, data: { status: 'pending', assigned_seller_id: null, created_at: now } });
  if (changed.count !== 1) throw new HttpError(409, 'CHAT_INQUIRY_CHANGED', '咨询待办状态异常，请刷新后重试');
  await append(tx, round.channel_id, round.id, reason === 'leave' ? '客服已交接，本轮咨询正在等待其他客服接待。' : '客服连接中断，正在为你重新安排人工接待。', { sender_type: 'system', event_data: { type: reason === 'leave' ? 'staff_leave' : 'offline_requeued', fromUserId: round.assigned_seller_id } });
  return updated;
}

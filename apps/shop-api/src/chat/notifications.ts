import type { Prisma } from '@shop/database';
import type { ChatNotificationsDto } from '@shop/contracts';

// Scope comes from a live shop authorization. Reader identity is never supplied
// by the client. Only the current assignee gets notifications for an active round.
export async function notifications(tx: Prisma.TransactionClient, shopId: string, userId: string): Promise<ChatNotificationsDto> {
  const rows = await tx.$queryRaw<{ roundId: string; channelId: string; username: string; displayName: string; unreadCount: bigint; assignmentUnread: boolean; latestSequence: number }[]>`
    SELECT c.id AS "roundId", c.channel_id AS "channelId", u.username, u.display_name AS "displayName",
      count(m.id) FILTER (WHERE m.sender_type='buyer' AND m.sequence>COALESCE(r.read_sequence,0)) AS "unreadCount",
      COALESCE(bool_or(m.sender_type='system' AND m.event_data->>'toUserId'=${userId}
        AND m.sequence>COALESCE(r.read_sequence,0)),false) AS "assignmentUnread",
      COALESCE(max(m.sequence) FILTER (WHERE m.sender_type='buyer' OR
        (m.sender_type='system' AND m.event_data->>'toUserId'=${userId})),0) AS "latestSequence"
    FROM conversations c
    JOIN users u ON u.id=c.buyer_id
    LEFT JOIN chat_read_states r ON r.channel_id=c.channel_id AND r.user_id=${userId}::uuid
    LEFT JOIN messages m ON m.conversation_id=c.id
    WHERE c.shop_id=${shopId}::uuid AND c.status='seller' AND c.assigned_seller_id=${userId}::uuid
    GROUP BY c.id, c.channel_id, u.username, u.display_name
    HAVING count(m.id) FILTER (WHERE m.sender_type='buyer' AND m.sequence>COALESCE(r.read_sequence,0))>0
      OR COALESCE(bool_or(m.sender_type='system' AND m.event_data->>'toUserId'=${userId}
        AND m.sequence>COALESCE(r.read_sequence,0)),false)
    ORDER BY max(m.created_at) DESC, c.id`;
  const items = rows.map(({ username, displayName, unreadCount, ...row }) => ({ ...row, buyer: { username, displayName }, unreadCount: Number(unreadCount) }));
  return { items, unreadCount: items.reduce((sum, row) => sum + row.unreadCount, 0), conversationCount: items.length };
}

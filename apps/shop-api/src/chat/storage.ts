import { Prisma } from '@shop/database';
type Tx = Prisma.TransactionClient;
export const messageInclude = { sender_user: { select: { username: true, display_name: true } } } as const;
export async function append(tx: Tx, channelId: string, roundId: string, content: string, data: { sender_type: string; sender_user_id?: string; client_message_id?: string; event_data?: Prisma.InputJsonValue; product_context?: Prisma.InputJsonValue; product_cards?: Prisma.InputJsonValue }) {
  const channel = await tx.chatChannel.update({ where: { id: channelId }, data: { next_sequence: { increment: 1 }, last_message_at: new Date() } });
  const row = await tx.message.create({ data: { channel_id: channelId, conversation_id: roundId, sequence: channel.next_sequence, content, ...data }, include: messageInclude });
  // Control version changes only on state/assignment operations, never on incoming messages.
  await tx.$executeRaw`UPDATE conversations SET last_message_at=${row.created_at} WHERE id=${roundId}::uuid`;
  return row;
}

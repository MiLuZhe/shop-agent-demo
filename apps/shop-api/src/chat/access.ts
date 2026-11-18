import type { Prisma } from '@shop/database';

export const managesChat = (role: string | undefined) => role === 'owner' || role === 'manager';
export function staffRounds(userId: string): Prisma.ConversationWhereInput {
  return { assigned_seller_id: userId, status: { in: ['seller', 'closed'] }, buyer_id: { not: userId } };
}
export function canReadRound(round: { status: string; buyer_id: string; assigned_seller_id: string | null }, userId: string, role: string | undefined) {
  return round.buyer_id !== userId && (managesChat(role) || (round.assigned_seller_id === userId && ['seller', 'closed'].includes(round.status)));
}

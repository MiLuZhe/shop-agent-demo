import { z } from 'zod';
import { paginationSchema, uuidSchema } from './common.ts';

const chatTextSchema = z.object({ clientMessageId: uuidSchema.transform((v) => v.toLowerCase()), content: z.string().trim().min(1).max(4000).refine((v) => !v.includes('\0'), '消息包含无效字符') }).strict();
export const chatSendSchema = chatTextSchema.extend({ productId: uuidSchema.transform((v) => v.toLowerCase()).optional(), skuId: uuidSchema.transform((v) => v.toLowerCase()).optional() })
  .refine((v) => !v.skuId || !!v.productId, { message: '规格必须关联商品', path: ['productId'] });
export const chatVersionSchema = z.object({ version: z.iso.datetime() }).strict();
export const chatReplySchema = chatTextSchema.extend({ version: z.iso.datetime(), suggestionId: uuidSchema.optional() }).strict();
export const chatTransferSchema = chatVersionSchema.extend({ memberId: uuidSchema.transform((v) => v.toLowerCase()), allowOffline: z.boolean().default(false) }).strict();
export const chatSettingsSchema = chatVersionSchema.extend({ capacity: z.number().int().min(1).max(10) }).strict();
export const chatReadSchema = z.object({ sequence: z.number().int().nonnegative().max(2147483647) }).strict();
export const chatEndSchema = chatVersionSchema.extend({ lastSequence: z.number().int().nonnegative().max(2147483647) }).strict();
export const chatWaitingSchema = chatEndSchema.extend({ waiting: z.boolean() }).strict();
export const chatLeaveSchema = z.object({ roundVersions: z.array(chatVersionSchema.extend({ id: uuidSchema }).strict()).max(100) }).strict();
export const chatCloseSchema = chatVersionSchema.extend({ resolution: z.string().trim().min(1).max(1000).refine((v) => !v.includes('\0'), '处理摘要包含无效字符') }).strict();
export const chatMessagesQuerySchema = z.object({
  before: z.coerce.number().int().positive().max(2147483647).optional(), after: z.coerce.number().int().nonnegative().max(2147483647).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30), roundId: uuidSchema.optional(),
}).strict().refine((v) => v.before === undefined || v.after === undefined, '不能同时使用前后游标');
export const chatListSchema = paginationSchema.strict();
export const chatInboxSchema = paginationSchema.extend({ view: z.enum(['waiting', 'mine', 'closed', 'all']).default('waiting') }).strict();
export interface ChatPersonDto { username: string; displayName: string }
export interface ChatRoundDto {
  id: string; channelId: string; status: 'agent' | 'waiting_seller' | 'seller' | 'closed'; version: string;
  createdAt: string; endedAt: string | null; assignedSeller: ChatPersonDto | null; canReply: boolean; canManage: boolean;
  waitingBuyerSince: string | null; offlineSince: string | null; needsHandoff: boolean;
  canReadHistory: boolean;
  agentRun?: { status: import('./agent.ts').AgentRunStatus; mode: 'mock' | 'deepseek' | 'disabled' } | null;
}
export interface ChatChannelDto {
  id: string; shopId: string; shopName: string; buyer: ChatPersonDto; latestSequence: number; lastMessageAt: string | null; activeRound: ChatRoundDto | null;
}
export interface ChatMessageDto {
  id: string; channelId: string; roundId: string; sequence: number; createdAt: string;
  senderType: 'buyer' | 'seller' | 'agent' | 'system'; sender: ChatPersonDto | null; content: string;
  product: ChatProductDto | null;
  productCards?: import('./agent.ts').AgentCardDto[];
}
export const chatProductSnapshotSchema = z.object({ id: uuidSchema, name: z.string(), imageUrl: z.string().nullable(), skuId: uuidSchema.nullable(), skuName: z.string().nullable() }).strict();
export type ChatProductDto = z.infer<typeof chatProductSnapshotSchema>;
export interface ChatMessagesDto {
  items: ChatMessageDto[]; hasMore: boolean; nextCursor: number | null;
}

export interface ChatRoundDetailsDto { round: ChatRoundDto; channel: ChatChannelDto; unreadCount?: number; assignmentUnread?: boolean }
export interface ChatAgentDto extends ChatPersonDto { memberId: string; role: 'owner' | 'manager' | 'staff'; online: boolean; activeCount: number; capacity: number }
export interface ChatSettingsDto { capacity: number; version: string; canEdit: boolean }
export interface ChatNotificationDto { roundId: string; channelId: string; buyer: ChatPersonDto; unreadCount: number; assignmentUnread: boolean; latestSequence: number }
export interface ChatNotificationsDto { items: ChatNotificationDto[]; unreadCount: number; conversationCount: number }
export interface ChatShopDto { shopId: string; shopName: string; channel: ChatChannelDto | null }

export const chatAvailabilitySchema = z.object({ available: z.boolean() }).strict();
export const chatHeartbeatSchema = z.object({}).strict();
export interface ChatAvailabilityDto { available: boolean; activeCount: number; capacity: number; expiresAt: string | null }
export interface ChatReceptionContextDto {
  version: string; lastSequence: number; requirements: string[]; unresolved: string[]; memoryBehind: boolean;
  handoff: { reason: string; question: string; note: string | null } | null;
  recentQuestions: { sequence: number; content: string }[]; products: ChatProductDto[]; canSuggest: boolean;
}
export const chatSuggestionSchema = chatEndSchema.extend({ requestId: uuidSchema.optional() }).strict();
export const chatSuggestionOutputSchema = z.object({ content: z.string().trim().min(1).max(3000).refine(v => !v.includes('\0')) }).strict();
export interface ChatSuggestionDto { id: string; content: string; version: string; lastSequence: number; expiresAt: string }
export type ChatProgressPhase = 'queued' | 'processing' | 'understanding' | 'filters' | 'searching' | 'details' | 'composing' | 'checking';
export interface ChatProgressDto {
  kind: 'guide' | 'suggestion'; phase: ChatProgressPhase; startedAt: string;
  lastAction?: 'filters' | 'searching' | 'details'; requestId?: string;
}
// A fresh authorized snapshot on every connection. Durable messages remain in
// the cursor API; event ids are deliberately not used as durable message cursors.
export interface ChatLiveDto {
  channelId: string | null; latestSequence: number; round: ChatRoundDto | null;
  progress: ChatProgressDto | null;
}

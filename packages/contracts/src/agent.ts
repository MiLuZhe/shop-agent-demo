import { z } from 'zod';
import { moneySchema, uuidSchema } from './common.ts';
import { attributeFilterSchema } from './product-filters.ts';
import { requirementChangesSchema } from './agent-memory.ts';

const id = uuidSchema.transform((v) => v.toLowerCase());
export const agentLookupSchema = z.object({ q: z.string().trim().max(100).optional(), page: z.number().int().min(1).max(10000).default(1), pageSize: z.number().int().min(1).max(20).default(10) }).strict();
export const agentSearchSchema = agentLookupSchema.extend({
  pageSize: z.number().int().min(1).max(10).default(6), categoryId: id.optional(), tagIds: z.array(id).max(10).default([]), tagMode: z.enum(['all', 'any']).default('all'),
  minPrice: moneySchema.optional(), maxPrice: moneySchema.optional(), inStock: z.boolean().default(true), attributes: z.array(attributeFilterSchema).max(10).default([]),
  // Only the guide runtime can authorize a single expansion after an empty
  // original search. These are search terms, never product IDs or hard filters.
  relatedTerms: z.array(z.string().trim().min(2).max(40)).min(1).max(3).optional(),
}).strict();
// One shared SKU page per product, with optional explicit SKU selection. Every
// selected SKU must belong to one of the requested, visible products.
export const agentDetailsSchema = z.object({ ids: z.array(id).min(1).max(5), skuIds: z.array(id).min(1).max(10).optional(), skuPage: z.number().int().min(1).max(10000).default(1), skuPageSize: z.number().int().min(1).max(10).default(5) }).strict();
export const agentHandoffSchema = z.object({ reason: z.enum(['user_request', 'missing_info', 'agent_failure', 'unresolved']), question: z.string().trim().min(1).max(1000), summary: z.string().trim().max(800).optional() }).strict();
export const agentToolSchemas = { listCategories: agentLookupSchema, listTags: agentLookupSchema, getFilters: agentLookupSchema, searchProducts: agentSearchSchema, getProductDetails: agentDetailsSchema, handoffToSeller: agentHandoffSchema };
export type AgentToolName = keyof typeof agentToolSchemas;
// Short references are minted by one catalogue instance and resolved back to a
// verified UUID before a card or requirement cache can be written.
const candidateId = z.union([id, z.string().regex(/^sku_[1-9]\d{0,2}$/)]);
export const agentResultSchema = z.object({ content: z.string().trim().min(1).max(4000), candidates: z.array(z.object({ skuId: candidateId, reason: z.string().trim().max(200) }).strict()).max(6).default([]), requirementChanges: requirementChangesSchema.default([]) }).strict();
export const agentRequirementProposalSchema = agentResultSchema.pick({ requirementChanges: true }).required();
export const agentReplySchema = agentResultSchema.omit({ requirementChanges: true }).required();
export const agentCardSchema = z.object({ productId: id, skuId: id, name: z.string(), skuName: z.string(), price: moneySchema, imageUrl: z.string().nullable(), reason: z.string().max(200) }).strict();
export type AgentCardDto = z.infer<typeof agentCardSchema>;
export type AgentRunStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

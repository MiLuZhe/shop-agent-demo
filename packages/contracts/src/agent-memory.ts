import { z } from 'zod';
import { moneySchema, uuidSchema } from './common.ts';
import { attributeFilterSchema } from './product-filters.ts';

const id = uuidSchema.transform(value => value.toLowerCase());
const sequence = z.number().int().min(1);
export const requirementSourceSchema = z.object({ sequence, quote: z.string().trim().min(1).max(160) }).strict();
const dimension = z.string().regex(/^[a-z][a-z0-9_.:-]{0,99}$/);
export const requirementValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('budget'), min: moneySchema.nullable(), max: moneySchema.nullable() }).strict()
    .refine(value => value.min !== null || value.max !== null, '预算至少需要一个边界'),
  z.object({ kind: z.literal('quantity'), value: z.number().int().min(1).max(9999) }).strict(),
  z.object({ kind: z.literal('keyword'), value: z.string().trim().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('category'), categoryId: id }).strict(),
  z.object({ kind: z.literal('tag'), tagId: id }).strict(),
  z.object({ kind: z.literal('attribute'), filter: attributeFilterSchema }).strict(),
  // Natural-language conditions stay visible even when no catalog filter exists.
  // They must never be silently interpreted as satisfied by a recommendation.
  z.object({ kind: z.literal('text'), dimension: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), value: z.string().trim().min(1).max(160), excluded: z.boolean() }).strict(),
]);
export const requirementConstraintSchema = z.object({
  key: dimension, scope: z.enum(['global', 'product']), level: z.enum(['hard', 'preference', 'unconfirmed']),
  value: requirementValueSchema, source: requirementSourceSchema,
}).strict();
export const requirementChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('reset'), source: requirementSourceSchema }).strict(),
  z.object({ op: z.literal('set'), constraint: requirementConstraintSchema }).strict(),
  z.object({ op: z.literal('remove'), key: dimension, source: requirementSourceSchema }).strict(),
  z.object({ op: z.literal('purpose'), value: z.string().trim().min(1).max(160).nullable(), source: requirementSourceSchema }).strict(),
  z.object({ op: z.literal('product'), productId: id.nullable(), skuId: id.nullable(), source: requirementSourceSchema }).strict(),
  z.object({ op: z.literal('unresolved'), key: dimension, question: z.string().trim().min(1).max(200).nullable(), source: requirementSourceSchema }).strict(),
]);
export const requirementChangesSchema = z.array(requirementChangeSchema).max(40);
export const requirementStateSchema = z.object({
  schemaVersion: z.literal(2), revision: z.number().int().min(0), coveredBuyerSequence: z.number().int().min(0),
  resetThroughSequence: z.number().int().min(0),
  purpose: z.object({ value: z.string().trim().min(1).max(160), source: requirementSourceSchema }).strict().nullable(),
  productScope: z.object({ productId: id, skuId: id.nullable(), source: requirementSourceSchema }).strict().nullable(),
  constraints: z.array(requirementConstraintSchema).max(20),
  unresolved: z.array(z.object({ key: dimension, question: z.string().trim().min(1).max(200), source: requirementSourceSchema }).strict()).max(10),
  candidateSkuIds: z.array(id).max(10), candidateRevision: z.number().int().min(0),
  // A server-generated digest of active requirements, not a model-written history.
  summary: z.object({ kind: z.literal('requirements'), content: z.string().max(800), coveredThroughSequence: z.number().int().min(0), truncated: z.boolean() }).strict(),
}).strict();
export type RequirementSource = z.infer<typeof requirementSourceSchema>;
export type RequirementConstraint = z.infer<typeof requirementConstraintSchema>;
export type RequirementChange = z.infer<typeof requirementChangeSchema>;
export type RequirementState = z.infer<typeof requirementStateSchema>;

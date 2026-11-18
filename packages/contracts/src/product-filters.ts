import { z } from 'zod';
import { uuidSchema } from './common.ts';
const decimalSchema = z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/);
export const attributeFilterSchema = z.discriminatedUnion('type', [
  z.object({ attributeId: uuidSchema, type: z.literal('number'), op: z.enum(['eq', 'gte', 'lte']), value: decimalSchema }).strict(),
  z.object({ attributeId: uuidSchema, type: z.literal('text'), op: z.literal('eq'), value: z.string().trim().min(1).max(255) }).strict(),
  z.object({ attributeId: uuidSchema, type: z.literal('boolean'), op: z.literal('eq'), value: z.boolean() }).strict(),
]);

import { z } from 'zod';
import { paginationSchema } from './common.ts';
import type { ShopRole } from './identity.ts';
import { accountNameSchema } from './account.ts';

export const memberQuerySchema = paginationSchema.extend({ q: z.string().trim().max(50).optional() }).strict();
export const memberCreateSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(50),
  role: z.enum(['manager', 'staff']),
}).strict();
export const workAccountCreateSchema = z.object({
  username: accountNameSchema,
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(128).refine((value) => value.trim().length > 0),
  role: z.enum(['manager', 'staff']),
}).strict();
export const memberUpdateSchema = z.object({
  role: z.enum(['manager', 'staff']),
  status: z.enum(['active', 'disabled']),
  version: z.iso.datetime(),
}).strict();
export interface ShopMemberDto {
  id: string; username: string; displayName: string;
  role: ShopRole; status: 'active' | 'disabled'; userStatus: 'active' | 'disabled'; version: string;
}

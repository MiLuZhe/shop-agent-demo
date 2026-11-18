import { z } from 'zod';
export const accountNameSchema = z.string().trim().toLowerCase().min(3).max(50).regex(/^[a-z0-9_]+$/);
export const accountAvailabilitySchema = z.object({ username: accountNameSchema }).strict();
export const accountProfileSchema = z.object({ displayName: z.string().trim().min(1).max(80), version: z.iso.datetime() }).strict();
export const accountRenameSchema = z.object({ username: accountNameSchema, currentPassword: z.string().min(1).max(128), version: z.iso.datetime() }).strict();
export const accountPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128).refine((value) => value.trim().length > 0),
  confirmPassword: z.string().min(12).max(128),
  version: z.iso.datetime(),
}).strict().refine((value) => value.newPassword === value.confirmPassword, { message: '两次新密码不一致', path: ['confirmPassword'] })
  .refine((value) => value.newPassword !== value.currentPassword, { message: '新密码不能与当前密码相同', path: ['newPassword'] });
export interface AccountRenameDto { username: string; reauthenticate: boolean }

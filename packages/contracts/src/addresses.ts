import { z } from 'zod';

export const MAX_SAVED_ADDRESSES = 3;
export const recipientSchema = z.object({
  recipientName: z.string().trim().min(1).max(80),
  recipientPhone: z.string().trim().min(7).max(32).regex(/^\+?[0-9][0-9 ()-]*[0-9]$/).refine((value) => { const count = value.replace(/\D/g, '').length; return count >= 7 && count <= 15; }, '请填写有效联系电话'),
  recipientAddress: z.string().trim().min(5).max(500),
}).strict();
export const savedAddressUpdateSchema = recipientSchema.extend({ version: z.iso.datetime() }).strict();
export const savedAddressDeleteSchema = z.object({ version: z.iso.datetime() }).strict();
export type RecipientInput = z.infer<typeof recipientSchema>;
export interface SavedAddressDto extends RecipientInput { id: string; version: string }

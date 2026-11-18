import { z } from 'zod';
export const uuidSchema = z.uuid();
export const MAX_PRODUCT_IMAGES = 8;
export const moneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, '金额需要使用最多两位小数的非负字符串');
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

export const DEFAULT_SHOP_ID = '00000000-0000-4000-8000-000000000003';

import { z } from 'zod';
import type { PlatformRole } from './identity.ts';

import { uuidSchema, moneySchema, paginationSchema } from './common.ts';
export { uuidSchema, moneySchema, paginationSchema, DEFAULT_SHOP_ID, MAX_PRODUCT_IMAGES } from './common.ts';
import { attributeFilterSchema } from './product-filters.ts';
export { attributeFilterSchema } from './product-filters.ts';
const parseJson = z.string().max(4000).transform((raw, ctx) => {
  try { return JSON.parse(raw) as unknown; }
  catch { ctx.addIssue({ code: 'custom', message: '属性筛选必须是 JSON 数组' }); return z.NEVER; }
});
export const productQuerySchema = paginationSchema.extend({
  shopId: uuidSchema.optional(),
  q: z.string().trim().max(100).optional(),
  categoryId: uuidSchema.optional(),
  tagIds: z.string().max(800).transform((s) => s.split(',')).pipe(z.array(uuidSchema).min(1).max(10)).optional(),
  tagMode: z.enum(['all', 'any']).default('all'),
  minPrice: moneySchema.optional(),
  maxPrice: moneySchema.optional(),
  inStock: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  attributes: parseJson.pipe(z.array(attributeFilterSchema).max(10)).default([]),
}).strict();
export const lookupQuerySchema = paginationSchema.extend({ q: z.string().trim().max(100).optional() }).strict();
export const publicLookupQuerySchema = lookupQuerySchema.extend({ shopId: uuidSchema.optional() }).strict();
export const detailRequestSchema = z.object({ ids: z.array(uuidSchema).min(1).max(10) }).strict();
export type ProductQuery = z.infer<typeof productQuerySchema>;
export type AttributeFilter = z.infer<typeof attributeFilterSchema>;

export interface CategoryDto { id: string; name: string; description: string | null }
export interface TagDto { id: string; name: string; description: string | null; groupName: string | null }
export interface AttributeDefinitionDto {
  id: string; code: string; name: string; dataType: 'text' | 'number' | 'boolean' | 'enum';
  unit: string | null; options: string[] | null;
}
export interface AttributeValueDto extends AttributeDefinitionDto { value: string | boolean }
export interface SkuDto {
  id: string; skuCode: string; name: string; price: string; stockQuantity: number; attributeCount: number; attributes: AttributeValueDto[];
}
export interface ProductDto {
  id: string; shopId: string; shopName: string; name: string; description: string | null; imageUrls: string[];
  category: CategoryDto | null; tags: TagDto[]; skuCount: number; skus: SkuDto[];
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface ApiError { error: { code: string; message: string; requestId: string } }

export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(50),
  password: z.string().min(1).max(128),
}).strict();
export interface AuthUserDto { username: string; displayName: string; platformRole: PlatformRole; canManageShops: boolean; canShop: boolean }
export interface SessionDto { user: AuthUserDto | null; expiresAt: string | null }
export interface AccountDto { user: AuthUserDto; expiresAt: string; version: string; shopPositions: { shopId: string; shopName: string; role: import('./identity.ts').ShopRole }[] }
export interface SellerOverviewDto { productCount: number; activeProductCount: number; skuCount: number; activeCategoryCount: number; activeTagCount: number }

export * from './seller.ts';
export * from './cart.ts';
export * from './orders.ts';

export * from './identity.ts';
export * from './members.ts';
export * from './account.ts';
export * from './addresses.ts';
export * from './chat.ts';
export * from './agent.ts';
export * from './agent-memory.ts';

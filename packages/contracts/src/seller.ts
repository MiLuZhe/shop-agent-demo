import { z } from 'zod';
import { MAX_PRODUCT_IMAGES, moneySchema, paginationSchema, uuidSchema } from './common.ts';

const name = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().trim().max(max).nullable();
const sortOrder = z.number().int().min(-100000).max(100000);
export const versionSchema = z.object({ version: z.iso.datetime() }).strict();
export const categoryWriteSchema = z.object({ name: name(80), description: nullableText(2000), sortOrder, isActive: z.boolean() }).strict();
export const tagWriteSchema = categoryWriteSchema.extend({ groupName: nullableText(40) }).strict();
export const definitionWriteSchema = z.object({
  code: name(64).toLowerCase().regex(/^[a-z][a-z0-9_]*$/), name: name(80), dataType: z.enum(['text', 'number', 'boolean', 'enum']),
  unit: nullableText(24), options: z.array(name(255)).min(1).max(50).nullable(), isFilterable: z.boolean(), sortOrder,
}).strict().superRefine((v, ctx) => {
  if (v.dataType === 'enum' ? !v.options || new Set(v.options).size !== v.options.length : v.options !== null)
    ctx.addIssue({ code: 'custom', message: '枚举需要非空、不重复的选项，其他类型不设置选项' });
  if (v.dataType !== 'number' && v.unit) ctx.addIssue({ code: 'custom', message: '只有数值属性可以设置单位' });
});
const attributeValueSchema = z.object({ attributeId: uuidSchema, value: z.union([z.string().trim().min(1).max(255), z.boolean()]) }).strict();
const uniqueIds = <T extends { attributeId: string }>(rows: T[]) => new Set(rows.map((r) => r.attributeId)).size === rows.length;
export const skuWriteSchema = z.object({
  skuCode: name(64), name: name(120), price: moneySchema, stockQuantity: z.number().int().min(0).max(2147483647), isActive: z.boolean(),
  attributes: z.array(attributeValueSchema).max(20).refine(uniqueIds, '同一属性不能重复填写'),
}).strict();
const tagIds = z.array(uuidSchema).max(10).refine((ids) => new Set(ids).size === ids.length, '标签不能重复绑定');
export const productWriteSchema = z.object({
  name: name(160), description: nullableText(10000), categoryId: uuidSchema.nullable(), tagIds,
  imageUrls: z.array(z.union([
    z.url().max(2000).refine((url) => /^https?:\/\//i.test(url), '图片仅支持 HTTP(S) URL'),
    z.string().max(2000).regex(/^\/demo-media\/[a-z0-9-]+\.jpg$/, '本地演示图片路径无效'),
    z.string().regex(/^\/api\/uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/, '上传图片路径无效'),
  ])).max(8, '每个商品最多 8 张图片'),
  status: z.enum(['draft', 'active', 'inactive']),
}).strict();
export const productCreateSchema = productWriteSchema.extend({ defaultSku: skuWriteSchema });
export const sellerQuerySchema = paginationSchema.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['draft', 'active', 'inactive']).optional() }).strict();
export const mergeTagSchema = z.object({ targetId: uuidSchema, version: z.iso.datetime(), targetVersion: z.iso.datetime() }).strict();
export type CategoryWrite = z.infer<typeof categoryWriteSchema>;
export type TagWrite = z.infer<typeof tagWriteSchema>;
export type DefinitionWrite = z.infer<typeof definitionWriteSchema>;
export type SkuWrite = z.infer<typeof skuWriteSchema>;
export type ProductWrite = z.infer<typeof productWriteSchema>;
export interface SellerCategoryDto extends CategoryWrite { id: string; version: string; productCount: number }
export interface SellerTagDto extends TagWrite { id: string; version: string; productCount: number }
export interface SellerDefinitionDto extends DefinitionWrite { id: string; version: string; valueCount: number }
export interface SellerSkuDto extends SkuWrite { id: string; version: string; productId: string }
export interface SellerProductDto extends ProductWrite { id: string; shopId: string; version: string; skuCount: number }
export interface SellerProductDetailDto extends SellerProductDto { skus: SellerSkuDto[] }

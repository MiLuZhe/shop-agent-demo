import { z } from 'zod';
import { uuidSchema } from './common.ts';

export const cartQuantitySchema = z.number().int().min(1).max(999);
export const cartAddSchema = z.object({ skuId: uuidSchema, quantity: cartQuantitySchema }).strict();
export const cartUpdateSchema = z.object({ quantity: cartQuantitySchema, version: z.iso.datetime() }).strict();
export const cartDeleteSchema = z.object({ version: z.iso.datetime() }).strict();
export const cartPreviewSchema = z.object({ itemIds: z.array(uuidSchema).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, '条目不能重复') }).strict();
export interface CartItemDto {
  id: string; shopId: string; shopName: string; skuId: string; productId: string; productName: string; skuName: string; skuCode: string;
  quantity: number; price: string; subtotal: string; stockQuantity: number; version: string;
  available: boolean; reason: string | null;
}
export interface CartDto { items: CartItemDto[]; maxItems: number; maxQuantity: number }
export interface CartPreviewDto { items: CartItemDto[]; totalAmount: string; totalQuantity: number }
// Work in integer cents, including large cart totals, without floating point rounding.
export function sumCartMoney(items: { price: string; quantity: number }[]): string {
  const cents = items.reduce((sum, item) => {
    const [whole, fraction = ''] = item.price.split('.');
    return sum + (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))) * BigInt(item.quantity);
  }, 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

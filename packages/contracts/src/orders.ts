import { z } from 'zod';
import { moneySchema, paginationSchema, uuidSchema } from './common.ts';
import { cartQuantitySchema } from './cart.ts';
import { recipientSchema } from './addresses.ts';

export const orderStatusSchema = z.enum(['pending_payment', 'pending_shipment', 'shipped', 'cancelled']);
export const orderQuerySchema = paginationSchema.extend({ status: orderStatusSchema.optional() }).strict();
export const checkoutSchema = recipientSchema.extend({
  checkoutKey: uuidSchema,
  items: z.array(z.object({ cartItemId: uuidSchema.transform((id) => id.toLowerCase()), quantity: cartQuantitySchema, unitPrice: moneySchema, version: z.iso.datetime() }).strict()).min(1).max(100)
    .refine((items) => new Set(items.map((item) => item.cartItemId)).size === items.length, '结算条目不能重复'),
  buyerNote: z.string().trim().max(500).nullable().default(null),
}).strict();
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export const directCheckoutSchema = checkoutSchema.omit({ items: true }).extend({
  skuId: uuidSchema.transform((id) => id.toLowerCase()), quantity: cartQuantitySchema, unitPrice: moneySchema,
}).strict();
export type DirectCheckoutInput = z.infer<typeof directCheckoutSchema>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export interface OrderSummaryDto {
  id: string; shopId: string; shopName: string; orderNo: string; status: OrderStatus; totalAmount: string; createdAt: string;
  paidAt: string | null; cancelledAt: string | null; shippedAt: string | null;
}
export interface OrderItemDto { id: string; skuId: string; productName: string; skuName: string; skuCode: string; unitPrice: string; quantity: number; subtotal: string }
export interface OrderDetailDto extends OrderSummaryDto {
  recipientName: string; recipientPhone: string; recipientAddress: string; buyerNote: string | null;
  paymentMethod: string | null; items: OrderItemDto[];
}
export const orderStatusLabels: Record<OrderStatus, string> = { pending_payment: '待支付', pending_shipment: '待发货', shipped: '已发货', cancelled: '已取消' };

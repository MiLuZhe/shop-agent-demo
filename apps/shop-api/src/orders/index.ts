import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import { checkoutSchema, directCheckoutSchema, orderQuerySchema, uuidSchema, sumCartMoney, type CheckoutInput, type OrderStatus } from '@shop/contracts';
import { HttpError, requireBuyer, lockBuyerIdentity } from '../auth/index.ts';
import { requireShop, lockShopAuthority } from '../shops/access.ts';
import { lockBuyerCart, lockInventory, nextStamp } from '../transactions/locks.ts';

const include = { items: { orderBy: { id: 'asc' as const } } };
type LoadedOrder = Prisma.OrderGetPayload<{ include: typeof include }>;
const missing = () => new HttpError(404, 'NOT_FOUND', '订单不存在');
const conflict = (message: string) => new HttpError(409, 'ORDER_CONFLICT', message);
const summary = (row: Prisma.OrderGetPayload<object>) => ({ id: row.id, shopId: row.shop_id, shopName: row.shop_name, orderNo: row.order_no, status: row.status as OrderStatus, totalAmount: row.total_amount.toFixed(2), createdAt: row.created_at.toISOString(),
  paidAt: row.paid_at?.toISOString() ?? null, cancelledAt: row.cancelled_at?.toISOString() ?? null, shippedAt: row.shipped_at?.toISOString() ?? null });
function dto(row: LoadedOrder) {
  return { ...summary(row), recipientName: row.recipient_name, recipientPhone: row.recipient_phone, recipientAddress: row.recipient_address, buyerNote: row.buyer_note, paymentMethod: row.payment_method,
    items: row.items.map((item) => ({ id: item.id, skuId: item.sku_id, productName: item.product_name, skuName: item.sku_name, skuCode: item.sku_code, unitPrice: item.unit_price.toFixed(2), quantity: item.quantity,
      subtotal: sumCartMoney([{ price: item.unit_price.toFixed(2), quantity: item.quantity }]) })) };
}
function canonical(input: CheckoutInput) {
  return { items: input.items.map((item) => ({ ...item, unitPrice: new Prisma.Decimal(item.unitPrice).toFixed(2) })).sort((a, b) => a.cartItemId.localeCompare(b.cartItemId)),
    recipientName: input.recipientName, recipientPhone: input.recipientPhone, recipientAddress: input.recipientAddress, buyerNote: input.buyerNote || null };
}
async function transaction<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  try { return await db.$transaction(work, { maxWait: 10000, timeout: 15000 }); }
  catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2028'].includes(e.code)) throw conflict('其他操作正在处理订单，请使用原请求重试');
    throw e;
  }
}
export function registerOrders(app: FastifyInstance, db: PrismaClient) {
  async function list(query: unknown, buyerId?: string, shopId?: string) {
    const q = orderQuerySchema.parse(query), where = { ...(shopId ? { shop_id: shopId } : {}), ...(buyerId ? { buyer_id: buyerId } : {}), ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([db.order.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ created_at: 'desc' }, { id: 'asc' }] }), db.order.count({ where })]);
    return { items: rows.map(summary), total, page: q.page, pageSize: q.pageSize };
  }
  async function detail(id: string, buyerId?: string, shopId?: string) {
    const row = await db.order.findFirst({ where: { id, ...(shopId ? { shop_id: shopId } : {}), ...(buyerId ? { buyer_id: buyerId } : {}) }, include });
    if (!row) throw missing(); return dto(row);
  }
  app.register(async (buyer) => {
    buyer.addHook('preHandler', requireBuyer);
    buyer.get('/', (request) => list(request.query, request.identity!.userId));
    buyer.get('/:id', (request) => detail(uuidSchema.parse((request.params as { id: string }).id), request.identity!.userId));
    for (const source of ['cart', 'direct'] as const) buyer.post(source === 'cart' ? '/' : '/direct', async (request, reply) => {
      const cartInput = source === 'cart' ? checkoutSchema.parse(request.body) : undefined;
      const directInput = source === 'direct' ? directCheckoutSchema.parse(request.body) : undefined;
      const v = cartInput ?? directInput!;
      const payload = cartInput ? canonical(cartInput) : {
        source: 'direct', skuId: directInput!.skuId, quantity: directInput!.quantity,
        unitPrice: new Prisma.Decimal(directInput!.unitPrice).toFixed(2), recipientName: v.recipientName,
        recipientPhone: v.recipientPhone, recipientAddress: v.recipientAddress, buyerNote: v.buyerNote || null,
      };
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex'), buyerId = request.identity!.userId;
      const result = await transaction(db, async (tx) => {
        await lockBuyerIdentity(request, tx);
        await lockBuyerCart(tx, buyerId);
        const existing = await tx.order.findUnique({ where: { buyer_id_checkout_key: { buyer_id: buyerId, checkout_key: v.checkoutKey } }, include });
        // Check before reading the cart: a successful first request already cleared it.
        if (existing) {
          if (existing.checkout_payload_hash !== hash) throw conflict('同一提交标识对应的内容不同，请重新确认订单');
          return { row: existing, replay: true };
        }
        const ids = cartInput?.items.map((item) => item.cartItemId) ?? [];
        const cart = cartInput ? await tx.cartItem.findMany({ where: { id: { in: ids }, user_id: buyerId } }) : [];
        if (cart.length !== ids.length) throw conflict('所选购物车条目不存在或已变化，请重新确认');
        const submitted = directInput ? [{ skuId: directInput.skuId, quantity: directInput.quantity, unitPrice: directInput.unitPrice }] : cartInput!.items.map((line) => {
          const item = cart.find((item) => item.id === line.cartItemId)!;
          if (item.quantity !== line.quantity || item.updated_at.toISOString() !== line.version) throw conflict('购物车数量已变化，请重新确认');
          return { skuId: item.sku_id, quantity: line.quantity, unitPrice: line.unitPrice };
        });
        await lockInventory(tx, submitted.map((line) => line.skuId));
        const skus = await tx.sku.findMany({ where: { id: { in: submitted.map((line) => line.skuId) } }, include: { product: { include: { shop: true } } } });
        const lines = submitted.map((line) => {
          const sku = skus.find((sku) => sku.id === line.skuId);
          if (!sku || sku.product.status !== 'active' || sku.product.shop.status !== 'active' || !sku.is_active) throw conflict('商品已下架或规格已停用，请重新选择');
          if (sku.stock_quantity < line.quantity) throw conflict(`${sku.product.name}库存不足，请调整数量`);
          if (!sku.price.equals(line.unitPrice)) throw conflict('商品价格已变化，请重新查看清单并确认');
          return { sku, quantity: line.quantity, price: sku.price.toFixed(2) };
        });
        const shopIds = new Set(lines.map((line) => line.sku.product.shop_id));
        if (shopIds.size !== 1) throw conflict('一张订单只能包含一家店铺的商品，请按店铺分别结算');
        const shop = lines[0]!.sku.product.shop;
        const total = sumCartMoney(lines);
        if (new Prisma.Decimal(total).gt('9999999999.99')) throw conflict('订单金额超过上限，请减少商品数量');
        for (const line of lines) await tx.sku.update({ where: { id: line.sku.id }, data: { stock_quantity: { decrement: line.quantity }, updated_at: nextStamp(line.sku) } });
        for (const id of [...new Set(lines.map((line) => line.sku.product_id))]) {
          const product = lines.find((line) => line.sku.product_id === id)!.sku.product;
          await tx.product.update({ where: { id }, data: { updated_at: nextStamp(product) } });
        }
        const row = await tx.order.create({ data: { shop_id: shop.id, shop_name: shop.name, buyer_id: buyerId, checkout_key: v.checkoutKey, checkout_payload_hash: hash, order_no: `SW${randomUUID().replaceAll('-', '')}`,
          recipient_name: payload.recipientName, recipient_phone: payload.recipientPhone, recipient_address: payload.recipientAddress, buyer_note: payload.buyerNote, total_amount: total,
          items: { create: lines.map(({ sku, quantity }) => ({ sku_id: sku.id, product_name: sku.product.name, sku_name: sku.name, sku_code: sku.sku_code, unit_price: sku.price, quantity })) } }, include });
        if (cartInput) await tx.cartItem.deleteMany({ where: { id: { in: ids }, user_id: buyerId } });
        return { row, replay: false };
      });
      return reply.code(result.replay ? 200 : 201).send(dto(result.row));
    });
    for (const action of ['cancel', 'mock-pay'] as const) buyer.post(`/:id/${action}`, async (request) => {
      const id = uuidSchema.parse((request.params as { id: string }).id), buyerId = request.identity!.userId;
      return transaction(db, async (tx) => {
        await lockBuyerIdentity(request, tx);
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid AND buyer_id = ${buyerId}::uuid FOR UPDATE`;
        const row = await tx.order.findFirst({ where: { id, buyer_id: buyerId }, include });
        if (!row) throw missing();
        if (action === 'mock-pay') {
          if (['pending_shipment', 'shipped'].includes(row.status)) return dto(row);
          if (row.status !== 'pending_payment') throw conflict('只有待支付订单可以模拟支付');
          return dto(await tx.order.update({ where: { id }, data: { status: 'pending_shipment', payment_method: 'mock', paid_at: new Date(), updated_at: nextStamp(row) }, include }));
        }
        if (row.status === 'cancelled') return dto(row);
        if (row.status !== 'pending_payment') throw conflict('只有待支付订单可以取消');
        await lockInventory(tx, row.items.map((item) => item.sku_id));
        const skus = await tx.sku.findMany({ where: { id: { in: row.items.map((item) => item.sku_id) } }, include: { product: { include: { shop: true } } } });
        for (const item of row.items) {
          const sku = skus.find((sku) => sku.id === item.sku_id)!;
          if (sku.stock_quantity > 2147483647 - item.quantity) throw conflict('库存恢复超过上限，请联系卖家调整后再取消');
          await tx.sku.update({ where: { id: sku.id }, data: { stock_quantity: { increment: item.quantity }, updated_at: nextStamp(sku) } });
        }
        for (const id of [...new Set(skus.map((sku) => sku.product_id))]) {
          const product = skus.find((sku) => sku.product_id === id)!.product;
          await tx.product.update({ where: { id }, data: { updated_at: nextStamp(product) } });
        }
        return dto(await tx.order.update({ where: { id }, data: { status: 'cancelled', cancelled_at: new Date(), updated_at: nextStamp(row) }, include }));
      });
    });
  }, { prefix: '/api/orders' });
  app.register(async (seller) => {
    seller.addHook('preHandler', requireShop(db, 'orders:read'));
    seller.get('/', (request) => list(request.query, undefined, request.shopId!));
    seller.get('/:id', (request) => detail(uuidSchema.parse((request.params as { id: string }).id), undefined, request.shopId!));
    seller.post('/:id/ship', { preHandler: requireShop(db, 'orders:ship') }, async (request) => {
      const id = uuidSchema.parse((request.params as { id: string }).id), shopId = request.shopId!;
      return transaction(db, async (tx) => {
        await lockShopAuthority(tx, request, 'orders:ship');
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid AND shop_id = ${shopId}::uuid FOR UPDATE`;
        const row = await tx.order.findFirst({ where: { id, shop_id: shopId }, include }); if (!row) throw missing();
        if (row.status === 'shipped') return dto(row);
        if (row.status !== 'pending_shipment') throw conflict('只有待发货订单可以标记发货');
        return dto(await tx.order.update({ where: { id }, data: { status: 'shipped', shipped_at: new Date(), updated_at: nextStamp(row) }, include }));
      });
    });
  }, { prefix: '/api/seller/orders' });
}

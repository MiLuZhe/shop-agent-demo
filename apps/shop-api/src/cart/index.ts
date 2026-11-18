import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import { cartAddSchema, cartUpdateSchema, cartDeleteSchema, cartPreviewSchema, sumCartMoney, uuidSchema, type CartItemDto } from '@shop/contracts';
import { HttpError, requireBuyer, lockBuyerIdentity } from '../auth/index.ts';
import { lockBuyerCart } from '../transactions/locks.ts';

const include = { sku: { include: { product: { include: { shop: true } } } } };
type LoadedItem = Prisma.CartItemGetPayload<{ include: typeof include }>;
const notFound = () => new HttpError(404, 'NOT_FOUND', '购物车条目不存在，请刷新');
const conflict = (message: string) => new HttpError(409, 'CART_CONFLICT', message);
function reason(s: { is_active: boolean; stock_quantity: number; product: { status: string; shop: { status: string } } }, quantity: number) {
  if (s.product.shop.status !== 'active') return '店铺已停用';
  if (s.product.status !== 'active') return '商品已下架';
  if (!s.is_active) return '规格已停用';
  if (s.stock_quantity === 0) return '暂时缺货';
  if (quantity > s.stock_quantity) return `库存不足，当前剩余 ${s.stock_quantity} 件`;
  return null;
}
function dto(row: LoadedItem): CartItemDto {
  const s = row.sku, price = s.price.toFixed(2), invalid = reason(s, row.quantity);
  return { id: row.id, shopId: s.product.shop_id, shopName: s.product.shop.name, skuId: s.id, productId: s.product_id, productName: s.product.name, skuName: s.name, skuCode: s.sku_code,
    quantity: row.quantity, price, subtotal: sumCartMoney([{ price, quantity: row.quantity }]), stockQuantity: s.stock_quantity,
    version: row.updated_at.toISOString(), available: invalid === null, reason: invalid };
}
function version(row: { updated_at: Date }, submitted: string) {
  if (row.updated_at.toISOString() !== submitted) throw conflict('购物车已被修改，请刷新后重试');
}
export function registerCart(app: FastifyInstance, db: PrismaClient) {
  app.register(async (cart) => {
    cart.addHook('preHandler', requireBuyer);
    // Serialize one buyer's cart mutations. Lock order: buyer cart, product, SKU.
    // Cart does not reserve/decrement inventory; checkout must revalidate it.
    async function write<T>(request: FastifyRequest, work: (tx: Prisma.TransactionClient) => Promise<T>) {
      return db.$transaction(async (tx) => {
        await lockBuyerIdentity(request, tx);
        await lockBuyerCart(tx, request.identity!.userId);
        return work(tx);
      }, { maxWait: 10000, timeout: 15000 });
    }
    async function sellable(tx: Prisma.TransactionClient, skuId: string, quantity: number) {
      const found = await tx.sku.findUnique({ where: { id: skuId }, select: { product_id: true } });
      if (!found) throw new HttpError(404, 'NOT_FOUND', '规格不存在');
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${found.product_id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM skus WHERE id = ${skuId}::uuid FOR UPDATE`;
      const sku = await tx.sku.findUniqueOrThrow({ where: { id: skuId }, include: { product: { include: { shop: true } } } });
      const invalid = reason(sku, quantity);
      if (invalid) throw conflict(invalid);
    }
    cart.get('/', async (request) => {
      const rows = await db.cartItem.findMany({ where: { user_id: request.identity!.userId }, include, orderBy: [{ created_at: 'desc' }, { id: 'asc' }] });
      return { items: rows.map(dto), maxItems: 100, maxQuantity: 999 };
    });
    cart.post('/items', async (request, reply) => {
      const v = cartAddSchema.parse(request.body), userId = request.identity!.userId;
      const row = await write(request, async (tx) => {
        const old = await tx.cartItem.findUnique({ where: { user_id_sku_id: { user_id: userId, sku_id: v.skuId } } });
        const quantity = (old?.quantity ?? 0) + v.quantity;
        if (quantity > 999) throw conflict('同一规格最多加入 999 件');
        if (!old && await tx.cartItem.count({ where: { user_id: userId } }) >= 100) throw conflict('购物车最多保存 100 种规格，请先清理条目');
        await sellable(tx, v.skuId, quantity);
        return old ? tx.cartItem.update({ where: { id: old.id }, data: { quantity, updated_at: new Date(Math.max(Date.now(), old.updated_at.getTime() + 1)) }, include })
          : tx.cartItem.create({ data: { user_id: userId, sku_id: v.skuId, quantity }, include });
      });
      return reply.code(201).send(dto(row));
    });
    cart.put('/items/:id', async (request) => {
      const id = uuidSchema.parse((request.params as { id: string }).id), v = cartUpdateSchema.parse(request.body), userId = request.identity!.userId;
      return write(request, async (tx) => {
        const old = await tx.cartItem.findFirst({ where: { id, user_id: userId } });
        if (!old) throw notFound(); version(old, v.version);
        await sellable(tx, old.sku_id, v.quantity);
        return dto(await tx.cartItem.update({ where: { id }, data: { quantity: v.quantity, updated_at: new Date(Math.max(Date.now(), old.updated_at.getTime() + 1)) }, include }));
      });
    });
    cart.delete('/items/:id', async (request) => {
      const id = uuidSchema.parse((request.params as { id: string }).id), v = cartDeleteSchema.parse(request.body), userId = request.identity!.userId;
      return write(request, async (tx) => {
        const old = await tx.cartItem.findFirst({ where: { id, user_id: userId } });
        if (!old) throw notFound(); version(old, v.version);
        await tx.cartItem.delete({ where: { id } }); return { ok: true };
      });
    });
    cart.post('/preview', async (request) => {
      const v = cartPreviewSchema.parse(request.body);
      const rows = await db.cartItem.findMany({ where: { id: { in: v.itemIds }, user_id: request.identity!.userId }, include, orderBy: { id: 'asc' } });
      if (rows.length !== v.itemIds.length) throw notFound();
      const items = rows.map(dto), invalid = items.find((item) => !item.available);
      if (invalid) throw conflict(`${invalid.productName}：${invalid.reason}`);
      return { items, totalAmount: sumCartMoney(items), totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0) };
    });
  }, { prefix: '/api/cart' });
}

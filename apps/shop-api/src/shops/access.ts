import type { FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@shop/database';
import { DEFAULT_SHOP_ID, uuidSchema, hasShopPermission, type ShopPermission } from '@shop/contracts';
import { HttpError, requireUser, requireLiveIdentity } from '../auth/index.ts';
declare module 'fastify' { interface FastifyRequest { shopId: string | null } }
export function requireShop(db: PrismaClient, permission?: ShopPermission) {
  return async (request: FastifyRequest) => {
    await requireUser(request);
    const shopId = uuidSchema.parse(request.headers['x-shop-id'] ?? DEFAULT_SHOP_ID).toLowerCase();
    const member = await db.shopMember.findFirst({ where: { shop_id: shopId, user_id: request.identity!.userId, status: 'active', shop: { status: 'active' } } });
    if (!member) throw new HttpError(403, 'SHOP_FORBIDDEN', '你没有该店铺的管理权限，或店铺已停用');
    const needed = permission ?? (['GET','HEAD'].includes(request.method) ? 'catalog:read' : 'catalog:write');
    if (!hasShopPermission(member.role, needed)) throw new HttpError(403, 'SHOP_PERMISSION_DENIED', '你的店内角色无权执行此操作');
    request.shopId = shopId;
  };
}
export async function lockShopAuthority(tx: Prisma.TransactionClient, request: FastifyRequest, permission: ShopPermission) {
  await tx.$queryRaw`SELECT id FROM shops WHERE id=${request.shopId!}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM users WHERE id=${request.identity!.userId}::uuid FOR SHARE`;
  await requireLiveIdentity(request, tx);
  await tx.$queryRaw`SELECT id FROM shop_members WHERE shop_id=${request.shopId!}::uuid AND user_id=${request.identity!.userId}::uuid FOR SHARE`;
  const member = await tx.shopMember.findFirst({ where: { shop_id: request.shopId!, user_id: request.identity!.userId, status: 'active', shop: { status: 'active' } } });
  if (!member || !hasShopPermission(member.role, permission)) throw new HttpError(403, 'SHOP_PERMISSION_DENIED', '你的店内角色无权执行此操作');
}

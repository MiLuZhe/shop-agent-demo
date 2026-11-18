import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@shop/database';
import { requireUser } from '../auth/index.ts';
import { requireShop } from './access.ts';
import { registerMembers } from './members.ts';
export function registerShops(app: FastifyInstance, db: PrismaClient) {
  app.decorateRequest('shopId', null);
  registerMembers(app, db);
  app.get('/api/seller/shops', { preHandler: requireUser }, async (request) => {
    const members = await db.shopMember.findMany({ where: { user_id: request.identity!.userId, status: 'active', shop: { status: 'active' } }, include: { shop: true }, orderBy: { shop_id: 'asc' } });
    return { items: members.map((member) => ({ id: member.shop_id, name: member.shop.name, slug: member.shop.slug, role: member.role })) };
  });
  app.get('/api/seller/overview', { preHandler: requireShop(db) }, async (request) => {
    const shop_id = request.shopId!;
    const [productCount, activeProductCount, skuCount, activeCategoryCount, activeTagCount] = await Promise.all([
      db.product.count({ where: { shop_id } }), db.product.count({ where: { shop_id, status: 'active' } }), db.sku.count({ where: { product: { shop_id } } }),
      db.category.count({ where: { shop_id, is_active: true } }), db.tag.count({ where: { shop_id, is_active: true } }),
    ]);
    return { productCount, activeProductCount, skuCount, activeCategoryCount, activeTagCount };
  });
}

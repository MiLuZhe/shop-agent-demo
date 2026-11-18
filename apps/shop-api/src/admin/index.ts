import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@shop/database';
import { requirePlatformAdmin } from '../auth/index.ts';
export function registerAdmin(app: FastifyInstance, db: PrismaClient) {
  app.register(async (admin) => {
    admin.addHook('preHandler', requirePlatformAdmin);
    // Reserved maintenance capability: aggregate counts only, no customer data,
    // role grants, store takeover, order mutations or cross-store bypass.
    admin.get('/overview', async () => {
      const [userCount,shopCount,activeShopCount] = await Promise.all([db.user.count(),db.shop.count(),db.shop.count({where:{status:'active'}})]);
      return {userCount,shopCount,activeShopCount};
    });
  },{prefix:'/api/admin'});
}

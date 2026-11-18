import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@shop/database';
import { hasShopPermission, uuidSchema } from '@shop/contracts';
import { HttpError } from '../auth/index.ts';
import { requireShop, lockShopAuthority } from '../shops/access.ts';
import { createImageStore, imageFormat, imageTypes, legacyImagePattern, MAX_IMAGE_BYTES, newImageFilename, type ImageRead, type ImageStore } from './image-store.ts';

async function canReadImage(db: PrismaClient, request: FastifyRequest, shopId: string, url: string) {
  const member = request.identity && await db.shopMember.findFirst({ where: { shop_id: shopId, user_id: request.identity.userId, status: 'active', shop: { status: 'active' } } });
  if (member && hasShopPermission(member.role, 'catalog:read')) return true;
  if (await db.product.findFirst({ where: { shop_id: shopId, status: 'active', shop: { status: 'active' }, skus: { some: { is_active: true } }, image_urls: { array_contains: [url] } }, select: { id: true } })) return true;
  if (!request.identity?.user.canShop) return false;
  // Historical consultation pictures remain available to their original buyer.
  return !!await db.message.findFirst({ where: {
    channel: { shop_id: shopId, buyer_id: request.identity.userId },
    OR: [{ product_context: { path: ['imageUrl'], equals: url } }, { product_cards: { array_contains: [{ imageUrl: url }] } }],
  }, select: { id: true } });
}
function sendImage(reply: FastifyReply, result: ImageRead) {
  if ('redirect' in result) return reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').code(302).redirect(result.redirect);
  return reply.header('Cache-Control', 'private, no-store').type(result.contentType).send(result.bytes);
}
export function registerUploads(app: FastifyInstance, db: PrismaClient, store: ImageStore = createImageStore()) {
  for (const mime of Object.values(imageTypes)) app.addContentTypeParser(mime, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_request, body, done) => done(null, body));
  app.post('/api/seller/uploads', { preHandler: requireShop(db, 'catalog:write'), bodyLimit: MAX_IMAGE_BYTES }, async (request, reply) => {
    const bytes = request.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(400, 'INVALID_IMAGE', '请选择 JPG、PNG 或 WebP 图片');
    const ext = imageFormat(bytes);
    if (!ext || request.headers['content-type']?.split(';')[0] !== imageTypes[ext]) throw new HttpError(400, 'INVALID_IMAGE', '图片格式与内容不一致，仅支持 JPG、PNG、WebP');
    const shopId = request.shopId!, filename = newImageFilename(ext);
    await db.$transaction(tx => lockShopAuthority(tx, request, 'catalog:write'));
    // Do not hold database locks during cloud I/O; recheck before returning success.
    const stored = await store.put(shopId, filename, bytes, imageTypes[ext]);
    try { await db.$transaction(tx => lockShopAuthority(tx, request, 'catalog:write')); }
    catch (error) {
      try { await store.remove(shopId, filename, stored); }
      catch { request.log.error({ shopId, filename }, 'revoked upload cleanup failed'); }
      throw error;
    }
    return reply.code(201).send({ url: `/api/uploads/${shopId}/${filename}` });
  });
  app.get('/api/uploads/:shopId/:filename', { exposeHeadRoute: false }, async (request, reply) => {
    const { shopId, filename } = request.params as { shopId: string; filename: string };
    uuidSchema.parse(shopId);
    const match = /^([0-9a-f-]{36})\.(jpg|png|webp)$/.exec(filename);
    if (!match) throw new HttpError(404, 'NOT_FOUND', '图片不存在或无权查看');
    uuidSchema.parse(match[1]);
    if (!await canReadImage(db, request, shopId, `/api/uploads/${shopId}/${filename}`)) throw new HttpError(404, 'NOT_FOUND', '图片不存在或无权查看');
    return sendImage(reply, await store.read(shopId, filename));
  });
  // Keep the original demo URLs usable in immutable historical messages.
  app.get('/demo-media/:filename', { exposeHeadRoute: false }, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    if (!legacyImagePattern.test(filename)) throw new HttpError(404, 'NOT_FOUND', '图片不存在');
    return sendImage(reply, await store.readLegacy(filename));
  });
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import { hasShopPermission, memberCreateSchema, workAccountCreateSchema, memberQuerySchema, memberUpdateSchema, uuidSchema, type ShopMemberDto } from '@shop/contracts';
import { HttpError, requireLiveIdentity } from '../auth/index.ts';
import { nextStamp } from '../transactions/locks.ts';
import { requireShop } from './access.ts';

type LoadedMember = Prisma.ShopMemberGetPayload<{ include: { user: true } }>;
function dto(row: LoadedMember): ShopMemberDto {
  return { id: row.id, username: row.user.username, displayName: row.user.display_name,
    role: row.role as ShopMemberDto['role'], status: row.status as ShopMemberDto['status'],
    userStatus: row.user.status as ShopMemberDto['userStatus'], version: row.updated_at.toISOString() };
}
// All member writers use shop -> sorted users -> sorted members. Row locks also
// serialize direct DB revocations during this operation, then we recheck authority.
async function authorizeWrite(tx: Prisma.TransactionClient, request: FastifyRequest, targetUserId: string) {
  const shopId = request.shopId!, actorId = request.identity!.userId;
  await tx.$queryRaw`SELECT id FROM shops WHERE id = ${shopId}::uuid FOR UPDATE`;
  for (const id of [...new Set([actorId, targetUserId])].sort()) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR SHARE`;
  }
  await tx.$queryRaw`SELECT id FROM shop_members WHERE shop_id = ${shopId}::uuid AND user_id IN (${actorId}::uuid, ${targetUserId}::uuid) ORDER BY id FOR UPDATE`;
  await requireLiveIdentity(request, tx);
  const [shop, actor] = await Promise.all([
    tx.shop.findUnique({ where: { id: shopId } }),
    tx.shopMember.findUnique({ where: { shop_id_user_id: { shop_id: shopId, user_id: actorId } } }),
  ]);
  if (shop?.status !== 'active' || actor?.status !== 'active' || !hasShopPermission(actor.role, 'members:manage')) {
    throw new HttpError(403, 'SHOP_PERMISSION_DENIED', '你的店内角色无权执行此操作');
  }
}
function protectOwner(row: { role: string; user_id: string }, request: FastifyRequest) {
  if (row.role === 'owner' || row.user_id === request.identity!.userId) {
    throw new HttpError(403, 'OWNER_PROTECTED', '店长身份和自己的成员资格不能在此修改');
  }
}
export function registerMembers(app: FastifyInstance, db: PrismaClient) {
  const preHandler = requireShop(db, 'members:manage');
  app.get('/api/seller/members', { preHandler }, async (request) => {
    const q = memberQuerySchema.parse(request.query), shop_id = request.shopId!;
    const where: Prisma.ShopMemberWhereInput = { shop_id, ...(q.q ? { user: { OR: [
      { username: { contains: q.q, mode: 'insensitive' } }, { display_name: { contains: q.q, mode: 'insensitive' } },
    ] } } : {}) };
    const [rows, total] = await db.$transaction([
      db.shopMember.findMany({ where, include: { user: true }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      db.shopMember.count({ where }),
    ]);
    return { items: rows.map(dto), total, page: q.page, pageSize: q.pageSize };
  });
  app.post('/api/seller/members', { preHandler }, async (request, reply) => {
    const input = memberCreateSchema.parse(request.body);
    const row = await db.$transaction(async (tx) => {
      // Exact username lookup only, no global user listing or registration.
      const target = await tx.user.findUnique({ where: { username: input.username } });
      if (!target) throw new HttpError(404, 'USER_NOT_AVAILABLE', '账号不存在或不可加入店铺');
      await authorizeWrite(tx, request, target.id);
      const user = await tx.user.findUnique({ where: { id: target.id } });
      if (user?.status !== 'active' || !user.password_hash || user.username !== input.username) throw new HttpError(404, 'USER_NOT_AVAILABLE', '账号不存在或不可加入店铺');
      if (user.account_kind !== 'work') throw new HttpError(409, 'WORK_ACCOUNT_REQUIRED', '请使用独立的工作账号，不能将个人买家账号添加为店员');
      const existing = await tx.shopMember.findUnique({ where: { shop_id_user_id: { shop_id: request.shopId!, user_id: target.id } } });
      if (existing) throw new HttpError(409, 'MEMBER_EXISTS', '该账号已在成员列表中，请编辑或恢复现有成员');
      return tx.shopMember.create({ data: { shop_id: request.shopId!, user_id: target.id, role: input.role }, include: { user: true } });
    });
    request.log.info({ event: 'shop.member.created', actorId: request.identity!.userId, shopId: request.shopId, memberId: row.id, role: row.role }, 'shop membership changed');
    return reply.code(201).send(dto(row));
  });
  app.post('/api/seller/members/work-accounts', { preHandler }, async (request, reply) => {
    const input = workAccountCreateSchema.parse(request.body);
    const password_hash = await hashPassword(input.password);
    try {
      const row = await db.$transaction(async (tx) => {
        await authorizeWrite(tx, request, request.identity!.userId);
        const user = await tx.user.create({ data: { username: input.username, display_name: input.displayName, password_hash, account_kind: 'work' } });
        return tx.shopMember.create({ data: { shop_id: request.shopId!, user_id: user.id, role: input.role }, include: { user: true } });
      });
      request.log.info({ event: 'shop.work_account.created', actorId: request.identity!.userId, shopId: request.shopId, memberId: row.id, role: row.role }, 'work account created');
      return reply.code(201).send(dto(row));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new HttpError(409, 'ACCOUNT_NAME_TAKEN', '账号已被使用或保留，请更换账号');
      throw error;
    }
  });
  app.put('/api/seller/members/:id', { preHandler }, async (request) => {
    const id = uuidSchema.parse((request.params as { id: string }).id).toLowerCase();
    const input = memberUpdateSchema.parse(request.body);
    const change = await db.$transaction(async (tx) => {
      const initial = await tx.shopMember.findFirst({ where: { id, shop_id: request.shopId! } });
      if (!initial) throw new HttpError(404, 'MEMBER_NOT_FOUND', '成员不存在');
      await authorizeWrite(tx, request, initial.user_id);
      const row = await tx.shopMember.findFirst({ where: { id, shop_id: request.shopId! }, include: { user: true } });
      if (!row) throw new HttpError(404, 'MEMBER_NOT_FOUND', '成员不存在');
      protectOwner(row, request);
      if (row.updated_at.toISOString() !== input.version) throw new HttpError(409, 'MEMBER_CHANGED', '成员信息已更新，请重新加载后操作');
      if (input.status === 'active' && (row.user.status !== 'active' || !row.user.password_hash)) {
        throw new HttpError(409, 'USER_NOT_AVAILABLE', '账号不可用，无法启用店铺成员');
      }
      const updated = await tx.shopMember.update({ where: { id }, data: { role: input.role, status: input.status, updated_at: nextStamp(row) }, include: { user: true } });
      return { before: { role: row.role, status: row.status }, row: updated };
    });
    request.log.info({ event: 'shop.member.updated', actorId: request.identity!.userId, shopId: request.shopId, memberId: id, before: change.before, after: { role: change.row.role, status: change.row.status } }, 'shop membership changed');
    return dto(change.row);
  });
}

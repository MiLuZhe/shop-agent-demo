import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@shop/database';
import { MAX_SAVED_ADDRESSES, recipientSchema, savedAddressUpdateSchema, savedAddressDeleteSchema, uuidSchema, type SavedAddressDto } from '@shop/contracts';
import { HttpError, requireLiveBuyer, requireBuyer } from './index.ts';
import { nextStamp } from '../transactions/locks.ts';

function dto(row: { id: string; updated_at: Date; recipient_name: string; recipient_phone: string; recipient_address: string }): SavedAddressDto {
  return { id: row.id, version: row.updated_at.toISOString(), recipientName: row.recipient_name, recipientPhone: row.recipient_phone, recipientAddress: row.recipient_address };
}
async function lockUser(tx: Prisma.TransactionClient, request: FastifyRequest) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${request.identity!.userId}::uuid FOR UPDATE`;
  await requireLiveBuyer(request, tx);
}
export function registerAddresses(app: FastifyInstance, db: PrismaClient) {
  app.get('/api/account/addresses', { preHandler: requireBuyer }, async (request) => {
    const rows = await db.savedAddress.findMany({ where: { user_id: request.identity!.userId }, orderBy: { slot: 'asc' } });
    return { items: rows.map(dto), maxItems: MAX_SAVED_ADDRESSES };
  });
  app.post('/api/account/addresses', { preHandler: requireBuyer }, async (request, reply) => {
    const input = recipientSchema.parse(request.body);
    const data = { recipient_name: input.recipientName, recipient_phone: input.recipientPhone, recipient_address: input.recipientAddress };
    const result = await db.$transaction(async (tx) => {
      // Serialize all address writers by user, including concurrent additions to the last slot.
      await lockUser(tx, request);
      const rows = await tx.savedAddress.findMany({ where: { user_id: request.identity!.userId } });
      const existing = rows.find((row) => row.recipient_name === data.recipient_name && row.recipient_phone === data.recipient_phone && row.recipient_address === data.recipient_address);
      if (existing) return { row: existing, created: false };
      const slot = Array.from({ length: MAX_SAVED_ADDRESSES }, (_, i) => i + 1).find((value) => !rows.some((row) => row.slot === value));
      if (!slot) throw new HttpError(409, 'ADDRESS_LIMIT', '最多保存三个常用地址，请先在个人资料中编辑或删除已有地址');
      return { row: await tx.savedAddress.create({ data: { ...data, user_id: request.identity!.userId, slot } }), created: true };
    });
    return reply.code(result.created ? 201 : 200).send(dto(result.row));
  });
  for (const method of ['PUT', 'DELETE'] as const) app.route({
    method, url: '/api/account/addresses/:id', preHandler: requireBuyer,
    handler: async (request) => {
      const id = uuidSchema.parse((request.params as { id: string }).id).toLowerCase();
      const input = method === 'PUT' ? savedAddressUpdateSchema.parse(request.body) : savedAddressDeleteSchema.parse(request.body);
      const result = await db.$transaction(async (tx) => {
        await lockUser(tx, request);
        const row = await tx.savedAddress.findFirst({ where: { id, user_id: request.identity!.userId } });
        if (!row) throw new HttpError(404, 'ADDRESS_NOT_FOUND', '常用地址不存在');
        if (row.updated_at.toISOString() !== input.version) throw new HttpError(409, 'ADDRESS_CHANGED', '地址已更新，请刷新后重试');
        if (method === 'DELETE') { await tx.savedAddress.delete({ where: { id } }); return null; }
        const value = savedAddressUpdateSchema.parse(input);
        return tx.savedAddress.update({ where: { id }, data: { recipient_name: value.recipientName, recipient_phone: value.recipientPhone, recipient_address: value.recipientAddress, updated_at: nextStamp(row) } });
      });
      return result ? dto(result) : { deleted: true };
    },
  });
}

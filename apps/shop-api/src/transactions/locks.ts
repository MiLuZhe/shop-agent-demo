import type { Prisma } from '@shop/database';

export async function lockBuyerCart(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 7821))::text`;
}
export const nextStamp = (row: { updated_at: Date }) => new Date(Math.max(Date.now(), row.updated_at.getTime() + 1));
// Lock all products in ID order, then all SKUs in ID order. Management and cart
// lock product before SKU as well; no inventory writer may take these in reverse.
export async function lockInventory(tx: Prisma.TransactionClient, skuIds: string[]) {
  const skus = await tx.sku.findMany({ where: { id: { in: skuIds } }, select: { id: true, product_id: true } });
  for (const id of [...new Set(skus.map((sku) => sku.product_id))].sort()) await tx.$queryRaw`SELECT id FROM products WHERE id = ${id}::uuid FOR UPDATE`;
  for (const id of [...skuIds].sort()) await tx.$queryRaw`SELECT id FROM skus WHERE id = ${id}::uuid FOR UPDATE`;
}

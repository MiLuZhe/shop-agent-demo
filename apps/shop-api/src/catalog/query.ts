import { Prisma, type PrismaClient } from '@shop/database';
import { DEFAULT_SHOP_ID, type ProductQuery } from '@shop/contracts';
export class InputError extends Error {}

export async function productFilters(db: PrismaClient | Prisma.TransactionClient, q: ProductQuery) {
  if (q.minPrice && q.maxPrice && new Prisma.Decimal(q.minPrice).gt(q.maxPrice)) throw new InputError('最低价格不能高于最高价格');
  const shopId = q.shopId ?? DEFAULT_SHOP_ID;
  const attributeIds = [...new Set(q.attributes.map((a) => a.attributeId))];
  const definitions = await db.attributeDefinition.findMany({ where: { id: { in: attributeIds }, shop_id: shopId, is_filterable: true } });
  for (const filter of q.attributes) {
    const d = definitions.find((d) => d.id === filter.attributeId);
    if (!d || (d.data_type === 'enum' ? filter.type !== 'text' : d.data_type !== filter.type)) throw new InputError('属性不存在、未开放筛选或类型不匹配');
    if (d.data_type === 'enum' && (!Array.isArray(d.options) || !d.options.includes(filter.value as string))) throw new InputError('属性值不在枚举选项内');
  }
  const tagIds = [...new Set(q.tagIds ?? [])];
  if (tagIds.length && await db.tag.count({ where: { id: { in: tagIds }, shop_id: shopId, is_active: true } }) !== tagIds.length) throw new InputError('标签不存在或已停用');
  if (q.categoryId && !await db.category.findFirst({ where: { id: q.categoryId, shop_id: shopId, is_active: true } })) throw new InputError('分类不存在或已停用');
  const sku: Prisma.SkuWhereInput = {
    is_active: true,
    ...(q.inStock ? { stock_quantity: { gt: 0 } } : {}),
    price: { ...(q.minPrice ? { gte: q.minPrice } : {}), ...(q.maxPrice ? { lte: q.maxPrice } : {}) },
    AND: q.attributes.map((f) => ({ attribute_values: { some: {
      attribute_definition_id: f.attributeId,
      ...(f.type === 'number' ? { number_value: { [f.op === 'eq' ? 'equals' : f.op]: f.value } }
        : f.type === 'boolean' ? { boolean_value: f.value } : { text_value: f.value }),
    } } })),
  };
  const where: Prisma.ProductWhereInput = {
    status: 'active', shop_id: shopId, shop: { status: 'active' }, skus: { some: sku },
    ...(q.categoryId ? { category_id: q.categoryId } : {}),
    ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] } : {}),
    ...(tagIds.length ? q.tagMode === 'all'
      ? { AND: tagIds.map((tag_id) => ({ tags: { some: { tag_id } } })) }
      : { tags: { some: { tag_id: { in: tagIds } } } } : {}),
  };
  return { where, sku };
}


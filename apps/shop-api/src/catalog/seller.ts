import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import {
  categoryWriteSchema, tagWriteSchema, definitionWriteSchema, skuWriteSchema, productWriteSchema, productCreateSchema,
  sellerQuerySchema, lookupQuerySchema, mergeTagSchema, versionSchema, uuidSchema,
  type SkuWrite, type ProductWrite,
} from '@shop/contracts';
import { HttpError } from '../auth/index.ts';
import { requireShop, lockShopAuthority } from '../shops/access.ts';
import { assertImageOwnership } from './image-store.ts';

type Tx = Prisma.TransactionClient;
const missing = () => new HttpError(404, 'NOT_FOUND', '记录不存在，请刷新列表');
const conflict = (message: string) => new HttpError(409, 'CATALOG_CONFLICT', message);
const invalid = (message: string) => new HttpError(400, 'INVALID_INPUT', message);
function checkVersion(row: { updated_at: Date }, version: string) {
  if (row.updated_at.toISOString() !== version) throw conflict('数据已被修改，请重新加载后编辑');
}
const stamp = (row: { updated_at: Date }) => new Date(Math.max(Date.now(), row.updated_at.getTime() + 1));
const idOf = (params: unknown) => uuidSchema.parse((params as { id: string }).id);
const categoryDto = (c: Prisma.CategoryGetPayload<{ include: { _count: { select: { products: true } } } }>) => ({
  id: c.id, name: c.name, description: c.description, sortOrder: c.sort_order, isActive: c.is_active, version: c.updated_at.toISOString(), productCount: c._count.products,
});
const tagDto = (t: Prisma.TagGetPayload<{ include: { _count: { select: { products: true } } } }>) => ({
  id: t.id, name: t.name, description: t.description, groupName: t.group_name, sortOrder: t.sort_order, isActive: t.is_active, version: t.updated_at.toISOString(), productCount: t._count.products,
});
const definitionDto = (d: Prisma.AttributeDefinitionGetPayload<{ include: { _count: { select: { values: true } } } }>) => ({
  id: d.id, code: d.code, name: d.name, dataType: d.data_type, unit: d.unit, options: d.options, isFilterable: d.is_filterable, sortOrder: d.sort_order, version: d.updated_at.toISOString(), valueCount: d._count.values,
});
const skuInclude = { attribute_values: { orderBy: { attribute_definition_id: 'asc' as const } } };
const productInclude = { tags: { orderBy: { tag_id: 'asc' as const } }, _count: { select: { skus: true } } };
const skuDto = (s: Prisma.SkuGetPayload<{ include: typeof skuInclude }>) => ({
  id: s.id, productId: s.product_id, skuCode: s.sku_code, name: s.name, price: s.price.toFixed(2), stockQuantity: s.stock_quantity, isActive: s.is_active, version: s.updated_at.toISOString(),
  attributes: s.attribute_values.map((v) => ({ attributeId: v.attribute_definition_id, value: v.text_value ?? v.number_value?.toString() ?? v.boolean_value! })),
});
const productDto = (p: Prisma.ProductGetPayload<{ include: typeof productInclude }>) => ({
  id: p.id, shopId: p.shop_id, name: p.name, description: p.description, categoryId: p.category_id, imageUrls: p.image_urls, status: p.status,
  tagIds: p.tags.map((t) => t.tag_id), skuCount: p._count.skus, version: p.updated_at.toISOString(),
});
async function detail(tx: Tx, id: string, shopId: string) {
  const row = await tx.product.findFirst({ where: { id, shop_id: shopId }, include: { ...productInclude, skus: { include: skuInclude, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] } } });
  if (!row) throw missing();
  return { ...productDto(row), skus: row.skus.map(skuDto) };
}
// One short transaction per management write. All management writes share this lock,
// including definition/value and tag merge/binding, to prevent cross-table write skew.
// Product/SKU row locks are also taken for coordination with the later order flow.
export async function catalogWrite<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(73190421)::text`;
      return work(tx);
    }, { maxWait: 10000, timeout: 15000 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') throw conflict('名称或货号已存在，请更换后重试');
      if (e.code === 'P2003') throw conflict('记录仍被引用，不能删除');
      if (e.code === 'P2025') throw missing();
      if (['P2034', 'P2028'].includes(e.code)) throw conflict('其他操作正在修改数据，请重新加载后重试');
    }
    throw e;
  }
}
async function lockProduct(tx: Tx, id: string, shopId: string) {
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${id}::uuid AND shop_id = ${shopId}::uuid FOR UPDATE`;
  const p = await tx.product.findFirst({ where: { id, shop_id: shopId } });
  if (!p) throw missing();
  return p;
}
async function references(tx: Tx, input: ProductWrite, shopId: string, previous?: { category_id: string | null; tagIds: string[] }) {
  if (input.categoryId && input.categoryId !== previous?.category_id) {
    if (!await tx.category.findFirst({ where: { id: input.categoryId, shop_id: shopId, is_active: true } })) throw invalid('分类不存在或已停用，不能新分配');
  }
  const added = input.tagIds.filter((id) => !previous?.tagIds.includes(id));
  if (added.length && await tx.tag.count({ where: { id: { in: added }, shop_id: shopId, is_active: true } }) !== added.length) throw invalid('标签不存在或已停用，不能新绑定');
}
async function attributeData(tx: Tx, input: SkuWrite, shopId: string) {
  const definitions = await tx.attributeDefinition.findMany({ where: { id: { in: input.attributes.map((a) => a.attributeId) }, shop_id: shopId } });
  return input.attributes.map(({ attributeId, value }) => {
    const d = definitions.find((d) => d.id === attributeId);
    if (!d) throw invalid('属性定义不存在');
    const base = { attribute_definition_id: attributeId, text_value: null as string | null, number_value: null as Prisma.Decimal | null, boolean_value: null as boolean | null };
    if (d.data_type === 'boolean') {
      if (typeof value !== 'boolean') throw invalid(`${d.name}需要填写是或否`);
      return { ...base, boolean_value: value };
    }
    if (typeof value !== 'string') throw invalid(`${d.name}的值类型不正确`);
    if (d.data_type === 'number') {
      if (!/^-?\d{1,14}(\.\d{1,4})?$/.test(value)) throw invalid(`${d.name}需要最多 14 位整数、4 位小数的十进制数值`);
      return { ...base, number_value: new Prisma.Decimal(value) };
    }
    if (d.data_type === 'enum' && (!Array.isArray(d.options) || !d.options.includes(value))) throw invalid(`${d.name}的值不在选项内`);
    return { ...base, text_value: value };
  });
}
const productData = (v: ProductWrite) => ({ name: v.name, description: v.description, category_id: v.categoryId, image_urls: v.imageUrls, status: v.status });
const skuData = (v: SkuWrite) => ({ name: v.name, sku_code: v.skuCode, price: v.price, stock_quantity: v.stockQuantity, is_active: v.isActive });

export function registerSeller(app: FastifyInstance, db: PrismaClient) {
  app.register(async (seller) => {
    seller.addHook('preHandler', requireShop(db));
    seller.get('/categories', async (request) => {
      const q = lookupQuerySchema.parse(request.query);
      const where = { shop_id: request.shopId!, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
      const [rows, total] = await Promise.all([db.category.findMany({ where, include: { _count: { select: { products: true } } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }), db.category.count({ where })]);
      return { items: rows.map(categoryDto), total, page: q.page, pageSize: q.pageSize };
    });
    seller.post('/categories', async (request, reply) => {
      const v = categoryWriteSchema.parse(request.body);
      const result = await catalogWrite(db, async (tx) => { await lockShopAuthority(tx, request, 'catalog:write'); return categoryDto(await tx.category.create({ data: { shop_id: request.shopId!, name: v.name, description: v.description, sort_order: v.sortOrder, is_active: v.isActive }, include: { _count: { select: { products: true } } } })); });
      return reply.code(201).send(result);
    });
    seller.put('/categories/:id', async (request) => {
      const id = idOf(request.params), v = categoryWriteSchema.extend(versionSchema.shape).parse(request.body);
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const old = await tx.category.findFirst({ where: { id, shop_id: request.shopId! } });
        if (!old) throw missing(); checkVersion(old, v.version);
        return categoryDto(await tx.category.update({ where: { id }, data: { shop_id: request.shopId!, name: v.name, description: v.description, sort_order: v.sortOrder, is_active: v.isActive, updated_at: stamp(old) }, include: { _count: { select: { products: true } } } }));
      });
    });
    seller.delete('/categories/:id', async (request) => {
      const id = idOf(request.params), v = versionSchema.parse(request.body);
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const old = await tx.category.findFirst({ where: { id, shop_id: request.shopId! } });
        if (!old) throw missing(); checkVersion(old, v.version);
        if (await tx.product.count({ where: { category_id: id } })) throw conflict('分类仍有商品引用，请先调整商品分类');
        await tx.category.delete({ where: { id } }); return { ok: true };
      });
    });
    seller.get('/tags', async (request) => {
      const q = lookupQuerySchema.parse(request.query);
      const where = { shop_id: request.shopId!, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
      const [rows, total] = await Promise.all([db.tag.findMany({ where, include: { _count: { select: { products: true } } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }), db.tag.count({ where })]);
      return { items: rows.map(tagDto), total, page: q.page, pageSize: q.pageSize };
    });
    seller.post('/tags', async (request, reply) => {
      const v = tagWriteSchema.parse(request.body);
      const result = await catalogWrite(db, async (tx) => { await lockShopAuthority(tx, request, 'catalog:write'); return tagDto(await tx.tag.create({ data: { shop_id: request.shopId!, name: v.name, description: v.description, group_name: v.groupName, sort_order: v.sortOrder, is_active: v.isActive }, include: { _count: { select: { products: true } } } })); });
      return reply.code(201).send(result);
    });
    seller.put('/tags/:id', async (request) => {
      const id = idOf(request.params), v = tagWriteSchema.extend(versionSchema.shape).parse(request.body);
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const old = await tx.tag.findFirst({ where: { id, shop_id: request.shopId! } }); if (!old) throw missing(); checkVersion(old, v.version);
        return tagDto(await tx.tag.update({ where: { id }, data: { shop_id: request.shopId!, name: v.name, description: v.description, group_name: v.groupName, sort_order: v.sortOrder, is_active: v.isActive, updated_at: stamp(old) }, include: { _count: { select: { products: true } } } }));
      });
    });
    seller.post('/tags/:id/merge', async (request) => {
      const id = idOf(request.params), v = mergeTagSchema.parse(request.body);
      if (id === v.targetId) throw invalid('来源和目标标签不能相同');
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const source = await tx.tag.findFirst({ where: { id, shop_id: request.shopId! } }), target = await tx.tag.findFirst({ where: { id: v.targetId, shop_id: request.shopId! } });
        if (!source || !target) throw missing(); checkVersion(source, v.version); checkVersion(target, v.targetVersion);
        if (!target.is_active) throw conflict('只能合并到启用的标签');
        const bindings = await tx.productTag.findMany({ where: { tag_id: id }, orderBy: { product_id: 'asc' } });
        for (const b of bindings) {
          await lockProduct(tx, b.product_id, request.shopId!);
          await tx.productTag.upsert({ where: { product_id_tag_id: { product_id: b.product_id, tag_id: target.id } }, create: { product_id: b.product_id, tag_id: target.id }, update: {} });
          const p = await tx.product.findUniqueOrThrow({ where: { id: b.product_id } });
          await tx.product.update({ where: { id: p.id }, data: { updated_at: stamp(p) } });
        }
        await tx.productTag.deleteMany({ where: { tag_id: id } });
        await tx.tag.update({ where: { id }, data: { is_active: false, updated_at: stamp(source) } });
        await tx.tag.update({ where: { id: target.id }, data: { updated_at: stamp(target) } });
        return { ok: true, movedProductCount: bindings.length };
      });
    });
    seller.delete('/tags/:id', async (request) => {
      const id = idOf(request.params), v = versionSchema.parse(request.body);
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const row = await tx.tag.findFirst({ where: { id, shop_id: request.shopId! } }); if (!row) throw missing(); checkVersion(row, v.version);
        if (await tx.productTag.count({ where: { tag_id: id } })) throw conflict('标签仍有商品绑定，请先解除关联或合并');
        await tx.tag.delete({ where: { id } }); return { ok: true };
      });
    });
    seller.get('/attributes', async (request) => {
      const q = lookupQuerySchema.parse(request.query);
      const where = { shop_id: request.shopId!, ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' as const } }, { code: { contains: q.q, mode: 'insensitive' as const } }] } : {}) };
      const [rows, total] = await Promise.all([db.attributeDefinition.findMany({ where, include: { _count: { select: { values: true } } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }), db.attributeDefinition.count({ where })]);
      return { items: rows.map(definitionDto), total, page: q.page, pageSize: q.pageSize };
    });
    seller.post('/attributes', async (request, reply) => {
      const v = definitionWriteSchema.parse(request.body);
      const result = await catalogWrite(db, async (tx) => { await lockShopAuthority(tx, request, 'catalog:write'); return definitionDto(await tx.attributeDefinition.create({ data: { shop_id: request.shopId!, code: v.code, name: v.name, data_type: v.dataType, unit: v.unit || null, options: v.options ?? Prisma.DbNull, is_filterable: v.isFilterable, sort_order: v.sortOrder }, include: { _count: { select: { values: true } } } })); });
      return reply.code(201).send(result);
    });
    seller.put('/attributes/:id', async (request) => {
      const id = idOf(request.params), v = definitionWriteSchema.safeExtend(versionSchema.shape).parse(request.body);
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const old = await tx.attributeDefinition.findFirst({ where: { id, shop_id: request.shopId! } }); if (!old) throw missing(); checkVersion(old, v.version);
        if (v.code !== old.code) throw conflict('属性编码创建后保持稳定，不能修改');
        if (await tx.skuAttributeValue.count({ where: { attribute_definition_id: id } })) {
          if (old.data_type !== v.dataType || old.unit !== (v.unit || null)) throw conflict('属性已有值，不能直接修改类型或单位');
          if (v.dataType === 'enum') {
            const used = await tx.skuAttributeValue.findMany({ where: { attribute_definition_id: id }, select: { text_value: true }, distinct: ['text_value'] });
            if (used.some((a) => !v.options?.includes(a.text_value!))) throw conflict('不能删除仍在使用的枚举选项');
          }
        }
        return definitionDto(await tx.attributeDefinition.update({ where: { id }, data: { name: v.name, data_type: v.dataType, unit: v.unit || null, options: v.options ?? Prisma.DbNull, is_filterable: v.isFilterable, sort_order: v.sortOrder, updated_at: stamp(old) }, include: { _count: { select: { values: true } } } }));
      });
    });
    seller.delete('/attributes/:id', async (request) => {
      const id = idOf(request.params), v = versionSchema.parse(request.body);
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const row = await tx.attributeDefinition.findFirst({ where: { id, shop_id: request.shopId! } }); if (!row) throw missing(); checkVersion(row, v.version);
        if (await tx.skuAttributeValue.count({ where: { attribute_definition_id: id } })) throw conflict('属性仍有规格值引用，不能删除');
        await tx.attributeDefinition.delete({ where: { id } }); return { ok: true };
      });
    });
    seller.get('/products', async (request) => {
      const q = sellerQuerySchema.parse(request.query);
      const where = { shop_id: request.shopId!, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}), ...(q.status ? { status: q.status } : {}) };
      const [rows, total] = await Promise.all([db.product.findMany({ where, include: productInclude, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ created_at: 'desc' }, { id: 'asc' }] }), db.product.count({ where })]);
      return { items: rows.map(productDto), total, page: q.page, pageSize: q.pageSize };
    });
    seller.get('/products/:id', async (request) => detail(db, idOf(request.params), request.shopId!));
    seller.post('/products', async (request, reply) => {
      const v = productCreateSchema.parse(request.body);
      assertImageOwnership(v.imageUrls, request.shopId!);
      const result = await catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        await references(tx, v, request.shopId!);
        if (!v.defaultSku.isActive) throw invalid('新商品的默认规格必须启用');
        const values = await attributeData(tx, v.defaultSku, request.shopId!);
        const p = await tx.product.create({ data: { shop_id: request.shopId!, ...productData(v), tags: { create: v.tagIds.map((tag_id) => ({ tag_id })) }, skus: { create: { ...skuData(v.defaultSku), attribute_values: { create: values } } } } });
        return detail(tx, p.id, request.shopId!);
      });
      return reply.code(201).send(result);
    });
    seller.put('/products/:id', async (request) => {
      const id = idOf(request.params), v = productWriteSchema.extend(versionSchema.shape).parse(request.body);
      assertImageOwnership(v.imageUrls, request.shopId!);
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const p = await lockProduct(tx, id, request.shopId!); checkVersion(p, v.version);
        const tags = await tx.productTag.findMany({ where: { product_id: id } });
        await references(tx, v, request.shopId!, { category_id: p.category_id, tagIds: tags.map((t) => t.tag_id) });
        if (v.status === 'active' && !await tx.sku.count({ where: { product_id: id, is_active: true } })) throw conflict('上架商品必须有至少一个启用规格');
        await tx.productTag.deleteMany({ where: { product_id: id, tag_id: { notIn: v.tagIds } } });
        await tx.productTag.createMany({ data: v.tagIds.map((tag_id) => ({ product_id: id, tag_id })), skipDuplicates: true });
        await tx.product.update({ where: { id }, data: { ...productData(v), updated_at: stamp(p) } });
        return detail(tx, id, request.shopId!);
      });
    });
    seller.post('/products/:id/skus', async (request, reply) => {
      const id = idOf(request.params), v = skuWriteSchema.parse(request.body);
      const result = await catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const p = await lockProduct(tx, id, request.shopId!);
        if (await tx.sku.count({ where: { product_id: id } }) >= 20) throw conflict('每件商品最多 20 个规格');
        const values = await attributeData(tx, v, request.shopId!);
        const row = await tx.sku.create({ data: { ...skuData(v), product_id: id, attribute_values: { create: values } }, include: skuInclude });
        await tx.product.update({ where: { id }, data: { updated_at: stamp(p) } });
        return skuDto(row);
      });
      return reply.code(201).send(result);
    });
    seller.put('/products/:id/skus/:skuId', async (request) => {
      const id = idOf(request.params), skuId = uuidSchema.parse((request.params as { skuId: string }).skuId), v = skuWriteSchema.extend(versionSchema.shape).parse(request.body);
      return catalogWrite(db, async (tx) => {
        await lockShopAuthority(tx, request, 'catalog:write');
        const p = await lockProduct(tx, id, request.shopId!);
        await tx.$queryRaw`SELECT id FROM skus WHERE id = ${skuId}::uuid FOR UPDATE`;
        const old = await tx.sku.findFirst({ where: { id: skuId, product_id: id } }); if (!old) throw missing(); checkVersion(old, v.version);
        if (old.sku_code !== v.skuCode) throw conflict('商家货号创建后不能修改');
        if (p.status === 'active' && !v.isActive && !await tx.sku.count({ where: { product_id: id, id: { not: skuId }, is_active: true } })) throw conflict('不能停用已上架商品的最后一个启用规格，请先下架商品');
        const values = await attributeData(tx, v, request.shopId!);
        await tx.skuAttributeValue.deleteMany({ where: { sku_id: skuId } });
        const row = await tx.sku.update({ where: { id: skuId }, data: { ...skuData(v), updated_at: stamp(old), attribute_values: { create: values } }, include: skuInclude });
        await tx.product.update({ where: { id }, data: { updated_at: stamp(p) } });
        return skuDto(row);
      });
    });
  }, { prefix: '/api/seller' });
}

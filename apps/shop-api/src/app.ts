import Fastify from 'fastify';
import { createDatabase, Prisma, type PrismaClient } from '@shop/database';
import { MAX_PRODUCT_IMAGES, DEFAULT_SHOP_ID, detailRequestSchema, publicLookupQuerySchema, productQuerySchema, uuidSchema, type ProductQuery, type ProductDto, type AttributeDefinitionDto } from '@shop/contracts';
import { HttpError, registerAuth, type AuthOptions } from './auth/index.ts';
import { registerSeller } from './catalog/seller.ts';
import { registerUploads } from './catalog/uploads.ts';
import type { ImageStore } from './catalog/image-store.ts';
import { registerCart } from './cart/index.ts';
import { registerOrders } from './orders/index.ts';
import { registerShops } from './shops/index.ts';
import { registerAdmin } from './admin/index.ts';
import { registerAddresses } from './auth/addresses.ts';
import { registerChat } from './chat/index.ts';
import type { AgentOptions } from './chat/agent-runtime.ts';

import { InputError, productFilters } from './catalog/query.ts';
const productInclude = {
  _count: { select: { skus: { where: { is_active: true } } } },
  category: true, shop: true,
  tags: { where: { tag: { is_active: true } }, include: { tag: true }, orderBy: { tag: { sort_order: 'asc' as const } } },
  skus: { where: { is_active: true }, take: 20, orderBy: [{ price: 'asc' as const }, { sku_code: 'asc' as const }], include: {
    _count: { select: { attribute_values: true } },
    attribute_values: { take: 20, include: { attribute_definition: true }, orderBy: [{ attribute_definition: { sort_order: 'asc' as const } }, { id: 'asc' as const }] },
  } },
} satisfies Prisma.ProductInclude;
type LoadedProduct = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function definitionDto(d: { id: string; code: string; name: string; data_type: string; unit: string | null; options: Prisma.JsonValue }): AttributeDefinitionDto {
  return { id: d.id, code: d.code, name: d.name, dataType: d.data_type as AttributeDefinitionDto['dataType'], unit: d.unit,
    options: Array.isArray(d.options) ? d.options as string[] : null };
}
function productDto(p: LoadedProduct, summary = false): ProductDto {
  return {
    id: p.id, shopId: p.shop_id, shopName: p.shop.name, name: p.name, description: summary ? p.description?.slice(0, 200) ?? null : p.description, imageUrls: (p.image_urls as string[]).slice(0, MAX_PRODUCT_IMAGES), skuCount: p._count.skus,
    category: p.category?.is_active ? { id: p.category.id, name: p.category.name, description: p.category.description } : null,
    tags: p.tags.map(({ tag }) => ({ id: tag.id, name: tag.name, description: tag.description, groupName: tag.group_name })),
    skus: p.skus.map((s) => ({ id: s.id, skuCode: s.sku_code, name: s.name, price: s.price.toFixed(2), stockQuantity: s.stock_quantity, attributeCount: s._count.attribute_values,
      attributes: s.attribute_values.map((v) => ({ ...definitionDto(v.attribute_definition),
        value: v.text_value ?? v.number_value?.toString() ?? v.boolean_value! })),
    })),
  };
}


export function buildApp(db = createDatabase(), logger = true, authOptions: AuthOptions = {}, agentOptions: AgentOptions = {}, imageStore?: ImageStore) {
  const app = Fastify({ logger: logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] } : false, bodyLimit: 32 * 1024, requestTimeout: 15000 });
  app.addHook('onClose', () => db.$disconnect());
  app.setErrorHandler((error, request, reply) => {
    const e = error as Error & { statusCode?: number };
    const invalid = e.name === 'ZodError' || e instanceof InputError;
    const status = e instanceof HttpError ? e.statusCode : invalid ? 400 : e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    if (status >= 500) request.log.error({ err: e }, 'request failed');
    void reply.code(status).send({ error: { code: e instanceof HttpError ? e.code : status === 400 ? 'INVALID_INPUT' : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      message: e instanceof InputError || e instanceof HttpError ? e.message : status === 400 ? '请求参数不符合接口约定' : status >= 500 ? '服务暂时不可用' : '请求失败', requestId: request.id } });
  });
  const sessions = registerAuth(app, db, authOptions);
  registerAddresses(app, db);
  registerShops(app, db);
  registerAdmin(app, db);
  registerSeller(app, db);
  registerUploads(app, db, imageStore);
  registerCart(app, db);
  registerOrders(app, db);
  registerChat(app, db, sessions, agentOptions);
  app.get('/api/health', async () => {
    await db.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'connected', stage: 'platform-identity' };
  });
  app.get('/api/categories', async (request) => {
    const q = publicLookupQuerySchema.parse(request.query);
    const where = { shop_id: q.shopId ?? DEFAULT_SHOP_ID, shop: { status: 'active' }, is_active: true, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
    const [items, total] = await Promise.all([
      db.category.findMany({ where, select: { id: true, name: true, description: true }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }),
      db.category.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  });
  app.get('/api/tags', async (request) => {
    const q = publicLookupQuerySchema.parse(request.query);
    const where = { shop_id: q.shopId ?? DEFAULT_SHOP_ID, shop: { status: 'active' }, is_active: true, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
    const [rows, total] = await Promise.all([
      db.tag.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }), db.tag.count({ where }),
    ]);
    return { items: rows.map((t) => ({ id: t.id, name: t.name, description: t.description, groupName: t.group_name })), total, page: q.page, pageSize: q.pageSize };
  });
  app.get('/api/filters', async (request) => {
    const q = publicLookupQuerySchema.parse(request.query);
    const where = { shop_id: q.shopId ?? DEFAULT_SHOP_ID, shop: { status: 'active' }, is_filterable: true, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
    const [rows, total] = await Promise.all([
      db.attributeDefinition.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }), db.attributeDefinition.count({ where }),
    ]);
    return { items: rows.map(definitionDto), total, page: q.page, pageSize: q.pageSize };
  });
  app.get('/api/products', async (request) => {
    const q = productQuerySchema.parse(request.query);
    const { where, sku } = await productFilters(db, q);
    const [rows, total] = await Promise.all([
      db.product.findMany({ where, include: { ...productInclude, _count: { select: { skus: { where: sku } } }, skus: { ...productInclude.skus, where: sku } },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ created_at: 'desc' }, { id: 'asc' }] }),
      db.product.count({ where }),
    ]);
    return { items: rows.map((p) => productDto(p, true)), total, page: q.page, pageSize: q.pageSize };
  });
  app.get('/api/products/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const product = await db.product.findFirst({ where: { id: uuidSchema.parse(id), status: 'active', shop: { status: 'active' }, skus: { some: { is_active: true } } }, include: productInclude });
    if (!product) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '商品不存在或未上架', requestId: request.id } });
    return productDto(product);
  });
  app.post('/api/products/details', async (request) => {
    const { ids } = detailRequestSchema.parse(request.body);
    const rows = await db.product.findMany({ where: { id: { in: ids }, status: 'active', shop: { status: 'active' }, skus: { some: { is_active: true } } }, include: productInclude });
    const mapped = new Map(rows.map((p) => [p.id, productDto(p)]));
    return { items: [...new Set(ids)].flatMap((id) => mapped.has(id) ? [mapped.get(id)!] : []) };
  });
  return app;
}

import { Prisma } from '@shop/database';
import { agentDetailsSchema, agentLookupSchema, agentSearchSchema, type AgentCardDto, type ProductQuery, type RequirementState } from '@shop/contracts';
import { HttpError } from '../auth/index.ts';
import { InputError, productFilters } from '../catalog/query.ts';
import { requirementQuery } from './agent-memory.ts';

type Tx = Prisma.TransactionClient;
const text = (s: string | null, max = 400) => s === null ? null : { text: s.slice(0, max), truncated: s.length > max };
const skuInclude = { _count: { select: { attribute_values: true } }, attribute_values: { take: 10, orderBy: { id: 'asc' as const }, include: { attribute_definition: true } } } as const;
type Sku = Prisma.SkuGetPayload<{ include: typeof skuInclude }>;
function skuDto(s: Sku, ref: string) {
  return { id: s.id, ref, name: s.name, price: s.price.toFixed(2), available: s.stock_quantity > 0, stockQuantity: s.stock_quantity,
    attributeCount: s._count.attribute_values, attributesTruncated: s._count.attribute_values > s.attribute_values.length,
    attributes: s.attribute_values.map((v) => ({ id: v.attribute_definition_id, name: v.attribute_definition.name, unit: v.attribute_definition.unit, value: v.text_value ?? v.number_value?.toString() ?? v.boolean_value })) };
}
// JSON stays valid and every omitted page row is visible to the caller. A very
// large single item is rejected instead of silently removing its hard facts.
export function boundedPage<T extends { items: unknown[] }>(result: T): T & { responseTruncated: boolean; hasMore: boolean; returned: number; retryWithSmallerPage: boolean } {
  const items = [...result.items]; let responseTruncated = false;
  const out = () => ({ ...result, items, responseTruncated, retryWithSmallerPage: responseTruncated, hasMore: responseTruncated || !!(result as { hasMore?: boolean }).hasMore, returned: items.length });
  while (Buffer.byteLength(JSON.stringify(out())) > 12 * 1024 && items.length > 1) { items.pop(); responseTruncated = true; }
  if (Buffer.byteLength(JSON.stringify(out())) > 12 * 1024) throw new HttpError(422, 'AGENT_RESULT_TOO_LARGE', '商品资料过多，请缩小查询范围');
  return out() as T & { responseTruncated: boolean; hasMore: boolean; returned: number; retryWithSmallerPage: boolean };
}
export function createAgentCatalog(shopId: string) {
  // Only server-side code holds this evidence. A model cannot self-authorize a
  // guessed SKU, attach a fake price, or keep a recommendation after conditions change.
  type RelatedEvidence = { terms: string[]; original: ProductQuery; quantity: number; stateKey: string };
  const observed = new Map<string, { query: ProductQuery; related?: RelatedEvidence } | null>();
  const references = new Map<string, string>(), referenceBySku = new Map<string, string>();
  function reference(skuId: string) {
    if (!referenceBySku.has(skuId)) {
      const ref = `sku_${referenceBySku.size + 1}`;
      references.set(ref, skuId); referenceBySku.set(skuId, ref);
    }
    return referenceBySku.get(skuId)!;
  }
  const emptyKeywords = new Set<string>();
  let expanded = false;
  const stateKey = (state: RequirementState) => JSON.stringify([state.revision, state.constraints, state.productScope, state.unresolved]);
  const relatedText = (terms: string[]): Prisma.ProductWhereInput => ({ OR: terms.flatMap(term => [
    { name: { contains: term, mode: 'insensitive' as const } }, { description: { contains: term, mode: 'insensitive' as const } },
  ]) });
  function relatedSkuIds(state: RequirementState) {
    return new Set([...observed].filter(([, evidence]) => evidence?.related?.stateKey === stateKey(state)).map(([id]) => id));
  }
  async function lookup(tx: Tx, tool: 'listCategories' | 'listTags' | 'getFilters', raw: unknown) {
    const q = agentLookupSchema.parse(raw), base = { shop_id: shopId, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}) };
    const page = { skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }] };
    let items: unknown[], total: number;
    if (tool === 'listCategories') {
      const where = { ...base, is_active: true }; total = await tx.category.count({ where });
      items = (await tx.category.findMany({ where, ...page })).map((r) => ({ id: r.id, name: r.name, description: text(r.description) }));
    } else if (tool === 'listTags') {
      const where = { ...base, is_active: true }; total = await tx.tag.count({ where });
      items = (await tx.tag.findMany({ where, ...page })).map((r) => ({ id: r.id, name: r.name, description: text(r.description), groupName: r.group_name }));
    } else {
      const where = { ...base, is_filterable: true }; total = await tx.attributeDefinition.count({ where });
      items = (await tx.attributeDefinition.findMany({ where, ...page })).map((r) => {
        const options = Array.isArray(r.options) ? r.options : [];
        return { id: r.id, name: r.name, type: r.data_type, unit: r.unit, options: options.slice(0, 20), optionCount: options.length, optionsTruncated: options.length > 20 };
      });
    }
    return boundedPage({ items, total, page: q.page, pageSize: q.pageSize, hasMore: q.page * q.pageSize < total });
  }
  async function search(tx: Tx, raw: unknown, requirements?: RequirementState) {
    const input = agentSearchSchema.parse(raw);
    let q: ProductQuery = { ...input, shopId }, related: RelatedEvidence | undefined;
    if (input.relatedTerms) {
      if (!requirements || expanded || requirements.productScope) throw new HttpError(422, 'AGENT_RELATED_NOT_ALLOWED', '当前查询不支持扩展推荐');
      const { query, blocked, quantity } = requirementQuery(requirements);
      if (blocked.length || !query.q || input.q !== query.q || input.page !== 1 || !emptyKeywords.has(query.q)) throw new HttpError(422, 'AGENT_RELATED_NOT_ALLOWED', '请先按原始需求查询，再选择相关商品');
      const exact = await productFilters(tx, { ...query, shopId });
      if (await tx.product.count({ where: { AND: [exact.where, { skus: { some: { AND: [exact.sku, { stock_quantity: { gte: quantity } }] } } }] } })) throw new HttpError(422, 'AGENT_RELATED_NOT_ALLOWED', '已有符合原条件的商品，请优先推荐');
      expanded = true;
      related = { terms: [...new Set(input.relatedTerms)], original: { ...query, shopId }, quantity, stateKey: stateKey(requirements) };
      // The model cannot change a budget, attribute, tag or category through
      // fallback arguments. Only the original text phrase is expanded.
      q = { ...query, q: undefined, shopId, page: 1, pageSize: 3, inStock: true };
    }
    const filters = await productFilters(tx, q);
    const sku: Prisma.SkuWhereInput = related ? { AND: [filters.sku, { stock_quantity: { gte: related.quantity } }] } : filters.sku;
    let where: Prisma.ProductWhereInput = related ? { AND: [filters.where, relatedText(related.terms), { skus: { some: sku } }] } : filters.where;
    // Prefer merchandise whose title identifies the requested item, rather
    // than an accessory that merely mentions it in its description.
    const titleTerms = related?.terms ?? (q.q ? [q.q] : []);
    if (titleTerms.length) {
      const named = { AND: [where, { OR: titleTerms.map(term => ({ name: { contains: term, mode: 'insensitive' as const } })) }] };
      if (await tx.product.count({ where: named })) where = named;
    }
    const total = await tx.product.count({ where });
    const rows = await tx.product.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      include: { _count: { select: { skus: { where: sku } } }, skus: { where: sku, orderBy: [{ price: 'asc' }, { id: 'asc' }], take: related ? 1 : 3, include: skuInclude } } });
    const result = boundedPage({ items: rows.map((p) => ({ id: p.id, name: p.name, description: text(p.description, 200), matchingSkuCount: p._count.skus, skusTruncated: p._count.skus > p.skus.length, skus: p.skus.map(s => skuDto(s, reference(s.id))) })), total, page: q.page, pageSize: q.pageSize, hasMore: q.page * q.pageSize < total,
      matchType: related ? 'related' as const : 'direct' as const, ...(related ? { relatedTo: related.original.q, relatedTerms: related.terms } : {}) });
    if (!related && input.q && total === 0) emptyKeywords.add(input.q);
    for (const p of result.items) for (const s of p.skus) observed.set(s.id, { query: q, ...(related ? { related } : {}) });
    return result;
  }
  async function details(tx: Tx, raw: unknown) {
    const q = agentDetailsSchema.parse(raw);
    const where = { id: { in: q.ids }, shop_id: shopId, status: 'active', skus: { some: { is_active: true } } };
    const products = await tx.product.findMany({ where, orderBy: { id: 'asc' } });
    if (q.skuIds) {
      const valid = await tx.sku.count({ where: { id: { in: [...new Set(q.skuIds)] }, is_active: true, product_id: { in: products.map((p) => p.id) } } });
      if (valid !== new Set(q.skuIds).size) throw new HttpError(404, 'AGENT_SKU_UNAVAILABLE', '规格不存在、不可用或不属于所查商品');
    }
    const items = [];
    for (const p of products) {
      const skuWhere = { product_id: p.id, is_active: true, ...(q.skuIds ? { id: { in: q.skuIds } } : {}) };
      const total = await tx.sku.count({ where: skuWhere });
      const skus = await tx.sku.findMany({ where: skuWhere, skip: (q.skuPage - 1) * q.skuPageSize, take: q.skuPageSize, orderBy: [{ price: 'asc' }, { id: 'asc' }], include: skuInclude });
      items.push({ id: p.id, name: p.name, description: text(p.description, 1200), skus: skus.map(s => skuDto(s, reference(s.id))), skuTotal: total, skuPage: q.skuPage, skuPageSize: q.skuPageSize, hasMoreSkus: q.skuPage * q.skuPageSize < total });
    }
    const result = boundedPage({ items, unavailableIds: [...new Set(q.ids)].filter((id) => !products.some((p) => p.id === id)), hasMore: false });
    for (const p of result.items) for (const s of p.skus) if (!observed.has(s.id)) observed.set(s.id, null);
    return result;
  }
  async function cards(tx: Tx, candidates: { skuId: string; reason: string }[]): Promise<AgentCardDto[]> {
    const cards: AgentCardDto[] = [];
    for (const candidate of candidates) {
      const skuId = references.get(candidate.skuId) ?? candidate.skuId;
      if (!observed.has(skuId)) throw new HttpError(422, 'AGENT_UNVERIFIED_CANDIDATE', '推荐规格尚未经过查询核验');
      const evidence = observed.get(skuId);
      let sku: Prisma.SkuWhereInput = { is_active: true }, product: Prisma.ProductWhereInput = { shop_id: shopId, status: 'active' };
      if (evidence) {
        try {
          const current = await productFilters(tx, evidence.query); sku = current.sku; product = current.where;
          if (evidence.related) {
            const exact = await productFilters(tx, evidence.related.original);
            if (await tx.product.count({ where: { AND: [exact.where, { skus: { some: { AND: [exact.sku, { stock_quantity: { gte: evidence.related.quantity } }] } } }] } })) continue;
            product = { AND: [product, relatedText(evidence.related.terms)] };
            sku = { AND: [sku, { stock_quantity: { gte: evidence.related.quantity } }] };
          }
        }
        catch (err) { if (err instanceof InputError) continue; throw err; }
      }
      const s = await tx.sku.findFirst({ where: { AND: [sku, { id: skuId, is_active: true, stock_quantity: { gt: 0 }, product }] }, include: { product: true } });
      if (!s) continue;
      if (cards.some((c) => c.skuId === s.id)) continue;
      if (evidence?.related && (cards.some(c => c.productId === s.product_id) || cards.length >= 3)) continue;
      const images = s.product.image_urls;
      cards.push({ productId: s.product_id, skuId: s.id, name: s.product.name, skuName: s.name, price: s.price.toFixed(2), imageUrl: Array.isArray(images) && typeof images[0] === 'string' ? images[0] : null, reason: (evidence?.related ? `相关选择：${candidate.reason}` : candidate.reason).slice(0, 200) });
    }
    return cards;
  }
  return { lookup, search, details, cards, relatedSkuIds };
}

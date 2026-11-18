import { Prisma } from '@shop/database';
import {
  requirementChangesSchema, requirementStateSchema, type RequirementChange, type RequirementConstraint,
  type RequirementState, type AgentCardDto, type ProductQuery,
} from '@shop/contracts';
import { HttpError } from '../auth/index.ts';
import { InputError, productFilters } from '../catalog/query.ts';

export type BuyerMemoryMessage = { sequence: number; content: string; productId: string | null; skuId: string | null };
export type MemoryMessage = BuyerMemoryMessage & { role: 'buyer' | 'agent' | 'seller' };
const invalid = (message = '需求引用无效，请重新说明要求或转人工') => new HttpError(422, 'AGENT_MEMORY_INVALID', message);
const limit = () => new HttpError(422, 'AGENT_CONTEXT_LIMIT', '本轮需求过多，请缩小范围或转人工');

export function constraintKey(value: RequirementConstraint['value']): string {
  if (value.kind === 'attribute') return `attribute:${value.filter.attributeId.toLowerCase()}:${value.filter.op}`;
  if (value.kind === 'tag') return `tag:${value.tagId.toLowerCase()}`;
  if (value.kind === 'text') return `text:${value.dimension}`;
  return value.kind;
}
export function emptyRequirements(): RequirementState {
  return { schemaVersion: 2, revision: 0, coveredBuyerSequence: 0, resetThroughSequence: 0,
    purpose: null, productScope: null, constraints: [], unresolved: [], candidateSkuIds: [], candidateRevision: 0,
    summary: { kind: 'requirements', content: '', coveredThroughSequence: 0, truncated: false } };
}
export function loadRequirements(raw: unknown, covered: number): RequirementState {
  const parsed = requirementStateSchema.safeParse(raw);
  if (parsed.success) {
    const state = parsed.data;
    if (state.coveredBuyerSequence !== covered || state.resetThroughSequence > covered || state.summary.coveredThroughSequence > covered
      || state.candidateRevision > state.revision || new Set(state.constraints.map(c => c.key)).size !== state.constraints.length
      || new Set(state.unresolved.map(c => c.key)).size !== state.unresolved.length
      || state.constraints.some(c => c.key !== constraintKey(c.value))) throw invalid();
    const sources = [...state.constraints.map(c => c.source), ...state.unresolved.map(c => c.source), state.purpose?.source, state.productScope?.source].filter(Boolean);
    if (sources.some(source => source!.sequence > covered || source!.sequence < state.resetThroughSequence)) throw invalid();
    return ensureSize(state);
  }
  // Only the exact legacy empty/progress formats are upgraded. An unknown
  // semantic schema is never silently cleared, which could drop hard conditions.
  const old = raw as Record<string, unknown> | null;
  if (!old || Array.isArray(old) || typeof old !== 'object') throw invalid();
  const keys = Object.keys(old);
  const empty = keys.length === 0;
  const legacy = keys.length === 3 && old.schemaVersion === 1 && Number.isInteger(old.revision) && Number(old.revision) >= 0
    && old.coveredBuyerSequence === covered && keys.every(key => ['schemaVersion', 'revision', 'coveredBuyerSequence'].includes(key));
  if (!empty && !legacy) throw invalid('需求格式尚不支持，请转人工继续咨询');
  return { ...emptyRequirements(), coveredBuyerSequence: covered, revision: legacy ? Number(old.revision) : 0 };
}
function ensureSize(state: RequirementState) {
  if (state.constraints.length > 20 || state.unresolved.length > 10 || Buffer.byteLength(JSON.stringify(state)) > 8192) throw limit();
  return requirementStateSchema.parse(state);
}
function sourceOf(change: RequirementChange) { return change.op === 'set' ? change.constraint.source : change.source; }
function clearScoped(state: RequirementState, sequence: number, keepObject = false) {
  // Explicit conditions in this same buyer message already concern the new
  // intent; only older scoped conditions are invalidated.
  state.constraints = state.constraints.filter(c => c.scope === 'global' || c.source.sequence >= sequence
    || (keepObject && ['keyword', 'category'].includes(c.value.kind)));
  state.unresolved = state.unresolved.filter(q => q.source.sequence >= sequence);
}
function digest(state: RequirementState, coveredThroughSequence: number): RequirementState['summary'] {
  const entries = [
    state.purpose ? `用途：${state.purpose.value}` : '',
    state.productScope ? `当前商品：${state.productScope.productId}${state.productScope.skuId ? ` / ${state.productScope.skuId}` : ''}` : '',
    ...state.constraints.map(c => `[${c.level}/${c.scope}] ${c.key}：${JSON.stringify(c.value)}（买家消息${c.source.sequence}）`),
    ...state.unresolved.map(q => `待确认：${q.question}（买家消息${q.source.sequence}）`),
  ].filter(Boolean).join('\n');
  return { kind: 'requirements', content: [...entries].slice(0, 800).join(''), coveredThroughSequence, truncated: [...entries].length > 800 };
}
export function mergeRequirements(previous: RequirementState, raw: unknown, pending: BuyerMemoryMessage[], trigger: number): RequirementState {
  const changes = requirementChangesSchema.parse(raw), state = structuredClone(previous);
  if (trigger <= previous.coveredBuyerSequence || !pending.length || pending.at(-1)?.sequence !== trigger) throw invalid();
  const ordered = [...changes].sort((a, b) => sourceOf(a).sequence - sourceOf(b).sequence);
  for (const change of ordered) {
    const source = sourceOf(change), message = pending.find(m => m.sequence === source.sequence);
    if (!message || source.sequence <= previous.coveredBuyerSequence || source.sequence > trigger || !message.content.includes(source.quote)) throw invalid();
    if (change.op === 'reset') {
      // Destructive reset requires an explicit reset phrase in the cited text.
      if (!/重新(?:开始|来)|(?:刚才|前面|之前).*(?:不算|作废)|清空(?:需求|条件)|重置(?:需求|条件)/.test(source.quote)) throw invalid();
      Object.assign(state, emptyRequirements(), { revision: previous.revision, resetThroughSequence: source.sequence });
    } else if (change.op === 'set') {
      const c = change.constraint;
      if (c.key !== constraintKey(c.value)) throw invalid();
      if (c.value.kind === 'keyword' || c.value.kind === 'category') {
        const before = state.constraints.find(old => old.key === c.key);
        if (state.productScope || (before && JSON.stringify(before.value) !== JSON.stringify(c.value))) {
          clearScoped(state, source.sequence); state.productScope = null;
          if (state.purpose && state.purpose.source.sequence < source.sequence) state.purpose = null;
        }
      }
      state.constraints = state.constraints.filter(old => old.key !== c.key);
      state.constraints.push(c);
    } else if (change.op === 'remove') {
      state.constraints = state.constraints.filter(old => old.key !== change.key);
      // Old unresolved notes about a removed condition must not resurrect it.
      state.unresolved = state.unresolved.filter(old => old.key !== change.key);
    } else if (change.op === 'purpose') {
      if (state.purpose?.value !== change.value) {
        clearScoped(state, source.sequence, true);
      }
      state.purpose = change.value ? { value: change.value, source } : null;
    } else if (change.op === 'product') {
      if (change.skuId && !change.productId) throw invalid();
      if (state.productScope?.productId !== change.productId || state.productScope?.skuId !== change.skuId) {
        clearScoped(state, source.sequence);
        if (state.purpose && state.purpose.source.sequence < source.sequence) state.purpose = null;
      }
      state.productScope = change.productId ? { productId: change.productId, skuId: change.skuId, source } : null;
    } else {
      state.unresolved = state.unresolved.filter(old => old.key !== change.key);
      if (change.question) state.unresolved.push({ key: change.key, question: change.question, source });
    }
  }
  state.revision = previous.revision + 1;
  state.coveredBuyerSequence = trigger;
  // Cached candidates belong to one successful revision; every new run must
  // obtain fresh catalog evidence, even when the buyer only asks a follow-up.
  state.candidateSkuIds = []; state.candidateRevision = state.revision;
  state.summary = digest(state, previous.summary.coveredThroughSequence < state.resetThroughSequence ? 0 : previous.summary.coveredThroughSequence);
  return ensureSize(state);
}

export function requirementQuery(state: RequirementState): { query: ProductQuery; blocked: string[]; quantity: number } {
  const query: ProductQuery & { tagIds: string[] } = { page: 1, pageSize: 6, tagIds: [], tagMode: 'all', inStock: true, attributes: [] };
  const blocked = state.unresolved.map(q => q.question); let quantity = 1;
  for (const c of state.constraints) {
    if (c.level !== 'hard') continue;
    const value = c.value;
    if (value.kind === 'budget') {
      if (value.min !== null) query.minPrice = value.min;
      if (value.max !== null) query.maxPrice = value.max;
      if (value.min !== null && value.max !== null && new Prisma.Decimal(value.min).gt(value.max)) blocked.push('预算上下限冲突，请确认预算');
    } else if (value.kind === 'keyword') query.q = value.value;
    else if (value.kind === 'category') query.categoryId = value.categoryId;
    else if (value.kind === 'tag') query.tagIds.push(value.tagId);
    else if (value.kind === 'attribute') query.attributes.push(value.filter);
    else if (value.kind === 'quantity') quantity = value.value;
    else blocked.push(`尚未验证的要求：${value.excluded ? '排除' : ''}${value.value}`);
  }
  if (query.attributes.length > 10 || query.tagIds.length > 10) blocked.push('筛选条件过多，请缩小范围');
  return { query, blocked, quantity };
}

export async function validateRequirementReferences(tx: Prisma.TransactionClient, shopId: string, changes: RequirementChange[]) {
  for (const change of changes) {
    if (change.op === 'product' && change.productId) {
      const p = await tx.product.findFirst({ where: { id: change.productId, shop_id: shopId, status: 'active', ...(change.skuId ? { skus: { some: { id: change.skuId, is_active: true } } } : {}) }, select: { id: true } });
      if (!p) throw invalid('咨询商品不存在或不属于当前店铺');
    }
    if (change.op !== 'set') continue;
    const value = change.constraint.value;
    if (!['category', 'tag', 'attribute'].includes(value.kind)) continue;
    const q: ProductQuery = { page: 1, pageSize: 1, tagIds: value.kind === 'tag' ? [value.tagId] : [], tagMode: 'all', inStock: true,
      attributes: value.kind === 'attribute' ? [value.filter] : [], ...(value.kind === 'category' ? { categoryId: value.categoryId } : {}) };
    try { await productFilters(tx, { ...q, shopId }); } catch (err) { if (err instanceof InputError) throw invalid(); throw err; }
  }
}

export async function filterRequirementCards(tx: Prisma.TransactionClient, shopId: string, state: RequirementState, cards: AgentCardDto[], relatedSkuIds: ReadonlySet<string> = new Set()) {
  const { query, blocked, quantity } = requirementQuery(state);
  if (blocked.length) return [];
  let filters: Awaited<ReturnType<typeof productFilters>>;
  try { filters = await productFilters(tx, { ...query, shopId }); }
  catch (err) { if (err instanceof InputError) return []; throw err; }
  // Only current-run server evidence can relax the literal keyword, for those
  // particular SKUs. Every other hard constraint still applies to that SKU.
  const alternatives = !state.productScope && query.q && relatedSkuIds.size
    ? await productFilters(tx, { ...query, q: undefined, shopId }) : null;
  const rows = await tx.sku.findMany({ where: { AND: [filters.sku, { id: { in: cards.map(c => c.skuId) }, stock_quantity: { gte: quantity },
    OR: [{ product: { AND: [filters.where, ...(state.productScope ? [{ id: state.productScope.productId }] : [])] } },
      ...(alternatives ? [{ id: { in: [...relatedSkuIds] }, product: alternatives.where }] : [])],
    ...(state.productScope?.skuId ? { id: state.productScope.skuId } : {}) }] }, select: { id: true } });
  const valid = new Set(rows.map(row => row.id));
  return cards.filter(card => valid.has(card.skuId));
}

export function buildMemoryContext(state: RequirementState, recent: MemoryMessage[], pending: BuyerMemoryMessage[], omittedCount: number) {
  const usable = recent.filter(m => m.sequence > state.resetThroughSequence);
  const sequenceSet = new Set(pending.map(m => m.sequence));
  // All unprocessed buyer messages are mandatory; only already-covered history
  // can be evicted. Never slice the latest buyer message or its source quote.
  const earlier = usable.filter(m => !sequenceSet.has(m.sequence)).slice(-Math.max(0, 20 - pending.length));
  const selected = [...earlier, ...pending.map(m => ({ ...m, role: 'buyer' as const }))].sort((a, b) => a.sequence - b.sequence);
  if (pending.length > 20 || Buffer.byteLength(JSON.stringify({ state, messages: selected })) > 32 * 1024) throw limit();
  const first = selected[0]?.sequence ?? 0;
  const coveredThroughSequence = Math.max(state.summary.coveredThroughSequence, Math.min(state.coveredBuyerSequence, Math.max(0, first - 1)));
  const summary = digest(state, coveredThroughSequence);
  return { requirements: structuredClone({ ...state, summary }), history: selected, historyIncomplete: omittedCount > 0 || usable.length + pending.length > selected.length + sequenceSet.size,
    // This flag explicitly says the digest does not reproduce discarded speech.
    summaryKind: 'active-requirements-only' as const };
}

export function finalizeRequirements(state: RequirementState, skuIds: string[], summaryCovered: number) {
  state.candidateSkuIds = [...new Set(skuIds)].slice(0, 10);
  state.candidateRevision = state.revision;
  state.summary = digest(state, state.resetThroughSequence > summaryCovered ? 0 : Math.min(summaryCovered, state.coveredBuyerSequence));
  return ensureSize(state);
}

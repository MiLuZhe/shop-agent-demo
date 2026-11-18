import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { requirementStateSchema, type RequirementChange, type RequirementState } from '@shop/contracts';
import { buildMemoryContext, emptyRequirements, finalizeRequirements, loadRequirements, mergeRequirements, requirementQuery, type BuyerMemoryMessage, type MemoryMessage } from './chat/agent-memory.ts';
import { mockRequirementChanges } from './chat/agent-mock-memory.ts';

const buyer = (sequence: number, content: string): BuyerMemoryMessage => ({ sequence, content, productId: null, skuId: null });
function apply(state: RequirementState, messages: BuyerMemoryMessage[]) {
  return mergeRequirements(state, mockRequirementChanges(messages), messages, messages.at(-1)!.sequence);
}
const budget = (state: RequirementState) => state.constraints.find(c => c.key === 'budget');

test('buyer changes only the budget, retains purpose and color, removes rather than restores old conditions', () => {
  const initial = apply(emptyRequirements(), [buyer(1, '用途通勤，预算最多200，颜色蓝色')]);
  const changed = apply(initial, [buyer(3, '预算提高到300')]);
  assert.equal(changed.purpose?.value, '通勤');
  assert.equal(changed.constraints.find(c => c.key === 'text:color')?.value.kind, 'text');
  assert.deepEqual(budget(changed)?.value, { kind: 'budget', min: null, max: '300' });
  assert.equal(budget(changed)?.source.sequence, 3);
  const removed = apply(changed, [buyer(5, '预算不用管了，不限颜色')]);
  assert.equal(budget(removed), undefined); assert.equal(removed.constraints.length, 0);
  assert.equal(removed.purpose?.value, '通勤');
  assert.equal(requirementQuery(removed).query.maxPrice, undefined);
});

test('hard requirements, preferences, unconfirmed interpretations and unresolved facts remain distinct', () => {
  const initial = apply(emptyRequirements(), [buyer(1, '预算200左右，最好蓝色')]);
  assert.ok(initial.constraints.every(c => c.level === 'preference'));
  assert.equal(requirementQuery(initial).query.maxPrice, undefined);
  const next = apply(initial, [buyer(3, '预算最多200，不要红色')]);
  assert.equal(budget(next)?.level, 'hard');
  assert.equal(requirementQuery(next).query.maxPrice, '200');
  assert.equal(requirementQuery(next).blocked.length, 1, 'unmapped hard colors cannot be claimed as verified');
  const uncertain = mergeRequirements(emptyRequirements(), [{ op: 'set', constraint: {
    key: 'budget', scope: 'global', level: 'unconfirmed', value: { kind: 'budget', min: null, max: '100' }, source: { sequence: 1, quote: '便宜一点' },
  } }], [buyer(1, '便宜一点')], 1);
  assert.equal(requirementQuery(uncertain).query.maxPrice, undefined);
  assert.equal(budget(uncertain)?.level, 'unconfirmed');
});

test('explicit reset clears old preferences, candidate cache and summary without deleting messages', () => {
  const initial = apply(emptyRequirements(), [buyer(1, '预算200，颜色蓝色')]);
  finalizeRequirements(initial, [randomUUID()], 0);
  const messages = [buyer(3, '重新开始，预算最多500')];
  const reset = apply(initial, messages);
  assert.equal(reset.resetThroughSequence, 3); assert.equal(reset.constraints.length, 1);
  assert.equal(reset.candidateSkuIds.length, 0); assert.ok(!reset.summary.content.includes('蓝色'));
  assert.deepEqual(budget(reset)?.value, { kind: 'budget', min: null, max: '500' });
  assert.equal(initial.constraints.length, 2, 'merging does not mutate persisted baseline');
  assert.equal(messages[0]?.content, '重新开始，预算最多500');
});

test('switching product or purpose clears scoped requirements while retaining explicit global constraints', () => {
  const initial = apply(emptyRequirements(), [buyer(1, '用途通勤，预算200，颜色蓝色')]);
  const id = randomUUID(), source = { sequence: 3, quote: '换个商品' };
  const next = mergeRequirements(initial, [{ op: 'product', productId: id, skuId: null, source }], [buyer(3, source.quote)], 3);
  assert.equal(next.productScope?.productId, id); assert.equal(next.purpose, null);
  assert.deepEqual(next.constraints.map(c => c.key), ['budget']);
  const changed = apply(initial, [buyer(3, '用途露营')]);
  assert.deepEqual(changed.constraints.map(c => c.key), ['budget']); assert.equal(changed.purpose?.value, '露营');
});

test('all pending supplements are merged in source order and stale references cannot overwrite new conditions', () => {
  const messages = [buyer(1, '预算200'), buyer(2, '颜色蓝色'), buyer(3, '预算改成300')];
  const changes = mockRequirementChanges(messages).reverse();
  const state = mergeRequirements(emptyRequirements(), changes, messages, 3);
  assert.deepEqual(budget(state)?.value, { kind: 'budget', min: null, max: '300' });
  assert.ok(state.constraints.some(c => c.key === 'text:color'));
  assert.throws(() => mergeRequirements(state, [changes.at(-1)!], [buyer(5, '最新需求')], 5));
});

test('switching the search object invalidates old product conditions while a purpose change retains the object', () => {
  const initial = apply(emptyRequirements(), [buyer(1, '搜索 水杯，预算200，颜色蓝色')]);
  const switched = apply(initial, [buyer(3, '颜色黑色，改找背包')]);
  assert.deepEqual(switched.constraints.map(c => c.key).sort(), ['budget', 'keyword', 'text:color']);
  assert.equal((switched.constraints.find(c => c.key === 'text:color')?.value as { value: string }).value, '黑色');
  const changedPurpose = apply(initial, [buyer(3, '用途露营')]);
  assert.ok(changedPurpose.constraints.some(c => c.key === 'keyword'));
  assert.ok(!changedPurpose.constraints.some(c => c.key === 'text:color'));
  const withProduct = { ...initial, productScope: { productId: randomUUID(), skuId: null, source: { sequence: 1, quote: '水杯' } } };
  const broader = apply(withProduct, [buyer(3, '改找背包')]);
  assert.equal(broader.productScope, null); assert.ok(!broader.constraints.some(c => c.key === 'text:color'));
});

test('forged quotes, assistant evidence, invented dimensions, injected identities and implicit resets are rejected', () => {
  const legitimate = mockRequirementChanges([buyer(1, '预算200')])[0]!;
  const forged = structuredClone(legitimate);
  assert.equal(forged.op, 'set');
  if (forged.op === 'set') forged.constraint.source.quote = '预算500';
  assert.throws(() => mergeRequirements(emptyRequirements(), [forged], [buyer(1, '预算200')], 1));
  assert.throws(() => mergeRequirements(emptyRequirements(), [legitimate], [buyer(2, '别的问题')], 2));
  const wrongKey = structuredClone(legitimate);
  if (wrongKey.op === 'set') wrongKey.constraint.key = 'privilege';
  assert.throws(() => mergeRequirements(emptyRequirements(), [wrongKey], [buyer(1, '预算200')], 1));
  assert.throws(() => mergeRequirements(emptyRequirements(), [{ ...legitimate, shopId: randomUUID() }], [buyer(1, '预算200')], 1));
  assert.throws(() => mergeRequirements(emptyRequirements(), [{ op: 'reset', source: { sequence: 1, quote: '你好' } }], [buyer(1, '你好')], 1));
  assert.equal(mockRequirementChanges([buyer(1, '不要重新开始')]).length, 0);
});

test('conflicting budget is preserved and requests clarification instead of silently relaxing a limit', () => {
  const message = buyer(1, '预算至少300但最多200');
  const state = mergeRequirements(emptyRequirements(), [{ op: 'set', constraint: { key: 'budget', scope: 'global', level: 'hard', value: { kind: 'budget', min: '300', max: '200' }, source: { sequence: 1, quote: message.content } } }], [message], 1);
  assert.equal(requirementQuery(state).blocked.length, 1);
  assert.deepEqual(budget(state)?.value, { kind: 'budget', min: '300', max: '200' });
});

test('memory limits fail without discarding hard constraints, and unknown persisted formats are not cleared', () => {
  const message = buyer(1, '要满足这些条件');
  const changes: RequirementChange[] = Array.from({ length: 21 }, (_, i) => ({ op: 'set', constraint: { key: `text:feature${i}`, scope: 'global', level: 'hard', value: { kind: 'text', dimension: `feature${i}`, value: '需要满足', excluded: false }, source: { sequence: 1, quote: message.content } } }));
  assert.throws(() => mergeRequirements(emptyRequirements(), changes, [message], 1), /过多/);
  assert.throws(() => loadRequirements({ schemaVersion: 99, constraints: ['不能丢掉'] }, 0));
  const unicode = changes.slice(0, 12).map(c => c.op === 'set' ? { ...c, constraint: { ...c.constraint, value: { kind: 'text' as const, dimension: c.constraint.key.slice(5), value: '中'.repeat(160), excluded: false } } } : c);
  assert.throws(() => mergeRequirements(emptyRequirements(), unicode, [message], 1), /过多/);
  const valid = apply(emptyRequirements(), [buyer(1, '预算200')]);
  assert.equal(loadRequirements(JSON.parse(JSON.stringify(valid)), 1).constraints.length, 1);
  assert.throws(() => loadRequirements(valid, 2));
});

test('legacy progress upgrades lazily and each successful revision invalidates candidate caches', () => {
  const old = loadRequirements({ schemaVersion: 1, revision: 4, coveredBuyerSequence: 7 }, 7);
  assert.equal(old.schemaVersion, 2); assert.equal(old.revision, 4);
  const next = apply(old, [buyer(9, '预算200')]);
  finalizeRequirements(next, [randomUUID()], 0); assert.equal(next.candidateSkuIds.length, 1);
  const later = apply(next, [buyer(11, '还有别的吗')]);
  assert.equal(later.revision, 6); assert.equal(later.candidateSkuIds.length, 0);
  assert.equal(requirementStateSchema.parse(later).candidateRevision, later.revision);
});

test('bounded context retains every pending message and full active requirements after history eviction', () => {
  const initial = apply(emptyRequirements(), [buyer(1, '预算200，颜色蓝色')]);
  const state = { ...initial, coveredBuyerSequence: 48 };
  const recent: MemoryMessage[] = Array.from({ length: 21 }, (_, i) => ({ ...buyer(i + 30, `对话${i}`), role: i % 2 ? 'agent' : 'buyer' }));
  const pending = [buyer(49, '预算改成300'), buyer(50, '不限颜色')];
  const context = buildMemoryContext(state, recent, pending, 29);
  assert.equal(context.history.length, 20); assert.equal(context.historyIncomplete, true);
  assert.deepEqual(context.history.slice(-2).map(m => m.content), pending.map(m => m.content));
  assert.equal(context.requirements.constraints.length, 2);
  assert.ok(context.requirements.summary.content.includes('200'));
  assert.equal(context.summaryKind, 'active-requirements-only');
  const tooMany = Array.from({ length: 21 }, (_, i) => buyer(51 + i, '还没处理'));
  assert.throws(() => buildMemoryContext(state, [], tooMany, 0));
  assert.throws(() => buildMemoryContext(state, [], [buyer(51, '中'.repeat(12000))], 0));
});

test('reset prevents obsolete history and summary from entering the next context', () => {
  const initial = apply(emptyRequirements(), [buyer(1, '预算200')]);
  const reset = apply(initial, [buyer(3, '重新开始')]);
  const context = buildMemoryContext(reset, [{ ...buyer(1, '预算200'), role: 'buyer' }], [buyer(5, '新需求')], 0);
  assert.deepEqual(context.history.map(m => m.sequence), [5]);
  assert.ok(!context.requirements.summary.content.includes('200'));
});

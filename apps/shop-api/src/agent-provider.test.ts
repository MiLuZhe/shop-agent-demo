import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zodSchema } from 'ai';
import { agentResultSchema } from '@shop/contracts';
import { normalizeDeepSeekSchema } from '../../../scripts/lib/deepseek-schema.ts';

test('DeepSeek wire normalization retains every constraint and does not mutate the business schema', async () => {
  const original = await zodSchema(agentResultSchema.required()).jsonSchema;
  const snapshot = JSON.stringify(original);
  const adapted = normalizeDeepSeekSchema(original);
  assert.ok(snapshot.includes('"oneOf"')); assert.ok(!JSON.stringify(adapted).includes('"oneOf"'));
  assert.equal(JSON.stringify(original), snapshot);
  assert.ok(JSON.stringify(adapted).includes('"additionalProperties":false'));
  assert.ok(JSON.stringify(adapted).includes('"maxItems":40'));
  assert.ok(JSON.stringify(adapted).includes('"const":"budget"'));
  assert.ok(JSON.stringify(adapted).includes('"const":"reset"'));
  assert.ok(JSON.stringify(adapted).includes('"minimum":1'));
  assert.deepEqual(adapted.required, ['content', 'candidates', 'requirementChanges']);
  assert.equal(agentResultSchema.safeParse({ content: '可接受', candidates: [], requirementChanges: [], shopId: '伪造身份' }).success, false);
});

test('overlapping or non-discriminated oneOf schemas are rejected rather than silently weakened', () => {
  assert.throws(() => normalizeDeepSeekSchema({ oneOf: [{ type: 'number' }, { type: 'integer' }] }));
  assert.throws(() => normalizeDeepSeekSchema({ oneOf: [
    { type: 'object', properties: { kind: { const: 'same' } }, required: ['kind'] },
    { type: 'object', properties: { kind: { const: 'same' } }, required: ['kind'] },
  ] }));
  assert.throws(() => normalizeDeepSeekSchema({ oneOf: [
    { type: 'object', properties: { kind: { const: 'a' } } },
    { type: 'object', properties: { kind: { const: 'b' } } },
  ] }));
});

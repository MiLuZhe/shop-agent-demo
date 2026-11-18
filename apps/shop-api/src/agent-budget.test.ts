import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelBudget, estimateInputTokens, compactWirePrompt, MODEL_LIMITS } from './agent/budget.ts';
import { boundedFetch, officialEndpoint } from './agent/transport.ts';
import { wireResponse, wireSequence } from './test-helpers/agent-wire.ts';

const body = JSON.stringify({ model: 'deepseek-flash', store: false, max_output_tokens: 1500 });
const run = (fetch: typeof globalThis.fetch, budget = new ModelBudget(() => 1000), signal = new AbortController().signal, deadline = Date.now() + 10000) => ({ fetch: boundedFetch(fetch, budget, signal, deadline), budget });
const request = (fetch: typeof globalThis.fetch, payload = body) => fetch('https://api.deepseek.com/responses', { method: 'POST', body: payload });
const code = (value: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === value;

test('official tokenizer counts mixed inputs, wire schemas and long text with safety margin', () => {
  const basic = estimateInputTokens('预算200，a blue cup 😄'), schema = estimateInputTokens(JSON.stringify({ text: '预算200，a blue cup 😄', tools: [{ description: '查询商品', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] }));
  assert.ok(basic > 256); assert.ok(schema > basic); assert.ok(estimateInputTokens('复杂文本hello世界🙂'.repeat(3000)) > MODEL_LIMITS.input);
});

test('request count, single input/output and cumulative reservations are enforced before network', () => {
  const count = new ModelBudget(() => 1); for (let i = 0; i < 6; i++) count.reserve('{}', 1); assert.throws(() => count.reserve('{}', 1), code('AGENT_MODEL_LIMIT'));
  assert.throws(() => new ModelBudget(() => 8001).reserve('{}', 1), code('AGENT_MODEL_LIMIT'));
  assert.throws(() => new ModelBudget(() => 1).reserve('{}', 1501), code('AGENT_MODEL_LIMIT'));
  const total = new ModelBudget(() => 8000); total.reserve('{}', 1500); total.reserve('{}', 1500); assert.throws(() => total.reserve('{}', 1500), code('AGENT_MODEL_LIMIT'));
  assert.equal(total.requests, 2);
});

test('unknown usage retains reservations, valid cached input is fully counted and actual overrun is rejected', () => {
  const budget = new ModelBudget(() => 1000), reservation = budget.reserve('{}', 1500);
  budget.settle(reservation, { input_tokens: 500, output_tokens: 20, total_tokens: 520 });
  assert.equal(budget.snapshot().reservedTokens, 2500); assert.equal(budget.knownInput, 500);
  const unknown = budget.reserve('{}', 1500); assert.throws(() => budget.settle(unknown, undefined), code('AGENT_USAGE_INVALID')); assert.equal(budget.unknownRequests, 1);
  const overrun = budget.reserve('{}', 100); assert.throws(() => budget.settle(overrun, { input_tokens: 9000, output_tokens: 2 }), code('AGENT_MODEL_LIMIT'));
});

test('transport retries transient HTTP once, reserves both attempts and never retries schema/auth failures', async () => {
  const sequence = wireSequence([() => new Response('temporary', { status: 503 }), () => wireResponse({ ok: true })]), runtime = run(sequence.fetch);
  assert.equal((await request(runtime.fetch)).status, 200); assert.equal(sequence.bodies.length, 2); assert.equal(runtime.budget.unknownRequests, 1); assert.equal(runtime.budget.requests, 2);
  for (const status of [400, 401, 403, 404]) {
    let calls = 0; const failed = run(async () => { calls++; return new Response('secret provider body', { status }); });
    await assert.rejects(request(failed.fetch), code('AGENT_PROVIDER_UNAVAILABLE')); assert.equal(calls, 1);
  }
});

test('network retry and repeated 429 are bounded; aborted/expired requests never send', async () => {
  let calls = 0; const network = run(async () => { calls++; throw new TypeError('raw private failure'); });
  await assert.rejects(request(network.fetch), code('AGENT_PROVIDER_UNAVAILABLE')); assert.equal(calls, 2);
  calls = 0; const rate = run(async () => { calls++; return new Response('', { status: 429 }); });
  await assert.rejects(request(rate.fetch), code('AGENT_PROVIDER_UNAVAILABLE')); assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort(); calls = 0;
  const stopped = run(async () => { calls++; return wireResponse({}); }, undefined, controller.signal);
  await assert.rejects(request(stopped.fetch), code('AGENT_MODEL_TIMEOUT')); assert.equal(calls, 0);
  const expired = run(async () => { calls++; return wireResponse({}); }, undefined, undefined, Date.now() - 1);
  await assert.rejects(request(expired.fetch), code('AGENT_MODEL_TIMEOUT')); assert.equal(calls, 0);
});

test('transport validates destination, model, protocol and never follows redirects', async () => {
  for (const url of ['http://api.deepseek.com', 'https://example.com', 'https://key@api.deepseek.com', 'https://api.deepseek.com/evil', 'https://api.deepseek.com?token=secret']) assert.throws(() => officialEndpoint(url));
  assert.equal(officialEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  let calls = 0; const guarded = run(async () => { calls++; return wireResponse({}); });
  await assert.rejects(guarded.fetch('https://example.com/responses', { body }), code('AGENT_ENDPOINT_FORBIDDEN'));
  for (const patch of [{ stream: true }, { store: true }, { previous_response_id: 'old' }, { model: 'other' }]) await assert.rejects(request(guarded.fetch, JSON.stringify({ ...JSON.parse(body), ...patch })), code('AGENT_PROTOCOL_FORBIDDEN'));
  assert.equal(calls, 0);
  const redirect = run(async (_url, init) => { assert.equal(init?.redirect, 'error'); return new Response('', { status: 302, headers: { location: 'https://example.com' } }); });
  await assert.rejects(request(redirect.fetch), code('AGENT_PROVIDER_UNAVAILABLE'));
});

test('response size, incomplete JSON, missing usage and truncated output fail without replay', async () => {
  for (const response of [new Response('x'.repeat(256 * 1024 + 1)), new Response('{'), wireResponse({}, {}), new Response(JSON.stringify({ status: 'incomplete', usage: { input_tokens: 1, output_tokens: 1500, total_tokens: 1501 } }))]) {
    let calls = 0; const runtime = run(async () => { calls++; return response; });
    await assert.rejects(request(runtime.fetch)); assert.equal(calls, 1);
  }
});

test('in-flight request deadline aborts transport without granting a second timeout window', async () => {
  let calls = 0, aborted = false;
  const runtime = run(async (_input, init) => { calls++; return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('private raw abort')); }, { once: true }); }); }, undefined, undefined, Date.now() + 30);
  // AbortSignal.timeout is unref'ed; keep the test alive until its assertion.
  const keepAlive = setTimeout(() => {}, 200);
  try { await assert.rejects(request(runtime.fetch), code('AGENT_MODEL_TIMEOUT')); assert.equal(calls, 1); assert.ok(aborted); }
  finally { clearTimeout(keepAlive); }
});


test('wire budget compacts old public speech but never truncates pending inputs, hard state or tool pairs', () => {
  const prompt = { pendingBuyerMessages: [{ sequence: 10, content: '当前要求不可截断' }], requirements: { constraints: [{ key: 'budget', max: '200' }] }, history: [{ sequence: 1, content: '旧消息'.repeat(1000) }], historyIncomplete: false };
  const input = [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(prompt) }] }, { type: 'function_call', call_id: 'one', arguments: '{}' }, { type: 'function_call_output', call_id: 'one', output: '工具证据' }];
  const compact = JSON.parse(compactWirePrompt(JSON.stringify({ input }), text => text.length, 1000));
  const parsed = JSON.parse(compact.input[0].content[0].text);
  assert.deepEqual(parsed.pendingBuyerMessages, prompt.pendingBuyerMessages); assert.deepEqual(parsed.requirements, prompt.requirements); assert.equal(parsed.historyIncomplete, true); assert.deepEqual(parsed.history, []);
  assert.deepEqual(compact.input.slice(1), input.slice(1));
  assert.throws(() => compactWirePrompt(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ ...prompt, history: [], pendingBuyerMessages: [{ sequence: 10, content: '新输入'.repeat(1000) }] }) }] }] }), text => text.length, 1000), code('AGENT_MODEL_LIMIT'));
});

import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, tool, isStepCount, Output, jsonSchema, zodSchema } from 'ai';
import { Agent, fetch as undiciFetch } from 'undici';
import { agentResultSchema, agentSearchSchema } from '../packages/contracts/src/agent.ts';
import { normalizeDeepSeekSchema } from './lib/deepseek-schema.ts';

// Isolated synthetic fixtures only. This script never imports the DB or writes
// buyer messages, requirements, products or runtime model configuration.
const require = createRequire(import.meta.url);
const key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) throw new Error('DEEPSEEK_API_KEY is required');
const base = new URL(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
assert.equal(base.origin, 'https://api.deepseek.com');
assert.ok(['/', '/v1', '/v1/'].includes(base.pathname));
assert.ok(!base.username && !base.password && !base.search && !base.hash);
const dispatcher = new Agent(); // Direct dispatcher, never EnvHttpProxyAgent.
const requests: { path: string; stream: boolean; inputTypes: string[]; systemRole?: string; hasPreviousResponseId: boolean; store: unknown; reasoningEffort: unknown; status?: number; aborted: boolean }[] = [];
const cases: { name: string; status: 'passed' | 'failed'; elapsedMs: number; details?: unknown; error?: unknown }[] = [];
const streamObservations = new Map<number, Promise<{ terminalType: string; text: string; status: string } | null>>();
let currentCase = '', totalInput = 0, totalOutput = 0;
const selectedCases = process.argv.slice(2);
const allowedCases = ['sdk-text', 'sdk-tool-roundtrip-stateless', 'sdk-structured-agent-contract', 'sdk-stream-text', 'sdk-tool-and-structured-output', 'sdk-stream-tool-roundtrip', 'sdk-stream-cancel-after-first-delta'];
assert.ok(selectedCases.every(name => allowedCases.includes(name)), 'Unknown compatibility case');
const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const globalAbort = AbortSignal.timeout(240_000);
const provider = createOpenAI({ baseURL: base.href.replace(/\/$/, ''), apiKey: key,
  fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, base.origin, 'Credentials may only be sent to the official endpoint');
    assert.ok(url.pathname === '/responses' || url.pathname === '/v1/responses');
    assert.ok(requests.length < 12, 'Live compatibility request budget exceeded');
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; input?: { type?: string; role?: string }[]; previous_response_id?: unknown; store?: unknown; reasoning?: { effort?: unknown } };
    const request = { path: url.pathname, stream: !!body.stream, inputTypes: (body.input ?? []).map(i => i.type ?? i.role ?? 'unknown'), hasPreviousResponseId: !!body.previous_response_id,
      systemRole: body.input?.find(item => item.role === 'system' || item.role === 'developer')?.role,
      store: body.store, reasoningEffort: body.reasoning?.effort, aborted: false, status: undefined as number | undefined };
    requests.push(request);
    const signal = AbortSignal.any([globalAbort, ...(init?.signal ? [init.signal] : [])]);
    signal.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    // Match fetch and dispatcher versions; Node's bundled Undici may use a
    // different dispatcher handler protocol than a separately installed major.
    const response = await undiciFetch(url, { ...init, signal, dispatcher } as Parameters<typeof undiciFetch>[1]);
    request.status = response.status;
    if (body.stream && response.ok) {
      const index = requests.indexOf(request);
      // Synthetic fixtures only: compare SDK deltas with the canonical terminal
      // text without persisting reasoning, headers or the complete raw SSE.
      streamObservations.set(index, response.clone().text().then(text => {
        let final: { terminalType: string; text: string; status: string } | null = null;
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
              final = { terminalType: event.type, status: event.response?.status, text: (event.response?.output ?? [])
                .filter((item: { type: string }) => item.type === 'message').flatMap((item: { content?: { type: string; text?: string }[] }) => item.content ?? [])
                .filter((part: { type: string }) => part.type === 'output_text').map((part: { text?: string }) => part.text ?? '').join('') };
            }
          } catch {}
        }
        return final;
      }).catch(() => null));
    }
    return response as unknown as Response;
  },
});
const model = provider.responses(modelName);
// DeepSeek is unknown to OpenAI's model capability table. Explicitly enable
// reasoning option serialization, then select none for small bounded probes.
const common = { model, maxRetries: 0, maxOutputTokens: 512,
  system: 'You are a compatibility-test assistant. Follow the requested fixture output precisely.',
  providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: 'none' as const, systemMessageMode: 'system' as const } },
};
const signal = () => AbortSignal.any([globalAbort, AbortSignal.timeout(30_000)]);
const compatibleOutputSchema = jsonSchema<ReturnType<typeof agentResultSchema.parse>>(
  normalizeDeepSeekSchema(await zodSchema(agentResultSchema.required()).jsonSchema), {
    validate: value => {
      const result = agentResultSchema.safeParse(value);
      return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
    },
  });
function usage(value: { inputTokens?: number; outputTokens?: number }) {
  totalInput += value.inputTokens ?? 0; totalOutput += value.outputTokens ?? 0;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}
async function check(name: string, work: () => Promise<unknown>) {
  if (selectedCases.length && !selectedCases.includes(name)) return;
  currentCase = name; const started = performance.now();
  try {
    const details = await work();
    cases.push({ name, status: 'passed', elapsedMs: Math.round(performance.now() - started), details });
    console.log(`PASS ${name}`);
  } catch (error) {
    const value = error as { name?: string; statusCode?: number; cause?: { name?: string; message?: string }; responseBody?: string; actual?: unknown };
    // SDK errors may contain raw requests / auth headers. Do not dump them.
    let apiMessage: string | undefined;
    try { apiMessage = JSON.parse(value.responseBody ?? '{}').error?.message; } catch {}
    const safe = { name: value.name ?? 'Error', statusCode: value.statusCode, causeName: value.cause?.name,
      causeMessage: value.cause?.message?.replaceAll(key!, '[REDACTED]').slice(0, 200),
      apiMessage: apiMessage?.replaceAll(key!, '[REDACTED]').slice(0, 1000),
      actual: typeof value.actual === 'string' ? value.actual.replaceAll(key!, '[REDACTED]').slice(0, 200) : undefined };
    cases.push({ name, status: 'failed', elapsedMs: Math.round(performance.now() - started), error: safe });
    console.log(`FAIL ${name}: ${JSON.stringify(safe)}`);
    process.exitCode = 1;
  }
}
let toolCalls = 0;
const tools = { searchProducts: tool({ description: 'Search an isolated synthetic catalog for compatibility testing.', inputSchema: agentSearchSchema,
  execute: async input => { assert.equal(input.q, '兼容测试'); toolCalls++; return { items: [{ id: 'demo-product', name: '兼容测试杯', skus: [{ id: 'demo-sku', price: '19.00', available: true }] }], total: 1, hasMore: false }; },
}) };

try {
  await check('sdk-text', async () => {
    const result = await generateText({ ...common, abortSignal: signal(), prompt: 'Reply with exactly COMPAT_TEXT_OK.' });
    assert.equal(result.text.trim(), 'COMPAT_TEXT_OK');
    return { text: result.text, finishReason: result.finishReason, usage: usage(result.usage) };
  });
  await check('sdk-tool-roundtrip-stateless', async () => {
    const before = requests.length, calls = toolCalls;
    const result = await generateText({ ...common, abortSignal: signal(), tools, stopWhen: isStepCount(2),
      prepareStep: ({ stepNumber }) => ({ toolChoice: stepNumber === 0 ? { type: 'tool' as const, toolName: 'searchProducts' as const } : 'none' as const }),
      prompt: 'Call searchProducts with q="兼容测试". After receiving its result, reply exactly COMPAT_TOOL_OK:19.00. Do not invent a price.',
    });
    assert.equal(toolCalls - calls, 1); assert.equal(result.steps.length, 2);
    assert.equal(result.text.trim(), 'COMPAT_TOOL_OK:19.00');
    const sent = requests.slice(before); assert.ok(sent[1]?.inputTypes.includes('function_call_output'));
    assert.ok(sent.every(r => !r.hasPreviousResponseId && r.store === false));
    return { steps: result.steps.length, toolCalls: toolCalls - calls, fullHistorySent: true, usage: usage(result.totalUsage) };
  });
  await check('sdk-structured-agent-contract', async () => {
    const result = await generateText({ ...common, abortSignal: signal(), output: Output.object({ schema: compatibleOutputSchema }),
      prompt: 'Return content="COMPAT_JSON_OK", candidates=[], requirementChanges containing exactly one set operation: constraint key="budget", scope="global", level="hard", value={kind:"budget",min:null,max:"200"}, source={sequence:1,quote:"预算最多200"}. Do not add fields.',
    });
    const parsed = agentResultSchema.parse(result.output);
    assert.equal(parsed.content, 'COMPAT_JSON_OK'); assert.deepEqual(parsed.candidates, []); assert.equal(parsed.requirementChanges[0]?.op, 'set');
    return { validatedByBusinessSchema: true, disjointOneOfNormalized: true, nonemptyRequirementChange: true, usage: usage(result.usage) };
  });
  await check('sdk-stream-text', async () => {
    const index = requests.length;
    const result = streamText({ ...common, abortSignal: signal(), prompt: 'Reply with exactly COMPAT_STREAM_OK.', onError: () => {} });
    let output = '', deltas = 0;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') { output += part.text; deltas++; }
      if (part.type === 'error') throw part.error;
    }
    const canonical = await streamObservations.get(index);
    assert.ok(output.trim()); assert.ok(deltas > 0); assert.equal(canonical?.terminalType, 'response.completed');
    assert.equal(canonical.status, 'completed'); assert.equal(output, canonical.text, 'SDK delta assembly must match the terminal response');
    return { textDeltas: deltas, canonicalTextMatches: true, exactFixtureText: output.trim() === 'COMPAT_STREAM_OK', finishReason: await result.finishReason, usage: usage(await result.usage) };
  });
  await check('sdk-tool-and-structured-output', async () => {
    const calls = toolCalls;
    const result = await generateText({ ...common, abortSignal: signal(), tools, stopWhen: isStepCount(2), output: Output.object({ schema: compatibleOutputSchema }),
      prepareStep: ({ stepNumber }) => ({ toolChoice: stepNumber === 0 ? { type: 'tool' as const, toolName: 'searchProducts' as const } : 'none' as const }),
      prompt: 'First call searchProducts with q="兼容测试". Then return content="COMPAT_COMBINED_OK:19.00", candidates=[], requirementChanges=[]. Use the returned price.',
    });
    assert.equal(toolCalls - calls, 1); assert.equal(result.steps.length, 2);
    assert.equal(agentResultSchema.parse(result.output).content, 'COMPAT_COMBINED_OK:19.00');
    return { steps: result.steps.length, validatedByBusinessSchema: true, usage: usage(result.totalUsage) };
  });
  await check('sdk-stream-tool-roundtrip', async () => {
    const calls = toolCalls;
    const result = streamText({ ...common, abortSignal: signal(), tools, stopWhen: isStepCount(2), onError: () => {},
      prepareStep: ({ stepNumber }) => ({ toolChoice: stepNumber === 0 ? { type: 'tool' as const, toolName: 'searchProducts' as const } : 'none' as const }),
      prompt: 'Call searchProducts with q="兼容测试". After receiving the result, reply exactly COMPAT_STREAM_TOOL_OK:19.00.',
    });
    let streamedCalls = 0, streamedResults = 0, output = '';
    for await (const part of result.fullStream) {
      if (part.type === 'tool-call') streamedCalls++;
      if (part.type === 'tool-result') streamedResults++;
      if (part.type === 'text-delta') output += part.text;
      if (part.type === 'error') throw part.error;
    }
    assert.equal(toolCalls - calls, 1); assert.equal(streamedCalls, 1); assert.equal(streamedResults, 1);
    assert.equal(output.trim(), 'COMPAT_STREAM_TOOL_OK:19.00');
    return { streamedCalls, streamedResults, steps: (await result.steps).length, usage: usage(await result.totalUsage) };
  });
  await check('sdk-stream-cancel-after-first-delta', async () => {
    const controller = new AbortController(); let observedAbort = false, deltas = 0;
    const before = requests.length;
    const result = streamText({ ...common, abortSignal: AbortSignal.any([controller.signal, signal()]),
      prompt: 'Write the integers from 1 to 1000, separated by commas. Do not abbreviate.',
      onError: () => {},
      onAbort: () => { observedAbort = true; },
    });
    try {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') { deltas++; controller.abort(); }
        if (part.type === 'error' && !controller.signal.aborted) throw part.error;
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
    assert.ok(deltas > 0); assert.ok(controller.signal.aborted); assert.ok(observedAbort);
    assert.ok(requests[before]?.aborted);
    return { cancelledAfterTextDelta: true, requestAbortObserved: true, providerBillingAfterCancel: 'not-observable' };
  });
  assert.ok(requests.every(request => request.systemRole === 'system'), 'System messages must not be downgraded to developer/user');
} finally {
    const report = { testedAt: new Date().toISOString(), endpoint: base.origin, model: modelName, selectedCases,
    versions: { ai: require('ai/package.json').version, openaiProvider: require('@ai-sdk/openai/package.json').version, undici: require('undici/package.json').version },
    transport: 'explicit-direct-dispatcher', mode: 'synthetic-fixtures-only', currentCase, cases, requests,
    accountedUsage: { inputTokens: totalInput, outputTokens: totalOutput, excludesInterruptedRequest: true },
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/deepseek-compatibility.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: cases.filter(c => c.status === 'passed').length, failed: cases.filter(c => c.status === 'failed').length, requests: requests.length, accountedUsage: report.accountedUsage }));
  await dispatcher.destroy();
}

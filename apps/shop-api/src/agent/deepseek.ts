import { createOpenAI } from '@ai-sdk/openai';
import { generateText, tool, isStepCount, Output, jsonSchema, zodSchema } from 'ai';
import { agentReplySchema, agentRequirementProposalSchema, agentToolSchemas, requirementChangesSchema, type AgentToolName } from '@shop/contracts';
import type { AgentModel } from '../chat/agent-runtime.ts';
import { requirementQuery } from '../chat/agent-memory.ts';
import { HttpError } from '../auth/index.ts';
import { normalizeDeepSeekSchema } from './schema.ts';
import { ModelBudget, MODEL_LIMITS } from './budget.ts';
import { boundedFetch, createDirectTransport, officialEndpoint, type WireFetch } from './transport.ts';
import { EXTRACTION_PROMPT, REPLY_PROMPT } from './prompts.ts';

async function wireSchema<T>(schema: Parameters<typeof zodSchema<T>>[0], parse: (value: unknown) => T) {
  return jsonSchema<T>(normalizeDeepSeekSchema(await zodSchema(schema).jsonSchema), {
    validate: value => {
      try { return { success: true, value: parse(value) }; }
      catch (error) { return { success: false, error: error as Error }; }
    },
  });
}
const extractionSchema = wireSchema(agentRequirementProposalSchema, value => agentRequirementProposalSchema.parse(value)), replySchema = wireSchema(agentReplySchema, value => agentReplySchema.parse(value));
const descriptions: Record<AgentToolName, string> = {
  listCategories: '查询本店启用分类，支持关键词和分页', listTags: '查询本店启用标签，支持关键词和分页', getFilters: '查询本店可筛选属性、类型、单位、枚举值，支持关键词和分页',
  searchProducts: '先按本轮要求查询本店商品；原关键词查询 total=0 时，可保持 q 原词并携带 relatedTerms（1至3个近义、下位或同用途商品词）再查询一次；扩展仍保留全部其他硬条件；hasMore表示还有后续页',
  getProductDetails: '查询本店指定商品/规格详情；商品与SKU须匹配；支持规格分页', handoffToSeller: '仅把当前接待转入人工队列；无法指定客服；调用后停止自动回复',
};
export function createDeepSeekModel(options: { apiKey?: string; baseURL?: string; model?: string; transport?: WireFetch; estimate?: (body: string) => number } = {}): AgentModel {
  const key = options.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error('DEEPSEEK_API_KEY is required in deepseek mode');
  const baseURL = officialEndpoint(options.baseURL ?? process.env.DEEPSEEK_BASE_URL);
  const modelName = options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
  if (modelName !== 'deepseek-flash') throw new Error('Only the verified deepseek-flash model is enabled');
  return async context => {
    const direct = options.transport ? undefined : createDirectTransport(), budget = new ModelBudget(options.estimate);
    let outcome = 'failed', handedOff = false, catalogRead = false, canExpand = false, expanded = false, toolFailure: unknown, transportFailure: unknown, extracting = true;
    let originalKeyword: string | undefined;
    const read = boundedFetch(options.transport ?? direct!.fetch, budget, context.signal, context.deadline);
    const provider = createOpenAI({ apiKey: key, baseURL, fetch: async (input, init) => {
      try { await context.assertActive(); return await read(input, init); }
      catch (error) { transportFailure = error; throw error; }
    } });
    const model = provider.responses(modelName);
    const common = { model, maxRetries: 0, maxOutputTokens: MODEL_LIMITS.output, abortSignal: context.signal,
      timeout: { totalMs: Math.max(1, context.deadline - Date.now()), stepMs: MODEL_LIMITS.requestMs, toolMs: 5000 },
      providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: 'none' as const, systemMessageMode: 'system' as const, parallelToolCalls: false } },
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      toolCallConcurrency: 1,
      onStepEnd: (step: { toolCalls: readonly { invalid?: boolean }[]; content: readonly { type: string }[] }) => {
        if (step.toolCalls.some(call => call.invalid) || step.content.some(part => part.type === 'tool-error')) {
          toolFailure ??= new HttpError(403, 'AGENT_TOOL_REJECTED', '自动导购工具请求不合法');
          throw toolFailure;
        }
      },
    };
    // Capture tool failures outside SDK error-result handling: the model cannot
    // silently recover from a server-side permission/limit failure and commit.
    const tools = Object.fromEntries((Object.keys(agentToolSchemas) as AgentToolName[]).map(name => [name, tool({ description: descriptions[name], inputSchema: zodSchema<unknown>(agentToolSchemas[name]), execute: async (input: unknown) => {
      try {
        const result = await context.call(name, input);
        if (name === 'handoffToSeller') handedOff = true;
        if (name === 'searchProducts' || name === 'getProductDetails') {
          catalogRead = true;
          const search = input as { q?: string; relatedTerms?: string[] };
          if (search.relatedTerms) expanded = true;
          canExpand = name === 'searchProducts' && !expanded && !!originalKeyword && search.q === originalKeyword && (result as { total?: number }).total === 0;
        }
        if (!handedOff) await context.reportProgress?.(extracting ? 'understanding' : 'composing');
        return result;
      }
      catch (error) { toolFailure = error; throw new Error('Shop tool unavailable'); }
    } })]));
    try {
      const latest = context.messages.at(-1)!;
      if (/^(?:请|帮我)?(?:转人工|找人工(?:客服)?|人工客服)[！!。\s]*$/.test(latest.content.trim())) {
        await context.call('handoffToSeller', { reason: 'user_request', question: latest.content.slice(0, 1000) });
        handedOff = true; outcome = 'handoff'; return { content: '正在转交人工', requirementChanges: [] };
      }
      await context.reportProgress?.('understanding');
      const prepared = await generateText({ ...common, system: EXTRACTION_PROMPT,
        prompt: JSON.stringify({ pendingBuyerMessages: context.messages, requirements: context.requirements, history: context.history, historyIncomplete: context.historyIncomplete, summaryKind: context.summaryKind }),
        tools: { listCategories: tools.listCategories!, listTags: tools.listTags!, getFilters: tools.getFilters! },
        stopWhen: [isStepCount(3), () => !!toolFailure],
        prepareStep: ({ stepNumber }) => ({ ...(stepNumber === 2 ? { toolChoice: 'none' as const, activeTools: [] } : {}) }),
        output: Output.object({ schema: await extractionSchema }),
      });
      if (toolFailure) throw toolFailure;
      const changes = requirementChangesSchema.parse(prepared.output.requirementChanges);
      // A selected product is a trusted buyer action. Do not let a missed model
      // extraction silently turn a product-specific consultation into all-shop.
      const selected = [...context.messages].reverse().find(m => m.productId);
      if (selected && !changes.some(c => c.op === 'product' || c.op === 'reset' || (c.op === 'set' && ['keyword', 'category'].includes(c.constraint.value.kind)))) changes.unshift({ op: 'product', productId: selected.productId, skuId: selected.skuId, source: { sequence: selected.sequence, quote: selected.content.slice(0, 160) } });
      const requirements = await context.validateRequirements(changes), { query, blocked } = requirementQuery(requirements);
      if (blocked.length) { outcome = 'clarification'; return { content: '本轮有尚未核实或相互冲突的要求，请补充说明或选择转人工。', candidates: [], requirementChanges: changes }; }
      originalKeyword = requirements.productScope ? undefined : query.q;
      extracting = false;
      await context.reportProgress?.('composing');
      const result = await generateText({ ...common, system: REPLY_PROMPT,
        prompt: JSON.stringify({ requirements, suggestedQuery: query, pendingBuyerMessages: context.messages, history: context.history, historyIncomplete: context.historyIncomplete, summaryKind: context.summaryKind }),
        tools, stopWhen: [isStepCount(5), () => handedOff || !!toolFailure],
        // Keep one physical request for a final structured reply. The HTTP gate
        // also counts retries and the extraction phase against the same budget.
        prepareStep: () => {
          if (budget.requests >= MODEL_LIMITS.requests - 2) return { toolChoice: 'none' as const, activeTools: [] };
          if (catalogRead && canExpand) return { activeTools: ['searchProducts', 'handoffToSeller'] };
          return catalogRead ? { toolChoice: 'none' as const, activeTools: [] } : {};
        },
        output: Output.object({ schema: await replySchema }),
      });
      if (toolFailure) throw toolFailure;
      if (handedOff) { outcome = 'handoff'; return { content: '正在转交人工' }; }
      const reply = agentReplySchema.parse(result.output);
      outcome = 'completed'; return { ...reply, requirementChanges: changes };
    } catch (error) {
      if (handedOff) { outcome = 'handoff'; return { content: '正在转交人工' }; }
      if (context.signal.aborted) { outcome = 'cancelled'; throw new HttpError(409, 'AGENT_RUN_STALE', '导购任务已失效'); }
      const safeError = toolFailure ?? transportFailure ?? error;
      if (safeError instanceof HttpError) { outcome = safeError.code; throw safeError; }
      // No raw SDK errors escape: they may contain credentials/request bodies.
      outcome = 'AGENT_MODEL_INVALID'; throw new HttpError(502, 'AGENT_MODEL_INVALID', '自动导购暂时无法完成回答');
    } finally { context.audit({ ...budget.snapshot(), outcome }); await direct?.close(); }
  };
}

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import { chatSuggestionSchema, chatSuggestionOutputSchema, agentToolSchemas, uuidSchema, type ChatSuggestionDto, type ChatProgressDto, type ChatProgressPhase } from '@shop/contracts';
import { HttpError } from '../auth/index.ts';
import { requireShop } from '../shops/access.ts';
import { canReadRound } from './access.ts';
import { createAgentCatalog } from './agent-catalog.ts';
import { receptionContext } from './reception-context.ts';
import type { AgentOptions } from './agent-runtime.ts';
import { toolPhase } from './live.ts';

type Tx = Prisma.TransactionClient;
export type CopilotTool = Exclude<keyof typeof agentToolSchemas, 'handoffToSeller'>;
export interface CopilotContext {
  history: { role: string; content: string; productId: string | null; skuId: string | null }[];
  historyIncomplete: boolean; requirements: string[]; unresolved: string[];
  signal: AbortSignal; deadline: number; assertActive: () => Promise<void>;
  call: (name: CopilotTool, input: unknown) => Promise<unknown>;
  audit: (data: Record<string, number | string>) => void;
  reportProgress?: (phase: ChatProgressPhase) => Promise<void>;
}
export type CopilotModel = (context: CopilotContext) => Promise<unknown>;
const stale = () => new HttpError(409, 'CHAT_SUGGESTION_STALE', '咨询或消息已更新，请查看后重新生成建议');
const mock: CopilotModel = async context => {
  await context.assertActive();
  const selected = [...context.history].reverse().find(r => r.productId);
  if (selected) await context.call('getProductDetails', { ids: [selected.productId], ...(selected.skuId ? { skuIds: [selected.skuId] } : {}) });
  return { content: '你好，我来继续为你核对商品信息。请确认你需要的规格和数量，我会根据当前商品资料为你说明。' };
};
export function registerReceptionAssist(app: FastifyInstance, db: PrismaClient, options: AgentOptions,
  authorize: (tx: Tx, request: FastifyRequest, shopId: string, seller: boolean) => Promise<string | undefined>, notify = () => {}) {
  const model = options.copilotModel ?? (options.mode === 'mock' ? mock : undefined);
  const concurrency = Math.min(Math.max(options.copilotConcurrency ?? 2, 1), 2);
  type Draft = ChatSuggestionDto & { userId: string; sessionKey: string; shopId: string; roundId: string; used: boolean };
  const drafts = new Map<string, Draft>(), running = new Set<AbortController>(), rates = new Map<string, number[]>(), actors = new Set<string>();
  const progresses = new Map<AbortController, { sessionKey: string; userId: string; roundId: string; version: string; sequence: number; value: ChatProgressDto }>();
  let stopped = false;
  const guard = requireShop(db, 'catalog:read');
  const idOf = (request: FastifyRequest) => uuidSchema.parse((request.params as { id: string }).id).toLowerCase();
  async function snapshot<T>(request: FastifyRequest, id: string, work: (tx: Tx, round: Prisma.ConversationGetPayload<{}>, role: string | undefined) => Promise<T>) {
    return db.$transaction(async tx => {
      const role = await authorize(tx, request, request.shopId!, true);
      const initial = await tx.conversation.findFirst({ where: { id, shop_id: request.shopId! } });
      if (!initial) throw new HttpError(404, 'CHAT_NOT_FOUND', '咨询不存在或不可访问');
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${initial.channel_id}::uuid FOR SHARE`;
      const round = await tx.conversation.findUniqueOrThrow({ where: { id } });
      if (!canReadRound(round, request.identity!.userId, role)) throw new HttpError(404, 'CHAT_NOT_FOUND', '咨询不存在或不可访问');
      return work(tx, round, role);
    }, { timeout: 5000, maxWait: 5000 });
  }
  app.get('/api/seller/chat/rounds/:id/context', { preHandler: guard }, request => snapshot(request, idOf(request), async (tx, round) => receptionContext(tx, round, !!model && round.status === 'seller' && round.assigned_seller_id === request.identity!.userId)));
  app.post('/api/seller/chat/rounds/:id/suggestions', { preHandler: guard }, async (request, reply) => {
    const input = chatSuggestionSchema.parse(request.body), id = idOf(request);
    const assertSnapshot = async (tx: Tx, round: Prisma.ConversationGetPayload<{}>) => {
      if (stopped || round.status !== 'seller' || round.assigned_seller_id !== request.identity!.userId) throw new HttpError(403, 'CHAT_NOT_ASSIGNED', '只有当前人工负责人可以生成建议');
      const channel = await tx.chatChannel.findUniqueOrThrow({ where: { id: round.channel_id } });
      if (round.updated_at.toISOString() !== input.version || channel.next_sequence !== input.lastSequence) throw stale();
    };
    const context = await snapshot(request, id, async (tx, round) => {
      await assertSnapshot(tx, round);
      const summary = await receptionContext(tx, round, !!model);
      const rows = await tx.message.findMany({ where: { conversation_id: id, sender_type: { in: ['buyer', 'seller', 'agent'] } }, orderBy: { sequence: 'desc' }, take: 13 });
      const history = rows.slice(0, 12).reverse().map(row => {
        const product = row.product_context as { id?: string; skuId?: string } | null;
        return { role: row.sender_type, content: row.content, productId: product?.id ?? null, skuId: product?.skuId ?? null };
      });
      if (history.reduce((n, r) => n + Buffer.byteLength(r.content), 0) > 24000) throw new HttpError(422, 'CHAT_SUGGESTION_CONTEXT_LIMIT', '近期内容过多，请手动回复');
      return { history, historyIncomplete: rows.length > 12, requirements: summary.requirements, unresolved: summary.unresolved };
    });
    if (!model) throw new HttpError(503, 'CHAT_SUGGESTIONS_DISABLED', '建议回复暂未启用，可直接手动回复');
    const actor = request.identity!.userId, rateKey = `${request.shopId!}:${actor}`, now = Date.now();
    for (const [key, values] of rates) if (values.every(t => t <= now - 60000)) rates.delete(key);
    const recent = (rates.get(rateKey) ?? []).filter(t => t > now - 60000);
    if (running.size >= concurrency || actors.has(rateKey)) throw new HttpError(429, 'CHAT_SUGGESTIONS_BUSY', '建议生成繁忙，请稍后重试');
    if (recent.length >= 3 || (!rates.has(rateKey) && rates.size >= 1000)) throw new HttpError(429, 'CHAT_SUGGESTIONS_RATE', '生成过于频繁，请稍后再试');
    rates.set(rateKey, [...recent, now]); actors.add(rateKey);
    for (const [key, value] of drafts) if (Date.parse(value.expiresAt) <= now) drafts.delete(key);
    if (drafts.size >= 200) { actors.delete(rateKey); throw new HttpError(503, 'CHAT_SUGGESTIONS_CAPACITY', '建议暂时已满，请手动回复'); }
    const controller = new AbortController(), deadline = now + Math.min(options.copilotTimeoutMs ?? 25000, 25000), catalog = createAgentCatalog(request.shopId!);
    running.add(controller);
    let reason: HttpError | undefined, tools = 0, toolBusy = false, checking = false, toolFailure: unknown;
    const abort = (error: HttpError) => { reason ??= error; controller.abort(); };
    const assertActive = async () => {
      if (controller.signal.aborted) throw reason ?? stale();
      await snapshot(request, id, assertSnapshot);
      if (controller.signal.aborted || Date.now() >= deadline) throw reason ?? stale();
    };
    const timeout = setTimeout(() => abort(new HttpError(504, 'CHAT_SUGGESTIONS_TIMEOUT', '建议生成超时，请手动回复或稍后重试')), Math.max(1, deadline - Date.now()));
    const timer = setInterval(() => {
      if (checking) return; checking = true;
      void assertActive().catch(() => abort(stale())).finally(() => { checking = false; });
    }, 1000);
    const closed = () => { if (!reply.raw.writableEnded) abort(stale()); };
    reply.raw.on('close', closed);
    let abortListener: (() => void) | undefined;
    const entry = { sessionKey: request.sessionKey!, userId: actor, roundId: id, version: input.version, sequence: input.lastSequence,
      value: { kind: 'suggestion', phase: 'understanding', startedAt: new Date().toISOString(), requestId: input.requestId ?? randomUUID() } as ChatProgressDto };
    progresses.set(controller, entry); notify();
    const reportProgress = async (phase: ChatProgressPhase) => {
      await assertActive();
      entry.value = { ...entry.value, phase, ...(['filters', 'searching', 'details'].includes(phase) ? { lastAction: phase as ChatProgressDto['lastAction'] } : {}) }; notify();
    };
    try {
      const aborted = new Promise<never>((_, reject) => { abortListener = () => reject(reason ?? stale()); controller.signal.addEventListener('abort', abortListener, { once: true }); if (controller.signal.aborted) abortListener(); });
      const raw = await Promise.race([model({ ...structuredClone(context), signal: controller.signal, deadline, assertActive, reportProgress,
        audit: data => app.log.info({ ...data, feature: 'reception-copilot' }, 'copilot model usage'),
        call: async (name, raw) => {
          try {
            if (toolBusy || ++tools > 5 || !['listCategories', 'listTags', 'getFilters', 'searchProducts', 'getProductDetails'].includes(name)) throw new HttpError(403, 'CHAT_SUGGESTION_TOOL', '该操作不属于建议回复的只读工具');
            toolBusy = true;
            await assertActive();
            const parsed = agentToolSchemas[name].parse(raw);
            await reportProgress(toolPhase(name));
            const result = await snapshot(request, id, async (tx, round) => {
              await assertSnapshot(tx, round);
              if (name === 'searchProducts') return catalog.search(tx, parsed);
              if (name === 'getProductDetails') return catalog.details(tx, parsed);
              return catalog.lookup(tx, name, parsed);
            });
            await assertActive(); await reportProgress('composing'); return result;
          } catch (error) { toolFailure = error; throw error; }
          finally { toolBusy = false; }
        },
      }), aborted]);
      if (toolFailure) throw toolFailure;
      await reportProgress('checking');
      const output = chatSuggestionOutputSchema.parse(raw);
      await assertActive();
      if (drafts.size >= 200) throw new HttpError(503, 'CHAT_SUGGESTIONS_CAPACITY', '建议暂时已满，请手动回复');
      // No await between final authority check and insertion into private memory.
      const draft: Draft = { id: randomUUID(), content: output.content, ...input, expiresAt: new Date(Date.now() + 300000).toISOString(), userId: actor, sessionKey: request.sessionKey!, shopId: request.shopId!, roundId: id, used: false };
      drafts.set(draft.id, draft);
      return { id: draft.id, content: draft.content, version: draft.version, lastSequence: draft.lastSequence, expiresAt: draft.expiresAt };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'CHAT_SUGGESTIONS_FAILED', '建议暂时无法生成，可直接手动回复');
    } finally {
      clearTimeout(timeout); clearInterval(timer); reply.raw.off('close', closed);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      controller.abort(); running.delete(controller); actors.delete(rateKey);
      progresses.delete(controller); notify();
    }
  });
  app.addHook('preClose', async () => { stopped = true; for (const controller of running) controller.abort(); drafts.clear(); rates.clear(); });
  return {
    progress(request: FastifyRequest, round: Prisma.ConversationGetPayload<{}>, sequence: number): ChatProgressDto | null {
      if (round.status !== 'seller' || round.assigned_seller_id !== request.identity!.userId) return null;
      for (const [controller, entry] of progresses) if (!controller.signal.aborted && entry.sessionKey === request.sessionKey && entry.userId === request.identity!.userId && entry.roundId === round.id && entry.version === round.updated_at.toISOString() && entry.sequence === sequence) return entry.value;
      return null;
    },
    async check(tx: Tx, request: FastifyRequest, round: Prisma.ConversationGetPayload<{}>, id?: string) {
      if (!id) return;
      const draft = drafts.get(id);
      if (!draft || draft.used || draft.userId !== request.identity!.userId || draft.sessionKey !== request.sessionKey || draft.shopId !== request.shopId || draft.roundId !== round.id || Date.parse(draft.expiresAt) <= Date.now()) throw stale();
      const channel = await tx.chatChannel.findUniqueOrThrow({ where: { id: round.channel_id } });
      if (draft.version !== round.updated_at.toISOString() || draft.lastSequence !== channel.next_sequence) throw stale();
    },
    consume(id?: string) { if (id) { const draft = drafts.get(id); if (draft) draft.used = true; } },
  };
}

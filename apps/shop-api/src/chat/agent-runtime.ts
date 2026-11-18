import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import { agentHandoffSchema, agentResultSchema, agentToolSchemas, type AgentToolName, type RequirementState, type ChatProgressDto, type ChatProgressPhase } from '@shop/contracts';
import { HttpError } from '../auth/index.ts';
import { nextStamp } from '../transactions/locks.ts';
import { append } from './storage.ts';
import { lockDispatch } from './dispatch.ts';
import { createAgentCatalog } from './agent-catalog.ts';
import { buildMemoryContext, filterRequirementCards, finalizeRequirements, loadRequirements, mergeRequirements, requirementQuery, validateRequirementReferences, type MemoryMessage } from './agent-memory.ts';
import { mockRequirementChanges } from './agent-mock-memory.ts';
import { toolPhase } from './live.ts';

type Tx = Prisma.TransactionClient;
export interface AgentContext {
  // No buyer identity, login cookie, service credential or arbitrary history.
  messages: { sequence: number; content: string; productId: string | null; skuId: string | null }[];
  requirements: RequirementState;
  history: MemoryMessage[];
  historyIncomplete: boolean;
  summaryKind: 'active-requirements-only';
  signal: AbortSignal;
  deadline: number;
  assertActive: () => Promise<void>;
  validateRequirements: (changes: unknown) => Promise<RequirementState>;
  audit: (data: { requests: number; reservedTokens: number; knownInputTokens: number; knownOutputTokens: number; unknownRequests: number; outcome: string }) => void;
  call: (name: AgentToolName, input: unknown) => Promise<unknown>;
  reportProgress?: (phase: ChatProgressPhase) => Promise<void>;
}
export type AgentModel = (context: AgentContext) => Promise<unknown>;
export interface AgentOptions { copilotModel?: import('./reception-assist.ts').CopilotModel; copilotTimeoutMs?: number; copilotConcurrency?: number; recoverReceptionOnStart?: boolean; mode?: 'disabled' | 'mock' | 'deepseek'; model?: AgentModel; runTimeoutMs?: number; toolLimit?: number; queueLimit?: number; concurrency?: number; recoverOnStart?: boolean; recoveryShopIds?: string[] }
type Scope = { shopId: string; channelId: string; buyerId: string; roundId: string; runId: string; generation: number; trigger: number; version: string; deadline: number };
const stale = () => new HttpError(409, 'AGENT_RUN_STALE', '导购任务已失效');

// A deterministic integration fixture, not a natural-language model or a custom
// production tool loop. Real provider orchestration will use the selected SDK.
export const mockAgentModel: AgentModel = async ({ messages, requirements, call, signal, reportProgress }) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 150);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(stale()); }, { once: true });
  });
  const latest = messages.at(-1)!;
  if (/转人工|人工客服|找客服/.test(latest.content)) { await call('handoffToSeller', { reason: 'user_request', question: latest.content.slice(0, 1000) }); return { content: '正在转交人工客服' }; }
  const requirementChanges = mockRequirementChanges(messages);
  const proposed = mergeRequirements(requirements, requirementChanges, messages, latest.sequence), { query, blocked } = requirementQuery(proposed);
  if (blocked.length) return { content: '已记录本轮要求，其中有条件尚未核实或存在冲突，暂时无法确认匹配的商品。可以继续补充或选择转人工。', requirementChanges };
  const product = proposed.productScope;
  const result = product
    ? await call('getProductDetails', { ids: [product.productId], ...(product.skuId ? { skuIds: [product.skuId] } : {}) })
    : await call('searchProducts', query);
  await reportProgress?.('composing');
  const items = (result as { items: { name: string; skus: { id: string; available: boolean }[] }[] }).items;
  const candidates = items.flatMap((p) => p.skus.filter((s) => s.available).slice(0, 1).map((s) => ({ skuId: s.id, reason: '可查看此规格的商品资料' }))).slice(0, 6);
  return { content: candidates.length ? '已查到当前可售的商品规格，可以点击卡片查看详情。你也可以继续咨询，或选择转人工。' : '本次查询没有找到可售规格。可以调整关键词，或选择转人工进一步咨询。', candidates, requirementChanges };
};

export function createAgentRuntime(app: FastifyInstance, db: PrismaClient, dispatch: { run: (shopId: string) => Promise<void> }, options: AgentOptions = {}, notify = () => {}) {
  if (options.mode === 'deepseek' && !options.model) throw new Error('DeepSeek mode requires the bounded provider adapter');
  const enabled = options.mode === 'mock' || options.mode === 'deepseek', model = options.model ?? mockAgentModel;
  const runMs = Math.min(Math.max(options.runTimeoutMs ?? 60000, 20), 60000);
  const toolLimit = Math.min(Math.max(options.toolLimit ?? 8, 1), 8), queueLimit = Math.min(Math.max(options.queueLimit ?? 20, 1), 20), concurrency = Math.min(Math.max(options.concurrency ?? 2, 1), 2);
  type Job = { scope: Scope; controller: AbortController; progress?: ChatProgressDto };
  const jobs = new Map<string, Job>();
  // Admission authority belongs to this shop service instance. A second test or
  // API process may see the row, but cannot mint a capability for its run.
  const issued = new Map<string, string>();
  const rates = new Map<string, number[]>();
  let pumping = false, stopped = false;
  const running = new Set<string>();
  const flights = new Set<Promise<void>>();
  async function locked<T>(scope: Scope, work: (tx: Tx) => Promise<T>, allowExpired = false) {
    if (stopped) throw stale();
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${scope.shopId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM users WHERE id=${scope.buyerId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${scope.channelId}::uuid FOR UPDATE`;
      const round = await tx.conversation.findUnique({ where: { id: scope.roundId }, include: { shop: true, buyer: true } });
      if (!round || round.status !== 'agent' || round.assigned_seller_id || round.shop_id !== scope.shopId || round.channel_id !== scope.channelId || round.buyer_id !== scope.buyerId
        || issued.get(scope.roundId) !== scope.runId || round.agent_run_id !== scope.runId || round.agent_generation !== scope.generation || round.agent_trigger_sequence !== scope.trigger || round.updated_at.toISOString() !== scope.version
        || stopped || !['queued', 'running'].includes(round.agent_run_status) || (!allowExpired && Date.now() >= scope.deadline)
        || round.shop.status !== 'active' || round.buyer.status !== 'active' || round.buyer.account_kind !== 'customer' || round.buyer.platform_role !== 'user') throw stale();
      const result = await work(tx);
      if (stopped || (!allowExpired && Date.now() >= scope.deadline)) throw stale();
      return result;
    }, { timeout: 5000, maxWait: 5000 });
  }
  // This is a trusted shop operation, not a generic model write. Buyer buttons
  // and manager takeovers do not depend on the model or its remaining budget.
  async function handoff(tx: Tx, roundId: string, raw: unknown) {
    const input = agentHandoffSchema.parse(raw), round = await tx.conversation.findUniqueOrThrow({ where: { id: roundId } });
    if (round.status !== 'agent') return;
    const trigger = await tx.message.findFirstOrThrow({ where: { conversation_id: roundId, sender_type: 'buyer' }, orderBy: { sequence: 'desc' } });
    await tx.conversation.update({ where: { id: roundId }, data: { status: 'waiting_seller', agent_run_status: 'cancelled', agent_generation: { increment: 1 }, updated_at: nextStamp(round) } });
    await tx.inquiry.create({ data: { conversation_id: roundId, trigger_message_id: trigger.id, question: input.question, reason: input.reason } });
    await append(tx, round.channel_id, roundId, input.reason === 'agent_failure' ? '自动导购暂时无法继续，已转入人工等待队列。' : '已转入人工等待队列，客服接入后会在这里回复。', { sender_type: 'system', event_data: { type: 'agent_handoff', reason: input.reason, ...(input.summary ? { summary: input.summary } : {}) } });
  }
  function cancel(roundId: string) { const job = jobs.get(roundId); job?.controller.abort(); if (job && !running.has(job.scope.runId)) jobs.delete(roundId); }
  async function queue(tx: Tx, roundId: string, trigger: number) {
    const round = await tx.conversation.findUniqueOrThrow({ where: { id: roundId } });
    if (!enabled || round.status !== 'agent') return;
    // Raw SQL deliberately leaves the human control version unchanged.
    const runId = randomUUID(), deadline = new Date(Date.now() + runMs);
    await tx.$executeRaw`UPDATE conversations SET agent_generation=agent_generation+1, agent_trigger_sequence=${trigger}, agent_run_id=${runId}::uuid, agent_run_status='queued', agent_deadline=${deadline} WHERE id=${roundId}::uuid`;
    issued.set(roundId, runId);
  }
  async function activate(tx: Tx, roundId: string) {
    if (!enabled) return;
    const initial = await tx.conversation.findUnique({ where: { id: roundId } }); if (!initial) return;
    await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${initial.channel_id}::uuid FOR UPDATE`;
    const round = await tx.conversation.findUniqueOrThrow({ where: { id: roundId } });
    if (round.status !== 'waiting_seller' || round.assigned_seller_id) return;
    // Called in the dispatch transaction after older queued inquiries. Holding
    // the same shop dispatch lock makes human capacity and fallback one decision.
    await tx.inquiry.deleteMany({ where: { conversation_id: roundId, status: 'pending' } });
    await tx.conversation.update({ where: { id: roundId }, data: { status: 'agent', updated_at: nextStamp(round) } });
    const trigger = await tx.message.findFirstOrThrow({ where: { conversation_id: roundId, sender_type: 'buyer' }, orderBy: { sequence: 'desc' } });
    await queue(tx, roundId, trigger.sequence);
  }

  async function failure(scope: Scope, content: string, toHuman = false) {
    try {
      await locked(scope, async (tx) => {
        if (toHuman) await handoff(tx, scope.roundId, { reason: 'agent_failure', question: '自动导购未能完成本次咨询，请人工继续处理' });
        else {
          await tx.$executeRaw`UPDATE conversations SET agent_run_status='failed' WHERE id=${scope.roundId}::uuid`;
          await append(tx, scope.channelId, scope.roundId, content, { sender_type: 'system' });
        }
      }, true);
      if (toHuman) await dispatch.run(scope.shopId);
    } catch (err) { if (!(err instanceof HttpError && err.code === 'AGENT_RUN_STALE')) app.log.error({ err }, 'agent failure notice deferred'); }
  }
  async function execute(job: Job) {
    const { scope, controller } = job, catalog = createAgentCatalog(scope.shopId); let tools = 0, terminal = false, toolBusy = false;
    const timeout = setTimeout(() => controller.abort(), Math.max(1, scope.deadline - Date.now()));
    let abortListener: (() => void) | undefined;
    const reportProgress = async (phase: ChatProgressPhase) => {
      await locked(scope, async () => undefined);
      if (controller.signal.aborted || jobs.get(scope.roundId) !== job) throw stale();
      job.progress = { kind: 'guide', phase, startedAt: job.progress?.startedAt ?? new Date().toISOString(),
        ...(['filters', 'searching', 'details'].includes(phase) ? { lastAction: phase as ChatProgressDto['lastAction'] } : job.progress?.lastAction ? { lastAction: job.progress.lastAction } : {}) };
      notify();
    };
    try {
      const inputContext = await locked(scope, async (tx) => {
        await tx.$executeRaw`UPDATE conversations SET agent_run_status='running' WHERE id=${scope.roundId}::uuid`;
        const row = await tx.conversation.findUniqueOrThrow({ where: { id: scope.roundId } });
        const rows = await tx.message.findMany({ where: { conversation_id: scope.roundId, sender_type: 'buyer', sequence: { gt: row.agent_covered_sequence, lte: scope.trigger } }, orderBy: { sequence: 'asc' }, take: 21 });
        if (rows.length > 20 || rows.reduce((n, r) => n + Buffer.byteLength(r.content), 0) > 24000) throw new HttpError(422, 'AGENT_CONTEXT_LIMIT', '待处理内容过多，请转人工继续咨询');
        const messages = rows.map((r) => {
          const p = r.product_context as { id?: string; skuId?: string } | null;
          return { sequence: r.sequence, content: r.content, productId: p?.id ?? null, skuId: p?.skuId ?? null };
        });
        const requirements = loadRequirements(row.requirement_state, row.agent_covered_sequence);
        const recent = await tx.message.findMany({ where: { conversation_id: scope.roundId, sender_type: { in: ['buyer', 'agent', 'seller'] }, sequence: { lte: scope.trigger, gt: requirements.resetThroughSequence } }, orderBy: { sequence: 'desc' }, take: 21 });
        const earliest = recent.at(-1)?.sequence ?? scope.trigger;
        const omitted = await tx.message.count({ where: { conversation_id: scope.roundId, sender_type: { in: ['buyer', 'agent', 'seller'] }, sequence: { lt: earliest, gt: requirements.resetThroughSequence } } });
        const history = recent.reverse().map((r): MemoryMessage => {
          const p = r.product_context as { id?: string; skuId?: string } | null;
          return { sequence: r.sequence, content: r.content, productId: p?.id ?? null, skuId: p?.skuId ?? null, role: r.sender_type as MemoryMessage['role'] };
        });
        return { messages, baseline: requirements, ...buildMemoryContext(requirements, history, messages, omitted) };
      });
      await reportProgress('understanding');
      let validatedRequirements: RequirementState | undefined;
      const call: AgentContext['call'] = async (name, raw) => {
        if (terminal || controller.signal.aborted || toolBusy) throw stale();
        if (++tools > toolLimit) throw new HttpError(429, 'AGENT_TOOL_LIMIT', '本次查询已达上限，请缩小范围或转人工');
        if (!Object.hasOwn(agentToolSchemas, name)) throw new HttpError(403, 'AGENT_TOOL_FORBIDDEN', '此操作不属于导购工具');
        const input = agentToolSchemas[name].parse(raw);
        toolBusy = true;
        try {
          if (name !== 'handoffToSeller') await reportProgress(toolPhase(name));
          const value = await locked(scope, async (tx) => {
            if (name === 'handoffToSeller') { await handoff(tx, scope.roundId, input); return { status: 'waiting_seller' }; }
            if (name === 'searchProducts') return catalog.search(tx, input, validatedRequirements);
            if (name === 'getProductDetails') return catalog.details(tx, input);
            return catalog.lookup(tx, name, input);
          });
          if (name === 'handoffToSeller') { terminal = true; await dispatch.run(scope.shopId); }
          // Do not return old product facts to a superseded model run.
          else await locked(scope, async () => undefined);
          notify();
          return value;
        } finally { toolBusy = false; }
      };
      const aborted = new Promise<never>((_, reject) => { abortListener = () => reject(stale()); controller.signal.addEventListener('abort', abortListener, { once: true }); if (controller.signal.aborted) abortListener(); });
      const validateRequirements: AgentContext['validateRequirements'] = async changes => locked(scope, async tx => {
        const next = mergeRequirements(inputContext.baseline, changes, inputContext.messages, scope.trigger);
        await validateRequirementReferences(tx, scope.shopId, changes as Parameters<typeof validateRequirementReferences>[2]);
        validatedRequirements = structuredClone(next);
        return next;
      });
      // The adapter receives copies. Mutating model input cannot alter the
      // authoritative baseline, source messages or the later commit validation.
      const raw = await Promise.race([model({ ...structuredClone({ messages: inputContext.messages, requirements: inputContext.requirements, history: inputContext.history, historyIncomplete: inputContext.historyIncomplete, summaryKind: inputContext.summaryKind }), call, signal: controller.signal, deadline: scope.deadline,
        assertActive: () => locked(scope, async () => undefined), validateRequirements, reportProgress,
        audit: data => app.log.info({ runId: scope.runId, ...data }, 'agent model usage'),
      }), aborted]);
      if (terminal) return;
      await reportProgress('checking');
      const output = agentResultSchema.parse(raw);
      if (tools > toolLimit) throw new HttpError(429, 'AGENT_TOOL_LIMIT', '本次查询已达上限');
      await locked(scope, async (tx) => {
        const row = await tx.conversation.findUniqueOrThrow({ where: { id: scope.roundId } });
        const previous = loadRequirements(row.requirement_state, row.agent_covered_sequence);
        if (previous.revision !== inputContext.baseline.revision) throw stale();
        const merged = mergeRequirements(previous, output.requirementChanges, inputContext.messages, scope.trigger);
        await validateRequirementReferences(tx, scope.shopId, output.requirementChanges);
        const related = catalog.relatedSkuIds(merged);
        const cards = await filterRequirementCards(tx, scope.shopId, merged, await catalog.cards(tx, output.candidates), related);
        const requirements = finalizeRequirements(merged, cards.map(c => c.skuId), inputContext.requirements.summary.coveredThroughSequence);
        const blocked = requirementQuery(requirements).blocked.length > 0;
        const content = blocked ? '本轮有尚未核实或相互冲突的要求，暂时无法确认匹配的商品。请补充说明或选择转人工。'
          : output.candidates.length > 0 && cards.length === 0 ? '刚才查询的商品状态已变化，或不符合本轮要求，暂时无法提供可售推荐。请重新查询或选择转人工。'
          : cards.some(c => related.has(c.skuId)) ? `以下是相关商品选择，请留意用途和规格的区别。${output.content}` : output.content;
        await append(tx, scope.channelId, scope.roundId, content, { sender_type: 'agent', product_cards: cards });
        await tx.$executeRaw`UPDATE conversations SET requirement_state=${JSON.stringify(requirements)}::jsonb, agent_covered_sequence=${scope.trigger}, agent_run_status='completed' WHERE id=${scope.roundId}::uuid`;
      });
    } catch (err) {
      if (terminal) return;
      const isOld = err instanceof HttpError && err.code === 'AGENT_RUN_STALE';
      if (isOld && Date.now() < scope.deadline) return;
      const bounded = err instanceof HttpError && ['AGENT_TOOL_LIMIT', 'AGENT_CONTEXT_LIMIT', 'AGENT_MODEL_LIMIT'].includes(err.code);
      await failure(scope, bounded ? '本次自动查询已达处理上限，可缩小问题范围或选择转人工。' : '自动导购暂时无法继续，请选择转人工。', !bounded && !isOld);
    } finally {
      job.progress = undefined; notify();
      clearTimeout(timeout);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  }
  async function pump() {
    if (pumping || stopped || !enabled) return;
    pumping = true;
    try {
      for (const job of jobs.values()) {
        if (running.size >= concurrency) break;
        if (running.has(job.scope.runId)) continue;
        const { scope } = job;
        const now = Date.now(), recent = (rates.get(scope.buyerId) ?? []).filter((t) => t > now - 60000);
        if (scope.deadline <= now || recent.length >= 6) {
          jobs.delete(scope.roundId); await failure(scope, '自动导购暂时繁忙，请稍后补充问题或选择转人工。'); continue;
        }
        rates.set(scope.buyerId, [...recent, now]); running.add(scope.runId);
        const flight = execute(job).catch((err: unknown) => app.log.error({ err }, 'agent run failed')).finally(() => {
          running.delete(scope.runId);
          flights.delete(flight);
          if (jobs.get(scope.roundId) === job) jobs.delete(scope.roundId);
          if (issued.get(scope.roundId) === scope.runId) issued.delete(scope.roundId);
          void pump();
        });
        flights.add(flight);
      }
      for (const [id, entries] of rates) if (entries.every((t) => t <= Date.now() - 60000)) rates.delete(id);
    } finally { pumping = false; }
  }
  async function admit(roundId: string) {
    if (!enabled || stopped) return;
    const row = await db.conversation.findUnique({ where: { id: roundId } });
    if (row && jobs.get(roundId)?.scope.runId === row.agent_run_id) return;
    if (!row || row.status !== 'agent' || row.agent_run_status !== 'queued' || !row.agent_run_id || !row.agent_deadline) { cancel(roundId); issued.delete(roundId); return; }
    if (issued.get(roundId) !== row.agent_run_id) return;
    cancel(roundId);
    const scope: Scope = { shopId: row.shop_id, channelId: row.channel_id, buyerId: row.buyer_id, roundId, runId: row.agent_run_id, generation: row.agent_generation, trigger: row.agent_trigger_sequence, version: row.updated_at.toISOString(), deadline: row.agent_deadline.getTime() };
    const waiting = [...jobs.values()].filter((job) => !running.has(job.scope.runId)).length;
    if (waiting >= queueLimit && running.size >= concurrency) { await failure(scope, '自动导购暂时繁忙，请稍后补充问题或选择转人工。'); issued.delete(roundId); return; }
    jobs.set(roundId, { scope, controller: new AbortController() }); void pump();
  }
  async function schedule(roundId: string) {
    try { await admit(roundId); }
    catch (err) { app.log.error({ err, roundId }, 'agent admission deferred; buyer message remains delivered'); }
  }
  let sweeping: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!enabled || stopped || sweeping) return;
    sweeping = (async () => {
      // Recover an admission failure without re-delivering the buyer message.
      const queued = await db.conversation.findMany({ where: { id: { in: [...issued.keys()] } }, orderBy: { agent_deadline: 'asc' }, take: 25, select: { id: true } });
      for (const row of queued) { if (stopped) break; await schedule(row.id); }
      await pump();
    })().catch((err: unknown) => app.log.error({ err }, 'agent queue sweep deferred')).finally(() => { sweeping = undefined; });
  }, 3000);
  timer.unref();
  // A durable queued/running row is never blindly replayed after process restart:
  // the old credential is lost; keep buyer messages, cancel that run, hand off.
  app.addHook('onReady', async () => {
    if ((!enabled && options.mode !== 'disabled') || options.recoverOnStart === false) return;
    const interrupted = await db.conversation.findMany({ where: { status: 'agent', ...(options.recoveryShopIds ? { shop_id: { in: options.recoveryShopIds } } : {}), ...(enabled ? { agent_run_status: { in: ['queued', 'running'] } } : {}) } });
    for (const row of interrupted) await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shops WHERE id=${row.shop_id}::uuid FOR SHARE`;
      await lockDispatch(tx, row.shop_id);
      await tx.$queryRaw`SELECT id FROM chat_channels WHERE id=${row.channel_id}::uuid FOR UPDATE`;
      const current = await tx.conversation.findUniqueOrThrow({ where: { id: row.id } });
      if (current.status === 'agent' && (!enabled || ['queued', 'running'].includes(current.agent_run_status))) await handoff(tx, row.id, { reason: 'agent_failure', question: enabled ? '自动导购服务重启，请人工继续处理未完成的咨询' : '自动导购已停用，请人工继续处理咨询' });
    });
  });
  app.addHook('preClose', async () => { stopped = true; clearInterval(timer); for (const job of jobs.values()) job.controller.abort(); jobs.clear(); await sweeping; await Promise.allSettled([...flights]); });
  return { enabled, queue, schedule, cancel, activate, handoff,
    progress: (round: { id: string; status: string; agent_run_id: string | null; agent_run_status: string }): ChatProgressDto | null => {
      if (round.status !== 'agent' || !['queued', 'running'].includes(round.agent_run_status)) return null;
      const job = jobs.get(round.id);
      return job && job.scope.runId === round.agent_run_id && !job.controller.signal.aborted ? job.progress ?? { kind: 'guide', phase: 'queued', startedAt: new Date(job.scope.deadline - runMs).toISOString() } : null;
    },
  };
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChatLiveDto, ChatProgressPhase, AgentToolName } from '@shop/contracts';
import { HttpError } from '../auth/index.ts';

export const toolPhase = (name: AgentToolName): ChatProgressPhase => name === 'searchProducts' ? 'searching' : name === 'getProductDetails' ? 'details' : 'filters';

// Wakeups carry no messages or identity data. Every payload is independently
// authorized/read after the transaction that changed the source has committed.
export function createChatLive(app: FastifyInstance) {
  const listeners = new Set<() => void>(), connections = new Map<string, number>(), closers = new Set<() => void>();
  let stopped = false;
  const notify = () => { for (const listener of listeners) listener(); };
  app.addHook('onResponse', async (request, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && reply.statusCode < 400 && !/\/(?:read|heartbeat)(?:\?|$)/.test(request.url) && /^\/api\/(?:chat\/|seller\/|auth\/|account|admin\/)/.test(request.url)) notify();
  });
  app.addHook('preClose', async () => { stopped = true; for (const close of closers) close(); });
  async function stream(request: FastifyRequest, reply: FastifyReply, snapshot: () => Promise<ChatLiveDto>) {
    if (stopped) throw new HttpError(503, 'CHAT_EVENTS_UNAVAILABLE', '咨询连接暂时不可用');
    // No credentials in a URL, no wildcard CORS, and no cross-site read stream.
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', '请求来源不受信任');
    if (Object.keys(request.query as object).length) throw new HttpError(400, 'CHAT_EVENTS_QUERY', '咨询连接参数无效');
    const actor = request.identity!.userId;
    if ([...connections.values()].reduce((sum, count) => sum + count, 0) >= 128 || (connections.get(actor) ?? 0) >= 4) throw new HttpError(429, 'CHAT_EVENTS_LIMIT', '打开的咨询连接过多，请关闭其他页面后重试');
    connections.set(actor, (connections.get(actor) ?? 0) + 1);
    let initial: ChatLiveDto;
    try { initial = await snapshot(); }
    catch (error) { release(); throw error; }
    if (stopped || reply.raw.destroyed) { release(); if (!reply.raw.destroyed) throw new HttpError(503, 'CHAT_EVENTS_UNAVAILABLE', '咨询连接暂时不可用'); return; }
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Connection': 'keep-alive' });
    reply.raw.flushHeaders();
    let closed = false, busy = false, dirty = false, last = '', lastSent = Date.now();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const write = (event: string, data: unknown) => {
      if (closed || reply.raw.destroyed || reply.raw.writableLength > 32768) { close(); return; }
      if (!reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) close();
      lastSent = Date.now();
    };
    const send = (value: ChatLiveDto) => { const text = JSON.stringify(value); if (text !== last) { last = text; write('snapshot', value); } };
    async function refresh() {
      if (closed) return;
      if (busy) { dirty = true; return; }
      busy = true;
      try {
        const value = await snapshot();
        if (!closed) { send(value); if (Date.now() - lastSent >= 15000) write('heartbeat', {}); }
      } catch (error) {
        if (!closed) { write('unavailable', { denied: error instanceof HttpError && [401, 403, 404].includes(error.statusCode), sessionExpired: error instanceof HttpError && error.statusCode === 401 }); close(); }
      } finally { busy = false; if (dirty && !closed) { dirty = false; wake(); } }
    }
    const wake = () => {
      if (closed) return;
      if (busy) { dirty = true; return; }
      if (!pending) pending = setTimeout(() => { pending = undefined; void refresh(); }, 15);
    };
    // Guard leases/role changes even without any events (logout, expiry,
    // membership edits, direct DB state changes and timer-based dispatch).
    const timer = setInterval(() => { void refresh(); }, 1000); timer.unref();
    function release() { const count = (connections.get(actor) ?? 1) - 1; if (count) connections.set(actor, count); else connections.delete(actor); }
    function close() {
      if (closed) return; closed = true; clearInterval(timer); clearTimeout(pending);
      listeners.delete(wake); closers.delete(close); reply.raw.off('close', close); release();
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
    listeners.add(wake); closers.add(close); reply.raw.on('close', close); send(initial);
    // Recheck once after registration so a commit between the first snapshot
    // and listener registration cannot disappear until the next guard tick.
    wake();
  }
  return { notify, stream };
}

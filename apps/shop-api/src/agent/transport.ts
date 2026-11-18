import { Agent, fetch as directFetch } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from '../auth/index.ts';
import { compactWirePrompt, ModelBudget, MODEL_LIMITS } from './budget.ts';

export type WireFetch = typeof globalThis.fetch;
const transient = new Set([408, 429, 500, 502, 503, 504]);
export function officialEndpoint(raw = 'https://api.deepseek.com') {
  const url = new URL(raw);
  if (url.origin !== 'https://api.deepseek.com' || !['/', '/v1', '/v1/'].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error('DeepSeek endpoint must be the official HTTPS Responses endpoint');
  return url.href.replace(/\/$/, '');
}
export function createDirectTransport() {
  const dispatcher = new Agent({ connect: { timeout: 10000 } });
  return { fetch: ((input: Parameters<WireFetch>[0], init: Parameters<WireFetch>[1]) => directFetch(String(input), { ...init, dispatcher, redirect: 'error' } as Parameters<typeof directFetch>[1])) as unknown as WireFetch, close: () => dispatcher.destroy() };
}
export function boundedFetch(transport: WireFetch, budget: ModelBudget, runSignal: AbortSignal, deadline: number): WireFetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.deepseek.com' || !['/responses', '/v1/responses'].includes(url.pathname) || url.search || url.hash || url.username || url.password) throw new HttpError(403, 'AGENT_ENDPOINT_FORBIDDEN', '模型端点不受支持');
    let body = String(init?.body); const request = JSON.parse(body);
    if (request.stream || request.store !== false || request.previous_response_id || request.model !== 'deepseek-flash') throw new HttpError(403, 'AGENT_PROTOCOL_FORBIDDEN', '模型请求配置不受支持');
    body = compactWirePrompt(body, budget.estimate, Math.min(MODEL_LIMITS.input, MODEL_LIMITS.total - budget.chargedTokens - request.max_output_tokens));
    // Both attempts share one per-request deadline and the overall runtime signal.
    const signal = AbortSignal.any([runSignal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, Math.min(MODEL_LIMITS.requestMs, deadline - Date.now())))]);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted || Date.now() >= deadline) throw new HttpError(504, 'AGENT_MODEL_TIMEOUT', '自动导购请求超时');
      const reservation = budget.reserve(body, request.max_output_tokens);
      let response: Response;
      try { response = await transport(input, { ...init, body, redirect: 'error', signal }); }
      catch {
        if (!signal.aborted && attempt === 0 && Date.now() + 200 < deadline) { await delay(200, undefined, { signal }).catch(() => {}); continue; }
        throw new HttpError(signal.aborted ? 504 : 502, signal.aborted ? 'AGENT_MODEL_TIMEOUT' : 'AGENT_PROVIDER_UNAVAILABLE', '自动导购暂时无法连接');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (attempt === 0 && transient.has(response.status) && !signal.aborted && Date.now() + 200 < deadline) { await delay(200, undefined, { signal }).catch(() => {}); continue; }
        // Do not let SDK exceptions retain raw provider bodies, auth headers or input.
        throw new HttpError(502, 'AGENT_PROVIDER_UNAVAILABLE', '自动导购服务暂时不可用');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new HttpError(502, 'AGENT_PROVIDER_INVALID', '自动导购响应无效');
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > MODEL_LIMITS.responseBytes) throw new HttpError(502, 'AGENT_PROVIDER_INVALID', '自动导购响应过大');
          chunks.push(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof HttpError) throw error;
        // A partial successful response is not replayed: its outcome is unknown.
        throw new HttpError(502, 'AGENT_PROVIDER_INTERRUPTED', '自动导购响应中断');
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed: { status?: string; usage?: Parameters<ModelBudget['settle']>[1] };
      try { parsed = JSON.parse(text); } catch { throw new HttpError(502, 'AGENT_PROVIDER_INVALID', '自动导购响应格式无效'); }
      budget.settle(reservation, parsed.usage);
      if (parsed.status !== 'completed') throw new HttpError(502, 'AGENT_PROVIDER_INCOMPLETE', '自动导购未能完成回答');
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new HttpError(502, 'AGENT_PROVIDER_UNAVAILABLE', '自动导购服务暂时不可用');
  };
}

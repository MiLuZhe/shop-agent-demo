import { randomUUID } from 'node:crypto';
import type { WireFetch } from '../agent/transport.ts';
export function wireResponse(output: unknown, usage: unknown = { input_tokens: 100, output_tokens: 50, total_tokens: 150 }) {
  return new Response(JSON.stringify({ id: `resp_${randomUUID()}`, object: 'response', created_at: 1, model: 'deepseek-flash', status: 'completed',
    output: Array.isArray(output) ? output : [{ type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }], usage,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
export function wireTool(name: string, input: unknown) { return [{ type: 'function_call', id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name, arguments: JSON.stringify(input) }]; }
export function wireSequence(steps: ((body: Record<string, any>) => Response | Promise<Response>)[]) {
  const bodies: Record<string, any>[] = [];
  const fetch: WireFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    const step = steps[bodies.length - 1]; if (!step) throw new Error('Unexpected model request'); return step(body);
  };
  return { fetch, bodies };
}

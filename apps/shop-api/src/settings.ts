function integer(raw: string | undefined, fallback: number, min: number, max: number, name: string) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error(`Invalid ${name}`);
  return Number(raw);
}

export function serverSettings(env: NodeJS.ProcessEnv = process.env) {
  const host = env.API_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw new Error('Invalid API_HOST');
  const mode = env.AGENT_MODE ?? 'disabled';
  if (!['mock', 'disabled', 'deepseek'].includes(mode)) throw new Error('Invalid AGENT_MODE');
  return {
    host, port: integer(env.API_PORT, 3000, 1, 65535, 'API_PORT'),
    mode: mode as 'mock' | 'disabled' | 'deepseek',
    concurrency: integer(env.AGENT_CONCURRENCY, 2, 1, 2, 'AGENT_CONCURRENCY'),
    copilotConcurrency: integer(env.COPILOT_CONCURRENCY, 2, 1, 2, 'COPILOT_CONCURRENCY'),
    queueLimit: integer(env.AGENT_QUEUE_LIMIT, 20, 1, 20, 'AGENT_QUEUE_LIMIT'),
  };
}

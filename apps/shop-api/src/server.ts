import { buildApp } from './app.ts';
import { createDeepSeekModel } from './agent/deepseek.ts';
import { createDeepSeekCopilot } from './agent/copilot.ts';
import { serverSettings } from './settings.ts';
const settings = serverSettings();
const app = buildApp(undefined, true, {}, { mode: settings.mode, concurrency: settings.concurrency, copilotConcurrency: settings.copilotConcurrency, queueLimit: settings.queueLimit,
  recoverReceptionOnStart: true, ...(settings.mode === 'deepseek' ? { model: createDeepSeekModel(), copilotModel: createDeepSeekCopilot() } : {}) });
try {
  await app.listen({ host: settings.host, port: settings.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}

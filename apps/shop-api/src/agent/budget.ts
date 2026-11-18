import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Tokenizer } from '@huggingface/tokenizers';
import { HttpError } from '../auth/index.ts';

export const MODEL_LIMITS = Object.freeze({ requests: 6, input: 8000, output: 1500, total: 24000, requestMs: 30000, responseBytes: 256 * 1024 });
export const budgetExceeded = () => new HttpError(429, 'AGENT_MODEL_LIMIT', '本次自动查询已达处理上限，请缩小问题范围或转人工');
let tokenizer: Tokenizer | undefined;
export function estimateInputTokens(body: string) {
  if (!tokenizer) {
    const load = (file: string, sha: string) => {
      const bytes = readFileSync(new URL(`../../assets/deepseek-v4/${file}`, import.meta.url));
      if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('DeepSeek tokenizer integrity check failed');
      return JSON.parse(bytes.toString('utf8'));
    };
    tokenizer = new Tokenizer(load('tokenizer.json', '89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614'), load('tokenizer_config.json', '841f8cf146e3f0ad1082594a31f68ecf7608c20467ef355081333d85bbaeb1cb'));
  }
  // Tokenize the entire serialized wire payload, including tool/output schemas.
  // Extra JSON syntax + 20% + 256 tokens reserve for the provider's chat template.
  // Official offline tokenizer is an estimate; actual API usage is checked too.
  return Math.ceil(tokenizer.encode(body).ids.length * 1.2) + 256;
}
export type Usage = { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
export function compactWirePrompt(body: string, estimate = estimateInputTokens, limit: number = MODEL_LIMITS.input) {
  if (estimate(body) <= limit) return body;
  const wire = JSON.parse(body);
  // Only our explicit public-history field is evictable. Leave current buyer
  // messages, active requirements, schemas and complete tool pairs untouched.
  for (const message of wire.input ?? []) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'input_text' || typeof part.text !== 'string') continue;
      let prompt;
      try { prompt = JSON.parse(part.text); } catch { continue; }
      if (!Array.isArray(prompt.history) || !Array.isArray(prompt.pendingBuyerMessages) || !prompt.requirements) continue;
      while (prompt.history.length && estimate(JSON.stringify(wire)) > limit) {
        prompt.history.shift(); prompt.historyIncomplete = true;
        part.text = JSON.stringify(prompt);
      }
    }
  }
  const result = JSON.stringify(wire);
  if (estimate(result) > limit) throw budgetExceeded();
  return result;
}
export class ModelBudget {
  requests = 0; chargedTokens = 0; knownInput = 0; knownOutput = 0; unknownRequests = 0;
  constructor(readonly estimate = estimateInputTokens) {}
  reserve(body: string, maxOutput: number) {
    const estimatedInput = this.estimate(body);
    if (!Number.isSafeInteger(estimatedInput) || estimatedInput < 0 || !Number.isSafeInteger(maxOutput) || maxOutput > MODEL_LIMITS.output || maxOutput < 1
      || this.requests >= MODEL_LIMITS.requests || estimatedInput > MODEL_LIMITS.input || this.chargedTokens + estimatedInput + maxOutput > MODEL_LIMITS.total) throw budgetExceeded();
    this.requests++; this.chargedTokens += estimatedInput + maxOutput; this.unknownRequests++;
    return { estimatedInput, output: maxOutput, settled: false };
  }
  settle(reservation: ReturnType<ModelBudget['reserve']>, usage: Usage | undefined) {
    if (reservation.settled) throw budgetExceeded();
    reservation.settled = true;
    const input = usage?.input_tokens, output = usage?.output_tokens, total = usage?.total_tokens;
    if (!Number.isSafeInteger(input) || Number(input) < 0 || !Number.isSafeInteger(output) || Number(output) < 0
      || (total !== undefined && (!Number.isSafeInteger(total) || Number(total) !== Number(input) + Number(output)))) throw new HttpError(502, 'AGENT_USAGE_INVALID', '自动导购用量信息暂不可用');
    this.unknownRequests--; this.knownInput += Number(input); this.knownOutput += Number(output);
    // Reservations never shrink: failed / interrupted attempts keep their full
    // reservation and a cheap previous call cannot buy an unbounded continuation.
    this.chargedTokens += Math.max(0, Number(input) + Number(output) - reservation.estimatedInput - reservation.output);
    if (Number(input) > MODEL_LIMITS.input || Number(output) > reservation.output || this.chargedTokens > MODEL_LIMITS.total) throw budgetExceeded();
  }
  snapshot() { return { requests: this.requests, reservedTokens: this.chargedTokens, knownInputTokens: this.knownInput, knownOutputTokens: this.knownOutput, unknownRequests: this.unknownRequests }; }
}

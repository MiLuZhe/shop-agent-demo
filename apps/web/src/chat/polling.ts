import { useEffect, useState } from 'react';
import { api, ApiRequestError } from '../api.ts';

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '暂时无法连接，请重试';
export const accessDenied = (error: unknown) => error instanceof ApiRequestError && [401, 403, 404].includes(error.status);
// Each effect owns one request chain and cancels it on scope changes. Polling
// never overlaps itself, and pauses while the document is hidden.
export function useChatPoll<T>(path: string, revision = 0, active = true, scope = '', pollMs = 3000) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [denied, setDenied] = useState(false);
  const [dataScope, setDataScope] = useState(scope);
  useEffect(() => { setData(undefined); setError(''); setDenied(false); }, [path, scope]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let timer: number | undefined, running = false;
    async function refresh() {
      if (running || controller.signal.aborted) return;
      window.clearTimeout(timer); running = true;
      try {
        const value = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(value); setDataScope(scope); setError(''); setDenied(false); }
      } catch (error) {
        if (!controller.signal.aborted) { setError(errorMessage(error)); if (accessDenied(error)) { setData(undefined); setDenied(true); } }
      } finally {
        running = false;
        if (!controller.signal.aborted) timer = window.setTimeout(() => { if (!document.hidden) void refresh(); }, pollMs);
      }
    }
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh(); document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    return () => { controller.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
  }, [path, revision, active, scope, pollMs]);
  return { data: dataScope === scope ? data : undefined, error, denied };
}

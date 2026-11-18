import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatLiveDto } from '@shop/contracts';

// fetch rather than EventSource lets seller clients retain the same request
// headers/proxy path as the REST API. No credential is put in a query string.
export function useChatLive(path: string, active = true, scope = '') {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const [state, setState] = useState<{ scope: string; path: string; value?: ChatLiveDto; connected: boolean; denied: boolean; revision: number }>({ scope, path, connected: false, denied: false, revision: 0 });
  useEffect(() => {
    let stopped = false, denied = false, controller: AbortController | undefined, reconnect: number | undefined, watchdog: number | undefined;
    let backoff = 1000, fingerprint = '', lastValue = '';
    const update = (value: Partial<typeof state>) => { if (!stopped) setState(previous => ({ ...previous, scope, path, ...value })); };
    update({ value: undefined, connected: false, denied: false });
    async function connect() {
      if (stopped || denied || document.hidden || !active) return;
      const request = new AbortController(); controller = request;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const touch = () => { window.clearTimeout(watchdog); watchdog = window.setTimeout(() => request.abort(), 35000); };
      try {
        touch();
        const response = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, signal: request.signal });
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) { denied = true; update({ denied: true, value: undefined }); if (response.status === 401) window.dispatchEvent(new Event('shop:session-expired')); }
          throw new Error('Stream unavailable');
        }
        if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('Invalid stream');
        reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        // Every reconnect starts with a fresh authorized snapshot and forces a
        // REST catch-up. No assumption that transient events can be replayed.
        fingerprint = ''; lastValue = '';
        while (!stopped && !request.signal.aborted) {
          const part = await reader.read(); if (part.done) break; touch();
          buffer += decoder.decode(part.value, { stream: true });
          if (buffer.length > 65536) throw new Error('Stream frame too large');
          let match: RegExpMatchArray | null;
          while ((match = buffer.match(/\r?\n\r?\n/))) {
            const frame = buffer.slice(0, match.index!), lines = frame.split(/\r?\n/); buffer = buffer.slice(match.index! + match[0].length);
            const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
            const text = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (event === 'unavailable') {
              const error = JSON.parse(text) as { denied: boolean; sessionExpired?: boolean };
              denied = error.denied; update({ denied, value: undefined, connected: false });
              if (error.sessionExpired) window.dispatchEvent(new Event('shop:session-expired'));
              throw new Error('Stream closed');
            }
            if (event !== 'snapshot') continue;
            const value = JSON.parse(text) as ChatLiveDto;
            const next = JSON.stringify({ channelId: value.channelId, latestSequence: value.latestSequence, round: value.round });
            if (stopped || request.signal.aborted) return;
            const changed = next !== fingerprint; fingerprint = next;
            if (lastValue !== text) {
              lastValue = text;
              setState(previous => ({ scope, path, value, connected: true, denied: false, revision: previous.revision + (changed ? 1 : 0) }));
            }
            backoff = 1000;
          }
        }
      } catch { /* REST polling remains available during reconnects. */ }
      finally {
        window.clearTimeout(watchdog); await reader?.cancel().catch(() => {}); request.abort();
        if (controller === request) controller = undefined;
        if (!stopped) update({ connected: false, value: undefined });
        if (!stopped && !denied && !document.hidden && active) { reconnect = window.setTimeout(() => { reconnect = undefined; void connect(); }, backoff); backoff = Math.min(backoff * 2, 10000); }
      }
    }
    const visible = () => {
      if (document.hidden) { window.clearTimeout(reconnect); reconnect = undefined; controller?.abort(); update({ connected: false, value: undefined }); }
      else if (!controller && reconnect === undefined) void connect();
    };
    if (active) { void connect(); document.addEventListener('visibilitychange', visible); }
    return () => { stopped = true; window.clearTimeout(reconnect); window.clearTimeout(watchdog); controller?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, [path, active, scope, attempt]);
  return { ...(state.scope === scope && state.path === path && active ? state : { connected: false, denied: false, revision: 0, value: undefined }), retry };
}

// A denied stream stays closed until REST has returned a *new* authorized
// result. An old retained result must not cause a fast denial/reconnect loop.
export function useChatLiveRecovery(live: { denied: boolean; retry: () => void }, data: unknown) {
  const previous = useRef(data);
  useEffect(() => { const fresh = !!data && data !== previous.current; previous.current = data; if (fresh && live.denied) live.retry(); }, [data, live.denied, live.retry]);
}

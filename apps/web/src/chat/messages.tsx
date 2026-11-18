import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatMessageDto, ChatMessagesDto } from '@shop/contracts';
import { api } from '../api.ts';
import { accessDenied, errorMessage } from './polling.ts';
import { ChatProductCard } from './product-card.tsx';
import { AgentRecommendation } from './product-card.tsx';

const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function merge(previous: ChatMessageDto[], incoming: ChatMessageDto[]) {
  const values = new Map(previous.map((row) => [row.id, row]));
  for (const row of incoming) values.set(row.id, row);
  return [...values.values()].sort((a, b) => a.sequence - b.sequence);
}
export function MessageHistory({ path, revision, username, onAccessDenied, active = true, readPath, activity, pollMs = 3000 }: { path: string; revision: number; username: string; onAccessDenied: () => void; active?: boolean; readPath?: string; activity?: ReactNode; pollMs?: number }) {
  const [items, setItems] = useState<ChatMessageDto[]>([]), [loaded, setLoaded] = useState(false), [more, setMore] = useState(false), [loadingOlder, setLoadingOlder] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const rows = useRef<ChatMessageDto[]>([]), started = useRef(false), viewport = useRef<HTMLDivElement>(null), stick = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null), olderController = useRef<AbortController | null>(null), deniedCallback = useRef(onAccessDenied);
  const requestRead = useRef(() => {});
  deniedCallback.current = onAccessDenied;
  function accept(incoming: ChatMessageDto[]) { rows.current = merge(rows.current, incoming); setItems(rows.current); }
  useEffect(() => () => olderController.current?.abort(), []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let timer: number | undefined, running = false;
    async function refresh() {
      if (running || controller.signal.aborted) return;
      window.clearTimeout(timer); timer = undefined; running = true;
      try {
        const cursor = rows.current.at(-1)?.sequence;
        const value = await api<ChatMessagesDto>(`${path}${path.includes('?') ? '&' : '?'}limit=50${started.current && cursor ? `&after=${cursor}` : ''}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!started.current) { setMore(value.hasMore); started.current = true; }
        accept(value.items); setLoaded(true); setError('');
        // A large backlog is drained without skipping past the last received sequence.
        if (value.hasMore && cursor) timer = window.setTimeout(() => { void refresh(); }, 0);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
          if (accessDenied(error)) { rows.current = []; setItems([]); deniedCallback.current(); }
        }
      } finally {
        running = false;
        if (!controller.signal.aborted && timer === undefined) timer = window.setTimeout(() => { timer = undefined; if (!document.hidden) void refresh(); }, pollMs);
      }
    }
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh(); document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    return () => { controller.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
  }, [path, revision, retry, active, pollMs]);
  useLayoutEffect(() => {
    const node = viewport.current; if (!node) return;
    if (prepend.current) { node.scrollTop = prepend.current.top + node.scrollHeight - prepend.current.height; prepend.current = null; }
    else if (stick.current) node.scrollTop = node.scrollHeight;
  }, [items, activity]);
  useEffect(() => {
    if (!readPath || !active) return;
    const controller = new AbortController(); let acknowledged = 0, busy = false;
    async function markRead() {
      const node = viewport.current, sequence = rows.current.at(-1)?.sequence ?? 0;
      if (busy || controller.signal.aborted || document.hidden || !document.hasFocus() || !node || !node.checkVisibility() || node.clientHeight <= 0 || node.scrollHeight - node.scrollTop - node.clientHeight > 8 || sequence <= acknowledged) return;
      const rect = node.getBoundingClientRect();
      if (rect.bottom > innerHeight + 1 || rect.top < 0) return;
      busy = true;
      try {
        const result = await api<{ sequence: number }>(readPath!, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sequence }), signal: controller.signal });
        if (!controller.signal.aborted) { acknowledged = Math.max(acknowledged, result.sequence); window.dispatchEvent(new Event('shop:chat-read')); }
      } catch (error) {
        if (!controller.signal.aborted && accessDenied(error)) deniedCallback.current();
      } finally { busy = false; }
    }
    const mark = () => { void markRead(); };
    requestRead.current = mark;
    const timer = window.setInterval(mark, 3000);
    document.addEventListener('visibilitychange', mark); window.addEventListener('focus', mark); mark();
    return () => { requestRead.current = () => {}; controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', mark); window.removeEventListener('focus', mark); };
  }, [readPath, active]);
  useEffect(() => { requestRead.current(); }, [items]);
  async function older() {
    const before = rows.current[0]?.sequence; if (!before || loadingOlder) return;
    const controller = new AbortController(); olderController.current = controller; setLoadingOlder(true); setError('');
    try {
      const value = await api<ChatMessagesDto>(`${path}${path.includes('?') ? '&' : '?'}before=${before}&limit=30`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (viewport.current) prepend.current = { height: viewport.current.scrollHeight, top: viewport.current.scrollTop };
      accept(value.items); setMore(value.hasMore);
    } catch (error) { if (!controller.signal.aborted) { setError(errorMessage(error)); if (accessDenied(error)) { rows.current = []; setItems([]); deniedCallback.current(); } } }
    finally { if (!controller.signal.aborted) setLoadingOlder(false); }
  }
  return <><div className="chat-messages" ref={viewport} role="region" aria-label="聊天记录" tabIndex={0} onScroll={(event) => { const node = event.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; requestRead.current(); }}>
    {more && <button type="button" className="chat-history-more" disabled={loadingOlder} onClick={() => { void older(); }}>{loadingOlder ? '正在加载…' : '加载更早消息'}</button>}
    {!loaded && !error && <p className="chat-empty" role="status">正在加载聊天记录…</p>}
    {loaded && !items.length && <p className="chat-empty">还没有消息，发送你的问题吧。</p>}
    {items.map((row, index) => <Fragment key={row.id}>
      {(index === 0 || row.roundId !== items[index - 1]!.roundId) && <p className="chat-round-divider">{dateTime(row.createdAt)} · 咨询记录</p>}
      {row.senderType === 'system' ? <p className="chat-system-message">{row.content}<time dateTime={row.createdAt}>{dateTime(row.createdAt)}</time></p> : <article className={`chat-message${row.sender?.username === username ? ' chat-message-own' : ''}`} aria-label={`${row.senderType === 'buyer' ? '买家' : row.senderType === 'seller' ? '客服' : '导购助手'}消息`}>
        <div className="chat-message-meta"><strong>{row.sender?.displayName ?? '导购助手'}</strong>{row.sender && <span>@{row.sender.username}</span>}<time dateTime={row.createdAt}>{dateTime(row.createdAt)}</time></div>{row.product && <ChatProductCard product={row.product}/>}<p>{row.content}</p>{row.productCards?.map((card) => <AgentRecommendation key={card.skuId} card={card}/>)}
      </article>}
    </Fragment>)}
    {activity}
  </div>{error && <div className="chat-fetch-error" role="alert">{error}<button onClick={() => setRetry((v) => v + 1)}>重试消息加载</button></div>}
  <button className="chat-jump" type="button" onClick={() => { stick.current = true; viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: 'smooth' }); }}>回到最新消息 ↓</button></>;
}

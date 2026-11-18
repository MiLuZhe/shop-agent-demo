import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ChatMessageDto, ChatProductDto, ChatSuggestionDto, ChatProgressDto } from '@shop/contracts';
import { api, ApiRequestError } from '../api.ts';
import { errorMessage } from './polling.ts';
import { ChatProductCard } from './product-card.tsx';
import { SuggestionDialog } from './assist.tsx';

export function ChatComposer({ path, version, canSend, reason, onSent, product, onProductCleared, onDeliveryPendingChange, suggestionScope, suggestionProgress }: { path: string; version?: string; canSend: boolean; reason?: string; onSent: () => void; product?: ChatProductDto; onProductCleared?: () => void; onDeliveryPendingChange?: (pending: boolean) => void; suggestionScope?: { roundId: string; version: string; lastSequence: number }; suggestionProgress?: ChatProgressDto | null }) {
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [attempt, setAttempt] = useState<{ content: string; clientMessageId: string; version?: string; productId?: string; skuId?: string; suggestionId?: string }>();
  const [suggestion, setSuggestion] = useState<ChatSuggestionDto>(), [review, setReview] = useState<typeof suggestionScope>();
  const inputId = useId();
  const mounted = useRef(true), pendingCallback = useRef(onDeliveryPendingChange);
  pendingCallback.current = onDeliveryPendingChange;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pendingCallback.current?.(false); }; }, []);
  // Form instances are keyed by buyer/shop or seller/round; requests never move to another scope.
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || (!canSend && !attempt)) return;
    const payload = attempt ?? { content: draft.trim(), clientMessageId: crypto.randomUUID(), ...(version ? { version } : {}), ...(suggestion ? { suggestionId: suggestion.id } : {}), ...(product ? { productId: product.id, ...(product.skuId ? { skuId: product.skuId } : {}) } : {}) };
    if (!payload.content || payload.content.length > 4000 || payload.content.includes('\0')) { setError('请填写 1–4000 字的有效消息'); return; }
    setBusy(true); setAttempt(payload); setError(''); onDeliveryPendingChange?.(true);
    try {
      await api<ChatMessageDto>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (mounted.current) { setDraft(''); setSuggestion(undefined); setAttempt(undefined); onDeliveryPendingChange?.(false); onProductCleared?.(); onSent(); }
    } catch (error) {
      if (mounted.current) {
        const uncertain = !(error instanceof ApiRequestError) || error.status >= 500 || error.code === 'INVALID_RESPONSE';
        setError(uncertain ? '暂时无法确认是否送达，请点击重试发送。' : errorMessage(error));
        if (!uncertain) { setAttempt(undefined); onDeliveryPendingChange?.(false); onSent(); }
      }
    } finally { if (mounted.current) setBusy(false); }
  }
  return <form className="chat-composer" aria-label="发送消息" onSubmit={(event) => { void send(event); }}>
    {reason && !attempt && <p className="chat-composer-reason">{reason}</p>}
    {product && <div className="chat-product-draft"><ChatProductCard key={`${product.id}-${product.skuId}`} product={product}/>{onProductCleared && <button type="button" disabled={busy || !!attempt} onClick={onProductCleared} aria-label="移除咨询商品">×</button>}</div>}
    <div className="form-field"><label htmlFor={inputId}>消息内容</label><textarea id={inputId} required maxLength={4000} rows={3} placeholder={product ? '想了解这件商品的什么信息？' : '输入你想说的话…'} value={draft} disabled={busy || !!attempt || !canSend} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
    }}/></div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <div className="chat-composer-footer"><span>{suggestion ? '建议草稿' : `${draft.length} / 4000`}</span><div className="chat-composer-actions">{suggestion && <button type="button" disabled={busy || !!attempt} onClick={() => setSuggestion(undefined)}>改为手动回复</button>}{suggestionScope && !suggestion && <button type="button" disabled={busy || !!attempt || !canSend} onClick={() => setReview({ ...suggestionScope })}>建议回复</button>}<button className="primary-action" disabled={busy || (!attempt && (!canSend || !draft.trim()))}>{busy ? '发送中…' : attempt ? '重试发送' : '发送消息'}</button></div></div>
    {review && <SuggestionDialog scope={review} progress={suggestionProgress} currentDraft={draft} onClose={() => setReview(undefined)} onAdopt={value => { setDraft(value.content); setSuggestion(value); setReview(undefined); setError(''); }}/>}
  </form>;
}

import { useEffect, useRef, useState } from 'react';
import type { ChatReceptionContextDto, ChatSuggestionDto, ChatProgressDto } from '@shop/contracts';
import { Dialog } from '../dialog.tsx';
import { api } from '../api.ts';
import { errorMessage } from './polling.ts';
import { ChatProductCard } from './product-card.tsx';
import { ChatActivity } from './activity.tsx';

export function ReceptionSummaryDialog({ roundId, onClose }: { roundId: string; onClose: () => void }) {
  const [data, setData] = useState<ChatReceptionContextDto>(), [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); void api<ChatReceptionContextDto>(`/seller/chat/rounds/${roundId}/context`, { signal: controller.signal }).then(setData).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }); return () => controller.abort(); }, [roundId]);
  return <Dialog title="接待摘要" onClose={onClose}><div className="reception-summary">
    {error && <p className="auth-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">正在整理接待记录…</p>}
    {data && <>
      {data.handoff && <section><h3>接入原因</h3><p>{data.handoff.reason}</p><p>{data.handoff.question}</p>{data.handoff.note && <details><summary>导购交接说明（待核对）</summary><p>{data.handoff.note}</p></details>}</section>}
      <section><h3>已识别需求</h3>{data.requirements.length ? <ul>{data.requirements.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p>暂无已识别需求</p>}{data.memoryBehind && <p className="reception-summary-note">还有新的买家消息，请结合下方补充核对。</p>}</section>
      {!!data.unresolved.length && <section><h3>需要确认</h3><ul>{data.unresolved.map((text, i) => <li key={i}>{text}</li>)}</ul></section>}
      {!!data.products.length && <section><h3>咨询商品</h3>{data.products.map(p => <ChatProductCard key={`${p.id}:${p.skuId}`} product={p}/>)}</section>}
      <section><h3>买家最近的问题</h3>{data.recentQuestions.length ? data.recentQuestions.map(row => <blockquote key={row.sequence}>{row.content}</blockquote>) : <p>暂无买家消息</p>}</section>
    </>}
  </div></Dialog>;
}
export function SuggestionDialog({ scope, currentDraft, onClose, onAdopt, progress }: { scope: { roundId: string; version: string; lastSequence: number }; currentDraft: string; onClose: () => void; onAdopt: (value: ChatSuggestionDto) => void; progress?: ChatProgressDto | null }) {
  const [value, setValue] = useState<ChatSuggestionDto>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [replace, setReplace] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [requestId, setRequestId] = useState('');
  useEffect(() => () => controller.current?.abort(), []);
  async function generate() {
    if (busy) return; setBusy(true); setError(''); setValue(undefined);
    const request = new AbortController(), id = crypto.randomUUID(); controller.current = request; setRequestId(id);
    try { setValue(await api<ChatSuggestionDto>(`/seller/chat/rounds/${scope.roundId}/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: scope.version, lastSequence: scope.lastSequence, requestId: id }), signal: request.signal })); }
    catch (err) { if (!request.signal.aborted) setError(errorMessage(err)); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }
  return <Dialog title="建议回复" busy={busy} onClose={onClose}><div className="reception-suggestion">
    {!value && <p>生成后可先审核、修改，再手动发送给买家。</p>}
    {busy && <ChatActivity progress={progress?.kind === 'suggestion' && progress.requestId === requestId ? progress : { kind: 'suggestion', phase: 'processing', startedAt: '' }}/>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {value && <><label htmlFor="reception-suggestion-preview">建议草稿</label><textarea id="reception-suggestion-preview" readOnly rows={7} value={value.content}/>{!!currentDraft.trim() && <><details><summary>查看当前草稿</summary><p>{currentDraft}</p></details><label className="suggestion-replace"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)}/>确认替换当前草稿</label></>}</>}
    <div className="dialog-actions">
      {busy ? <button type="button" onClick={() => { controller.current?.abort(); onClose(); }}>取消生成</button> : <><button type="button" onClick={onClose}>取消</button><button type="button" onClick={() => { void generate(); }}>{value ? '重新生成' : '生成建议'}</button>{value && <button type="button" className="primary-action" disabled={!!currentDraft.trim() && !replace} onClick={() => onAdopt(value)}>{currentDraft.trim() ? '替换当前草稿' : '填入草稿'}</button>}</>}
    </div>
  </div></Dialog>;
}

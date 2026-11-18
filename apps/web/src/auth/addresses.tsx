import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { MAX_SAVED_ADDRESSES, type RecipientInput, type SavedAddressDto } from '@shop/contracts';
import { api } from '../api.ts';
import { Dialog } from '../dialog.tsx';
import { refreshFieldValidation } from '../validation.ts';

export const emptyRecipient: RecipientInput = { recipientName: '', recipientPhone: '', recipientAddress: '' };
export function RecipientFields({ value, onChange }: { value: RecipientInput; onChange: (value: RecipientInput) => void }) {
  const id = useId(), fields = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fields.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach(refreshFieldValidation);
  }, [value]);
  return <div ref={fields} className="recipient-fields">
    <div className="form-field"><label htmlFor={`${id}-name`}>收货人</label><input id={`${id}-name`} required maxLength={80} autoComplete="shipping name" value={value.recipientName} onChange={(e) => onChange({ ...value, recipientName: e.target.value })}/></div>
    <div className="form-field"><label htmlFor={`${id}-phone`}>联系电话</label><input id={`${id}-phone`} required type="tel" minLength={7} maxLength={32} pattern="\+?[0-9][0-9 ()-]*[0-9]" title="请填写有效联系电话（7–15 位数字，可含空格或短横线）" data-validate="phone" autoComplete="shipping tel" value={value.recipientPhone} onChange={(e) => onChange({ ...value, recipientPhone: e.target.value })}/></div>
    <div className="form-field address-full"><label htmlFor={`${id}-address`}>完整收货地址</label><textarea id={`${id}-address`} required minLength={5} maxLength={500} autoComplete="shipping street-address" value={value.recipientAddress} onChange={(e) => onChange({ ...value, recipientAddress: e.target.value })}/></div>
  </div>;
}
export function RecipientDetails({ value }: { value: RecipientInput }) {
  return <dl className="recipient-details"><dt>收货人</dt><dd>{value.recipientName}</dd><dt>联系电话</dt><dd>{value.recipientPhone}</dd><dt>收货地址</dt><dd>{value.recipientAddress}</dd></dl>;
}
const message = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function AddressBook({ onSelect, onLoaded, disabled = false, revision = 0 }: { onSelect?: (value: RecipientInput) => void; onLoaded?: (items: SavedAddressDto[]) => void; disabled?: boolean; revision?: number }) {
  const [items, setItems] = useState<SavedAddressDto[]>([]), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<SavedAddressDto | 'new'>(), [deleting, setDeleting] = useState<SavedAddressDto>();
  const [value, setValue] = useState<RecipientInput>(emptyRecipient), [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState('');
  useEffect(() => {
    const c = new AbortController(); setLoading(true); setError('');
    void api<{ items: SavedAddressDto[] }>('/account/addresses', { signal: c.signal }).then((data) => { setItems(data.items); onLoaded?.(data.items); }).catch((e: Error) => { if (!c.signal.aborted) setError(e.message); }).finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
  }, [reload, revision, onLoaded]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !editor) return; setBusy(true); setError(''); setNote('');
    try {
      await api(`/account/addresses${editor === 'new' ? '' : `/${editor.id}`}`, json(editor === 'new' ? 'POST' : 'PUT', { ...value, ...(editor === 'new' ? {} : { version: editor.version }) }));
      setEditor(undefined); setReload((v) => v + 1); setNote('常用地址已保存');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function remove() {
    if (busy || !deleting) return; setBusy(true); setError('');
    try { await api(`/account/addresses/${deleting.id}`, json('DELETE', { version: deleting.version })); setDeleting(undefined); setReload((v) => v + 1); setNote('常用地址已删除，已有订单不受影响'); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="address-book" aria-label="常用地址">
    <div className="address-book-heading"><h3>常用地址 <small>（{items.length}/{MAX_SAVED_ADDRESSES}）</small></h3><button type="button" disabled={disabled || busy || loading || items.length >= MAX_SAVED_ADDRESSES} onClick={() => { setValue(emptyRecipient); setEditor('new'); setError(''); }}>新增地址</button></div>
    {error && !editor && !deleting && <p className="auth-error" role="alert">{error} <button type="button" disabled={disabled || busy} onClick={() => setReload((v) => v + 1)}>刷新地址</button></p>}
    {note && <p role="status">{note}</p>}
    {loading ? <p role="status">正在加载地址…</p> : <div className="address-list">{!items.length && <p className="muted">尚未保存常用地址</p>}{items.map((item) => <article className="address-card" key={item.id}><RecipientDetails value={item}/><div className="address-actions">{onSelect && <button type="button" disabled={disabled || busy} onClick={() => { onSelect(item); setNote('已填写此地址，请核对后提交订单'); }}>使用此地址</button>}<button type="button" disabled={disabled || busy} onClick={() => { setValue({ recipientName: item.recipientName, recipientPhone: item.recipientPhone, recipientAddress: item.recipientAddress }); setEditor(item); setError(''); }}>编辑地址</button><button type="button" disabled={disabled || busy} onClick={() => { setDeleting(item); setError(''); }}>删除地址</button></div></article>)}</div>}
    {editor && <Dialog title={editor === 'new' ? '新增常用地址' : '编辑常用地址'} busy={busy} onClose={() => { setEditor(undefined); setError(''); }}><form aria-label="保存常用地址" onSubmit={(e) => { void save(e); }}><fieldset disabled={busy} style={{ border: 0, padding: 0 }}><RecipientFields value={value} onChange={setValue}/></fieldset>{error && <p className="auth-error" role="alert">{error}</p>}<div className="address-actions"><button type="button" disabled={busy} onClick={() => { setEditor(undefined); setError(''); }}>返回</button><button className="primary-action" disabled={busy}>{busy ? '保存中…' : '保存地址'}</button>{error && <button type="button" disabled={busy} onClick={() => { setEditor(undefined); setReload((v) => v + 1); }}>刷新地址列表</button>}</div></form></Dialog>}
    {deleting && <Dialog title="删除常用地址" busy={busy} onClose={() => { setDeleting(undefined); setError(''); }}><p>确认删除这个常用地址？已有订单的收货信息会保留。</p><RecipientDetails value={deleting}/>{error && <p className="auth-error" role="alert">{error}</p>}<div className="address-actions"><button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>返回</button><button className="primary-action" disabled={busy} onClick={() => { void remove(); }}>确认删除</button>{error && <button type="button" disabled={busy} onClick={() => { setDeleting(undefined); setReload((v) => v + 1); }}>刷新地址列表</button>}</div></Dialog>}
  </section>;
}

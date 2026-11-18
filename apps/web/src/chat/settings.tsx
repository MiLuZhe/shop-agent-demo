import { useEffect, useState, type FormEvent } from 'react';
import type { ChatSettingsDto } from '@shop/contracts';
import { api } from '../api.ts';
import { Dialog } from '../dialog.tsx';
import { errorMessage, useChatPoll } from './polling.ts';
import { useReceptionNotifications } from './notifications.tsx';

function SettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { data, error: loadError } = useChatPoll<ChatSettingsDto>('/seller/chat/settings');
  const [draft, setDraft] = useState<ChatSettingsDto>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (data) setDraft(previous => previous ?? data); }, [data]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || busy) return; setBusy(true); setError('');
    try {
      await api('/seller/chat/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity: draft.capacity, version: draft.version }) });
      window.dispatchEvent(new Event('shop:chat-settings'));
      onSaved(); onClose();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <Dialog title="接待容量" busy={busy} onClose={onClose}><form className="chat-action-form" onSubmit={event => { void save(event); }}><fieldset disabled={busy || !draft || !data?.canEdit || !!loadError}>
    <div className="form-field"><label htmlFor="reception-capacity">每名客服同时接待上限</label><input id="reception-capacity" type="number" required min={1} max={10} step={1} value={draft?.capacity ?? ''} onChange={event => setDraft(value => value ? { ...value, capacity: Number(event.target.value) } : value)}/></div>
    <button className="primary-action">{busy ? '保存中…' : '保存容量'}</button>
  </fieldset>{(error || loadError) && <p className="auth-error" role="alert">{error || loadError}</p>}</form></Dialog>;
}
export function ReceptionTools({ onChanged }: { onChanged: () => void }) {
  const { data, error } = useChatPoll<ChatSettingsDto>('/seller/chat/settings');
  const { sound, toggleSound } = useReceptionNotifications();
  const [open, setOpen] = useState(false);
  return <div className="reception-tools"><button type="button" aria-pressed={sound} onClick={toggleSound}>{sound ? '关闭提示音' : '开启提示音'}</button>{data?.canEdit && !error && <button type="button" onClick={() => setOpen(true)}>接待容量</button>}{open && <SettingsDialog onClose={() => setOpen(false)} onSaved={onChanged}/>}</div>;
}

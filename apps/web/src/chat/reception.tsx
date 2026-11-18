import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatAvailabilityDto } from '@shop/contracts';
import { api } from '../api.ts';
import { useAuth } from '../auth/context.ts';
import { accessDenied, errorMessage } from './polling.ts';
import { ReceptionNotifications } from './notifications.tsx';
import { Dialog } from '../dialog.tsx';

const ReceptionContext = createContext<{ state?: ChatAvailabilityDto; error: string; busy: boolean; checking: boolean; toggle: () => void; onLeave: (state: ChatAvailabilityDto) => void }>({ error: '', busy: false, checking: false, toggle: () => {}, onLeave: () => {} });
export function ReceptionProvider({ children, sessionVersion }: { children: ReactNode; sessionVersion: string | null }) {
  const { user } = useAuth();
  const [state, setState] = useState<ChatAvailabilityDto>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const running = useRef(false), epoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    setState(undefined); setError(''); setBusy(false); setChecking(false); running.current = false;
    if (!user?.canManageShops) return;
    let timer: number, stopped = false;
    async function heartbeat(initial = false) {
      if (stopped || epoch.current !== generation) return;
      window.clearTimeout(timer);
      if (!running.current) {
        running.current = true; setChecking(true);
        try {
          const value = await api<ChatAvailabilityDto>(initial ? '/seller/chat/availability' : '/seller/chat/heartbeat', initial ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (!stopped && epoch.current === generation) { setState(value); setError(''); }
        } catch (err) {
          if (!stopped && epoch.current === generation) {
            setError(errorMessage(err));
            if (accessDenied(err)) setState(undefined);
            else setState((old) => old ? { ...old, available: false, expiresAt: null } : old);
          }
        } finally { if (epoch.current === generation) { running.current = false; setChecking(false); } }
      }
      if (!stopped) timer = window.setTimeout(() => { void heartbeat(); }, 15000);
    }
    void heartbeat(true);
    const refresh = () => { void heartbeat(true); };
    window.addEventListener('shop:chat-settings', refresh);
    return () => { stopped = true; window.clearTimeout(timer); window.removeEventListener('shop:chat-settings', refresh); };
  }, [user?.username, user?.canManageShops, sessionVersion]);
  async function toggle() {
    if (running.current || busy) return;
    const generation = epoch.current;
    running.current = true; setBusy(true); setError('');
    try {
      const value = await api<ChatAvailabilityDto>('/seller/chat/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ available: !state?.available }) });
      if (generation === epoch.current) setState(value);
    } catch (err) { if (generation === epoch.current) setError(errorMessage(err)); }
    finally { if (generation === epoch.current) { running.current = false; setBusy(false); } }
  }
  return <ReceptionContext.Provider value={{ state, error, busy, checking, toggle: () => { void toggle(); }, onLeave: value => { setState(value); window.dispatchEvent(new Event('shop:chat-settings')); } }}><ReceptionNotifications sessionVersion={sessionVersion}>{children}</ReceptionNotifications></ReceptionContext.Provider>;
}
export function ReceptionStatus() {
  const { state, error, busy, checking, toggle, onLeave } = useContext(ReceptionContext);
  const [leaving, setLeaving] = useState(false);
  return <div className="reception-availability">
    <div><span className={`reception-presence ${state?.available && !error ? 'is-online' : ''}`} aria-hidden="true"/><strong>{error ? '接待连接待确认' : state?.available ? state.activeCount ? '在线 · 接待中' : '在线 · 等待分配' : '暂停接待'}</strong>{state && <span className="reception-load" aria-label={`当前接待 ${state.activeCount}，容量 ${state.capacity}`}>{state.activeCount}/{state.capacity}</span>}</div>
    <button className={state?.available ? '' : 'primary-action'} disabled={busy || checking} onClick={toggle}>{busy ? '更新中…' : state?.available ? '暂停接待' : '上线接待'}</button>
    {!!state?.activeCount && <button disabled={busy || checking} onClick={() => setLeaving(true)}>离岗交接</button>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {leaving && <LeaveDialog onClose={() => setLeaving(false)} onDone={value => { onLeave(value); setLeaving(false); }}/>}
  </div>;
}

function LeaveDialog({ onClose, onDone }: { onClose: () => void; onDone: (state: ChatAvailabilityDto) => void }) {
  const [snapshot, setSnapshot] = useState<{ roundVersions: { id: string; version: string }[] }>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  useEffect(() => { const controller = new AbortController(); void api<{ roundVersions: { id: string; version: string }[] }>('/seller/chat/leave', { signal: controller.signal }).then(setSnapshot).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }); return () => controller.abort(); }, []);
  async function submit() {
    if (!snapshot || busy || blocked) return;
    setBusy(true); setError('');
    try { onDone(await api<ChatAvailabilityDto>('/seller/chat/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) })); }
    catch (err) { setError(errorMessage(err)); setBlocked(true); }
    finally { setBusy(false); }
  }
  return <Dialog title="离岗交接" busy={busy} onClose={onClose}>
    {snapshot ? <p>将 {snapshot.roundVersions.length} 轮咨询交回人工等待队列，并暂停接待。暂时无人空闲时，咨询会留在队列中。</p> : !error && <p role="status">正在核对接待…</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>取消</button><button className="primary-action" disabled={busy || !snapshot || blocked} onClick={() => { void submit(); }}>{busy ? '交接中…' : '确认离岗交接'}</button></div>
  </Dialog>;
}

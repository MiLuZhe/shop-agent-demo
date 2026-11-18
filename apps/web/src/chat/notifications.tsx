import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatNotificationsDto } from '@shop/contracts';
import { useAuth } from '../auth/context.ts';
import { useChatPoll } from './polling.ts';

const empty: ChatNotificationsDto = { items: [], unreadCount: 0, conversationCount: 0 };
const NotificationsContext = createContext({ data: empty, sound: false, toggleSound: () => {} });
export const useReceptionNotifications = () => useContext(NotificationsContext);

export function ReceptionNotifications({ children, sessionVersion }: { children: ReactNode; sessionVersion: string | null }) {
  const { user } = useAuth();
  const scope = `${user?.username ?? 'guest'}:${sessionVersion}`;
  const [revision, setRevision] = useState(0), [sound, setSound] = useState(false), [notice, setNotice] = useState<{ roundId: string; text: string; scope: string }>();
  const [noticeTop, setNoticeTop] = useState(110);
  const seen = useRef(new Map<string, number>()), audio = useRef<AudioContext | null>(null);
  const { data, denied } = useChatPoll<ChatNotificationsDto>('/seller/chat/notifications', revision, !!user?.canManageShops, scope);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('shop:chat-read', refresh);
    return () => window.removeEventListener('shop:chat-read', refresh);
  }, []);
  useEffect(() => {
    seen.current.clear(); setNotice(undefined);
    try { setSound(localStorage.getItem(`shop:reception-sound:${user?.username}`) === 'on'); } catch { setSound(false); }
  }, [user?.username, sessionVersion]);
  useEffect(() => () => { void audio.current?.close(); }, []);
  useEffect(() => {
    if (!sound) return;
    // Browsers require a gesture after navigation before audio may resume.
    const unlock = () => {
      try { audio.current ??= new AudioContext(); void audio.current.resume().catch(() => {}); } catch { /* The visual reminder still works. */ }
    };
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, [sound]);
  useEffect(() => {
    const header = document.querySelector('.store-header'); if (!header) return;
    const measure = () => setNoticeTop(header.getBoundingClientRect().bottom + 12);
    const observer = new ResizeObserver(measure); observer.observe(header); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (denied || !user?.canManageShops) { setNotice(undefined); return; }
    if (!data) return;
    setNotice(previous => previous && data.items.some(item => item.roundId === previous.roundId) ? previous : undefined);
    const fresh = data.items.filter(item => item.latestSequence > (seen.current.get(item.roundId) ?? 0));
    for (const item of data.items) seen.current.set(item.roundId, item.latestSequence);
    if (!fresh.length) return;
    if (fresh.some(item => item.assignmentUnread)) window.dispatchEvent(new Event('shop:chat-settings'));
    const first = fresh[0]!;
    setNotice({ roundId: first.roundId, scope, text: fresh.length > 1 ? `${fresh.length} 个咨询有新动态` : `${first.assignmentUnread ? '新分配咨询' : '买家发来新消息'}：${first.buyer.displayName}` });
    if (sound && audio.current?.state === 'running') {
      const context = audio.current, oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = 660; gain.gain.setValueAtTime(.08, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .18);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .18);
    }
  }, [data, denied, user?.canManageShops, sound, scope]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  function toggleSound() {
    const next = !sound;
    if (next) {
      try { audio.current ??= new AudioContext(); void audio.current.resume().catch(() => {}); } catch { return; }
    }
    setSound(next);
    try { localStorage.setItem(`shop:reception-sound:${user?.username}`, next ? 'on' : 'off'); } catch { /* Optional preference; never blocks reception. */ }
  }
  const current = user?.canManageShops && !denied ? data ?? empty : empty;
  return <NotificationsContext.Provider value={{ data: current, sound, toggleSound }}>
    {children}
    {notice && notice.scope === scope && user?.canManageShops && !denied && <aside className="reception-toast" style={{ top: noticeTop }} aria-label="接待提醒" role="status"><span>{notice.text}</span><a className="action-link" href={`#/seller/messages/${notice.roundId}`} onClick={() => setNotice(undefined)}>查看咨询</a><button aria-label="关闭接待提醒" onClick={() => setNotice(undefined)}>×</button></aside>}
  </NotificationsContext.Provider>;
}

export function ReceptionNavLink({ active }: { active: boolean }) {
  const { data } = useReceptionNotifications();
  return <a className={active ? 'active' : ''} href="#/seller/messages" aria-label="咨询接待" title={data.conversationCount ? `${data.conversationCount} 个咨询待查看` : '咨询接待'}>咨询接待{data.conversationCount > 0 && <span className="reception-nav-count" aria-hidden="true">{data.conversationCount > 99 ? '99+' : data.conversationCount}</span>}</a>;
}

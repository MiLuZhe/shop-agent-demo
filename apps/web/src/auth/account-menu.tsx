import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { AuthUserDto } from '@shop/contracts';
import { Avatar } from './avatar.tsx';

export function AccountMenu({ user, busy, onLogout }: { user: AuthUserDto; busy: boolean; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false), panelId = useId();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    const navigate = () => close();
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); window.addEventListener('hashchange', navigate);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('hashchange', navigate); };
  }, [open]);
  function trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const entries = panel.current?.querySelectorAll<HTMLElement>('a,button:not(:disabled)');
    if (!entries?.length) return;
    const first = entries[0]!, last = entries[entries.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="account-menu" ref={root}>
    <button className="account-trigger" ref={trigger} aria-label="账号菜单" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} title={`${user.displayName}（${user.username}）`} onClick={() => setOpen((value) => !value)}><Avatar username={user.username}/></button>
    {open && <div className="account-popover" id={panelId} ref={panel} role="dialog" aria-label="账号菜单" onKeyDown={trapFocus}>
      <button className="account-menu-close" aria-label="关闭账号菜单" onClick={() => close(true)}>×</button>
      <p className="account-menu-username">{user.username}</p><Avatar username={user.username} large/><h2>你好，{user.displayName}</h2>
      <div className="account-menu-links"><a className="action-link" href="#/account" onClick={() => close()}>个人资料</a><a className="action-link" href="#/account/security" onClick={() => close()}>账号与安全</a></div>
      <button className="account-menu-logout" disabled={busy} onClick={() => { void onLogout().then(() => close()); }}>{busy ? '正在退出…' : '退出登录'}</button>
    </div>}
  </div>;
}

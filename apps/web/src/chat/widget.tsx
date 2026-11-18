import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_SHOP_ID, type ChatProductDto } from '@shop/contracts';
import { useAuth } from '../auth/context.ts';
import { BuyerThread } from './chat.tsx';
import './widget.css';

interface Target { shopId: string; product?: ChatProductDto }
const LauncherContext = createContext<{ openChat: (target: Target) => void; setPageContext: (target?: Target) => void }>({ openChat: () => {}, setPageContext: () => {} });
export const useChatLauncher = () => useContext(LauncherContext);

export function ChatWidgetProvider({ visible, reserveCart = false, children }: { visible: boolean; reserveCart?: boolean; children: ReactNode }) {
  const { user, pending } = useAuth();
  const [open, setOpen] = useState(false), [target, setTarget] = useState<Target>(), [pageContext, setPageContext] = useState<Target>();
  const [revision, setRevision] = useState(0), [notice, setNotice] = useState('');
  const [headerHeight, setHeaderHeight] = useState(100);
  const locked = useRef(false), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null), previousUser = useRef(user?.username);
  const targetRef = useRef(target); targetRef.current = target;
  const panelId = useId();
  const updatePageContext = useCallback((value?: Target) => setPageContext(value), []);
  const deliveryPending = useCallback((value: boolean) => { locked.current = value; if (!value) setNotice(''); }, []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const openChat = useCallback((value: Target) => {
    if (locked.current) {
      const current = targetRef.current;
      if (current?.shopId !== value.shopId || current.product?.id !== value.product?.id || current.product?.skuId !== value.product?.skuId) setNotice('请先完成当前消息的发送或重试，再切换咨询商品。');
      setOpen(true); return;
    }
    setTarget(value); setNotice(''); setOpen(true);
  }, []);
  const clearProduct = useCallback(() => setTarget((value) => value ? { shopId: value.shopId } : value), []);
  const close = useCallback(() => { setOpen(false); trigger.current?.focus(); }, []);
  useEffect(() => {
    const revealProduct = () => setOpen(false);
    window.addEventListener('shop:chat-product-opened', revealProduct);
    return () => window.removeEventListener('shop:chat-product-opened', revealProduct);
  }, []);
  useEffect(() => {
    if ((previousUser.current && previousUser.current !== user?.username) || (user && !user.canShop)) { setOpen(false); setTarget(undefined); locked.current = false; setNotice(''); }
    previousUser.current = user?.username;
  }, [user?.username, user?.canShop]);
  const allowed = visible && !pending && (!user || user.canShop);
  useEffect(() => {
    const header = document.querySelector('.store-header'); if (!header) return;
    const measure = () => setHeaderHeight(header.getBoundingClientRect().height);
    measure(); const observer = new ResizeObserver(measure); observer.observe(header);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open || !allowed) return;
    panel.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); close(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, allowed, close]);
  return <LauncherContext.Provider value={{ openChat, setPageContext: updatePageContext }}>
    {children}
    {allowed && <div className="chat-widget" style={{ '--chat-widget-header': `${headerHeight}px`, ...(reserveCart ? { '--chat-widget-bottom': '110px' } : {}) } as CSSProperties}>
      {target && <section ref={panel} id={panelId} className="chat-widget-panel chat-page" role="dialog" aria-label="客服咨询" tabIndex={-1} hidden={!open}>
        <div className="chat-widget-toolbar"><strong>客服咨询</strong><div className="chat-widget-toolbar-actions"><a className="action-link" href={`#/messages/${target.shopId}`} onClick={() => setOpen(false)}>完整对话 ↗</a><button type="button" aria-label="收起客服窗口" onClick={close}>−</button></div></div>
        {notice && <p className="chat-widget-notice" role="alert">{notice}</p>}
        {!user ? <div className="chat-widget-login"><h2>登录后与商家聊一聊</h2><a className="primary-action" href="#/login">前往登录</a></div> : <BuyerThread key={`${user.username}-${target.shopId}`} shopId={target.shopId} active={open} revision={revision} onChange={refresh} product={target.product} onProductCleared={clearProduct} onDeliveryPendingChange={deliveryPending}/>}
      </section>}
      <button ref={trigger} type="button" className="chat-widget-launcher" aria-label={open ? '收起客服咨询' : '联系客服'} aria-expanded={open} aria-controls={target && open ? panelId : undefined} onClick={() => { if (open) close(); else if (target && !pageContext) setOpen(true); else openChat(pageContext ?? { shopId: DEFAULT_SHOP_ID }); }}>
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-9a9 9 0 0 1 18-1Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M7 11h8M7 15h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg><span>{open ? '收起' : '客服'}</span>
      </button>
    </div>}
  </LauncherContext.Provider>;
}

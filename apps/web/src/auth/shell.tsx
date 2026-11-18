import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AccountDto, AuthUserDto, SellerOverviewDto, SessionDto } from '@shop/contracts';
import { api, ApiRequestError } from '../api.ts';
import './styles.css';
import { SellerManager, SellerProductEditorPage } from '../seller/manager.tsx';
import { AuthContext } from './context.ts';
import { CartPage } from '../cart/cart.tsx';
import { OrdersPage } from '../orders/orders.tsx';
import { MembersPage } from '../seller/members.tsx';
import { DEFAULT_SHOP_ID, type ShopRole } from '@shop/contracts';
import { AccountSettings } from './account-settings.tsx';
import { Avatar } from './avatar.tsx';
import { AccountMenu } from './account-menu.tsx';
import { DirectCheckoutPage, ProductPage } from '../products/product.tsx';
import { ReceptionProvider } from '../chat/reception.tsx';
import { ReceptionNavLink } from '../chat/notifications.tsx';
import { BuyerChatPage, SellerChatPage } from '../chat/chat.tsx';
import { ChatWidgetProvider } from '../chat/widget.tsx';
import { installFieldValidation } from '../validation.ts';

type Route = 'catalog' | 'product' | 'checkout' | 'login' | 'account' | 'seller' | 'sellerProduct' | 'cart' | 'orders' | 'sellerOrders' | 'members' | 'security' | 'messages' | 'sellerMessages';
function currentRoute(): Route {
  if (/^#\/seller\/messages(?:\/[^/?]+)?$/.test(window.location.hash)) return 'sellerMessages';
  if (/^#\/messages(?:\/[^/?]+)?$/.test(window.location.hash)) return 'messages';
  if (/^#\/products\/[^/?]+(?:\?.*)?$/.test(window.location.hash)) return 'product';
  if (/^#\/checkout\/[^/?]+(?:\?.*)?$/.test(window.location.hash)) return 'checkout';
  if (window.location.hash === '#/account/security') return 'security';
  if (window.location.hash === '#/seller/members') return 'members';
  if (/^#\/seller\/products\/(?:new|[0-9a-f-]{36})$/.test(window.location.hash)) return 'sellerProduct';
  if (/^#\/seller\/orders(?:\/[^/]+)?$/.test(window.location.hash)) return 'sellerOrders';
  if (/^#\/orders(?:\/[^/]+)?$/.test(window.location.hash)) return 'orders';
  return ({ '#/login': 'login', '#/account': 'account', '#/seller': 'seller', '#/cart': 'cart' } as Record<string, Route>)[window.location.hash] ?? 'catalog';
}
function go(route: Route) { window.location.hash = route === 'catalog' ? '' : `/${route}`; }
function queryFromHash() { return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('q') ?? ''; }

function HeaderSearch() {
  const [value, setValue] = useState(queryFromHash);
  useEffect(() => {
    const sync = () => setValue(queryFromHash());
    window.addEventListener('hashchange', sync);
    window.addEventListener('shop:catalog-search', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('shop:catalog-search', sync); };
  }, []);
  return <form className="header-search" role="search" aria-label="全站搜索" onSubmit={(event) => {
    event.preventDefault();
    const query = value.trim();
    const hash = query ? `#catalog?q=${encodeURIComponent(query)}` : '#catalog';
    if (window.location.hash === hash) window.dispatchEvent(new Event('shop:catalog-search'));
    else window.location.hash = hash;
  }}><span aria-hidden="true">⌕</span><input aria-label="顶部商品搜索" placeholder="搜索商品…" value={value} onChange={(event) => setValue(event.target.value)} maxLength={100}/><button>找商品</button><button className="filter-trigger" type="button" aria-haspopup="dialog" onClick={() => {
    if (currentRoute() === 'catalog') window.dispatchEvent(new Event('shop:open-filters'));
    else window.location.hash = '#catalog?filters=1';
  }}><span aria-hidden="true">☷</span> 筛选</button></form>;
}

function Login({ onSuccess, initialUsername = '' }: { onSuccess: (session: SessionDto) => void; initialUsername?: string }) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const session = await api<SessionDto>('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      setPassword(''); onSuccess(session);
    } catch (e) { setError(e instanceof Error ? e.message : '登录失败，请重试'); }
    finally { setBusy(false); }
  }
  return <main className="auth-page"><div className="auth-intro"><h1>欢迎回来</h1><p>登录拾物，继续发现你的日常好物。</p><a className="action-link" href="#catalog">先逛逛商店 ↗</a></div>
    <section className="login-card" aria-labelledby="login-title"><h2 id="login-title">账号登录</h2>
      <form onSubmit={(event) => { void submit(event); }} aria-busy={busy}>
        <div className="form-field"><label htmlFor="login-username">账号</label><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={50} value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy}/></div>
        <div className="form-field"><label htmlFor="login-password">密码</label><input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}/></div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="primary-action" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>
    </section></main>;
}
function ProtectedPanel({ route, onSessionChange, onReauthenticate }: { route: 'account' | 'security' | 'seller'; onSessionChange: (value: SessionDto) => void; onReauthenticate: (username: string, reason: 'username' | 'password') => void }) {
  useEffect(() => { if (route === 'seller') window.scrollTo(0, 0); }, [route]);
  const [owner, setOwner] = useState(false);
  const [data, setData] = useState<AccountDto | SellerOverviewDto>();
  const [error, setError] = useState<ApiRequestError | Error>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setError(undefined);
    setOwner(false);
    if (route === 'seller') void api<{ items: { id: string; role: ShopRole }[] }>('/seller/shops', { signal: controller.signal })
      .then((value) => setOwner(value.items.some((shop) => shop.id === DEFAULT_SHOP_ID && shop.role === 'owner'))).catch(() => {});
    void api<AccountDto | SellerOverviewDto>(route === 'seller' ? '/seller/overview' : '/account', { signal: controller.signal })
      .then(setData).catch((e: Error) => { if (e.name !== 'AbortError') setError(e); });
    return () => controller.abort();
  }, [route, reload]);
  const unauthorized = error instanceof ApiRequestError && error.status === 401;
  const forbidden = error instanceof ApiRequestError && error.status === 403;
  return <main className="workspace"><div className="workspace-heading"><h1>{route === 'seller' ? '卖家工作台' : route === 'security' ? '账号与安全' : '我的账号'}</h1></div>
    {error ? <section className="access-state" role="alert"><h2>{unauthorized ? '请先登录' : forbidden ? '此功能需要店铺授权' : '暂时无法加载'}</h2><p>{error.message}</p>
      {unauthorized ? <a className="primary-action" href="#/login">前往登录</a> : forbidden ? <a className="primary-action" href="#/account">返回我的账号</a> : <button className="primary-action" onClick={() => setReload((v) => v + 1)}>重新加载</button>}
      <a className="text-action" href="#catalog">继续逛逛</a></section>
    : !data ? <p className="workspace-loading" role="status">正在加载…</p>
    : 'user' in data ? <section className="account-card"><Avatar username={data.user.username} large/><h2>{data.user.displayName}</h2>
      <p className="profile-username">{data.user.username}</p>
      {(data.user.platformRole === 'admin' || data.shopPositions.length > 0) && <div className="profile-positions" aria-label="任职信息">
        {data.user.platformRole === 'admin' && <span className="role-badge">平台管理员</span>}
        {data.shopPositions.map((position) => <span className="role-badge" key={position.shopId}>{position.shopName} · {{ owner: '店长', manager: '经理', staff: '店员' }[position.role]}</span>)}
      </div>}
      <nav className="account-tabs" aria-label="账号页面"><a className="action-link" href="#/account" aria-current={route === 'account' ? 'page' : undefined}>个人资料</a><a className="action-link" href="#/account/security" aria-current={route === 'security' ? 'page' : undefined}>账号与安全</a></nav>
      <AccountSettings account={data} mode={route === 'security' ? 'security' : 'profile'} onUpdated={(value) => { setData(value); onSessionChange({ user: value.user, expiresAt: value.expiresAt }); }} onReauthenticate={onReauthenticate}/>
      <button className="account-reload" onClick={() => setReload((v) => v + 1)}>重新加载账号资料</button></section>
    : <SellerManager counts={data} canManageMembers={owner} onChange={() => {
      void api<SellerOverviewDto>('/seller/overview').then(setData).catch((e: Error) => setError(e));
    }}/>}
  </main>;
}
export function StoreShell({ children }: { children: ReactNode }) {
  useEffect(installFieldValidation, []);
  const [route, setRoute] = useState<Route>(currentRoute);
  const [locationHash, setLocationHash] = useState(window.location.hash);
  const [session, setSession] = useState<SessionDto>({ user: null, expiresAt: null });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loginNotice, setLoginNotice] = useState<{ username: string; reason: 'username' | 'password' } | null>(null);
  const sessionRevision = useRef(0);
  const applySession = useCallback((value: SessionDto) => { sessionRevision.current++; setSession(value); setError(''); setPending(false); }, []);
  useEffect(() => {
    const update = () => { setRoute(currentRoute()); setLocationHash(window.location.hash); };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const restore = () => {
      const revision = sessionRevision.current;
      void api<SessionDto>('/auth/me', { signal: controller.signal }).then((value) => {
        if (revision === sessionRevision.current) applySession(value);
      }).catch((e: Error) => {
        if (e.name !== 'AbortError' && revision === sessionRevision.current) setError('登录状态暂时无法确认，请重试');
      }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    };
    restore(); window.addEventListener('focus', restore);
    return () => { controller.abort(); window.removeEventListener('focus', restore); };
  }, [refresh, applySession]);
  useEffect(() => {
    const expired = () => {
      if (!session.user) return;
      sessionRevision.current++; setSession({ user: null, expiresAt: null }); setError('登录已失效，请重新登录');
    };
    window.addEventListener('shop:session-expired', expired);
    const timer = session.expiresAt ? window.setTimeout(expired, Math.max(0, Date.parse(session.expiresAt) - Date.now())) : undefined;
    return () => { window.removeEventListener('shop:session-expired', expired); window.clearTimeout(timer); };
  }, [session.expiresAt]);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true); setError('');
    try { await api('/auth/logout', { method: 'POST' }); applySession({ user: null, expiresAt: null }); go('catalog'); }
    catch (e) { setError(e instanceof Error ? e.message : '退出失败，请重试'); }
    finally { setLoggingOut(false); }
  }
  const user: AuthUserDto | null = session.user;
  const orderId = (route === 'orders' || route === 'sellerOrders') ? locationHash.split('/')[route === 'sellerOrders' ? 3 : 2] : undefined;
  return <AuthContext.Provider value={{ user, pending }}><ReceptionProvider sessionVersion={session.expiresAt}><ChatWidgetProvider reserveCart={route === 'cart'} visible={!['messages', 'login', 'seller', 'sellerProduct', 'sellerOrders', 'sellerMessages', 'members'].includes(route)}>
    <header className="store-header"><a className="brand" href="#catalog" aria-label="拾物首页"><span className="brand-mark">拾</span>拾物<span className="brand-sub">SHIWU</span></a>
      <nav className="store-nav" aria-label="主导航"><a className={route === 'catalog' ? 'active' : ''} href="#catalog">发现好物</a>{user?.canShop && <a className={route === 'cart' ? 'active' : ''} href="#/cart">购物车</a>}{user?.canShop && <a className={route === 'orders' ? 'active' : ''} href="#/orders">我的订单</a>}{user?.canShop && <a className={route === 'messages' ? 'active' : ''} href="#/messages">消息</a>}{user?.canManageShops && <ReceptionNavLink active={route === 'sellerMessages'}/>}{user?.canManageShops && <a className={route === 'sellerOrders' ? 'active' : ''} href="#/seller/orders">订单管理</a>}{user?.canManageShops && <a className={route === 'seller' || route === 'sellerProduct' ? 'active' : ''} href="#/seller">卖家工作台</a>}</nav>
      <HeaderSearch/><div className="auth-actions">{pending ? <span role="status">确认登录状态…</span> : user ? <AccountMenu user={user} busy={loggingOut} onLogout={logout}/> : <a className="login-link" href="#/login">登录</a>}</div>
    </header>
    {error && <div className="session-notice" role="alert">{error}<button onClick={() => setRefresh((v) => v + 1)}>重试登录状态</button></div>}
    {route === 'login' && loginNotice && <div className="session-notice" role="status">{loginNotice.reason === 'password' ? '密码已修改，请使用新密码重新登录。' : `账号已修改为 ${loginNotice.username}，请使用新账号重新登录。`}</div>}
    {user && !user.canShop && ['cart', 'orders', 'checkout', 'messages'].includes(route) ? <main className="workspace"><section className="access-state" role="alert"><h1>请使用买家账号</h1><p>当前为工作账号，个人购物与买家咨询请使用独立账号。</p><a className="primary-action" href={user.canManageShops ? '#/seller' : '#/account'}>返回工作账号</a></section></main> : route === 'catalog' ? children : route === 'product' ? <ProductPage key={locationHash} id={locationHash.split('?')[0]!.split('/')[2]!}/> : route === 'checkout' ? <DirectCheckoutPage key={`${locationHash}-${user?.username ?? 'guest'}`} id={locationHash.split('?')[0]!.split('/')[2]!}/> : route === 'sellerProduct' ? <SellerProductEditorPage key={locationHash} id={locationHash.endsWith('/new') ? null : locationHash.split('/')[3]!}/> : route === 'login' ? <Login initialUsername={loginNotice?.username ?? ''} onSuccess={(value) => { setLoginNotice(null); applySession(value); go(value.user?.canManageShops ? 'seller' : 'account'); }}/>
      : route === 'messages' ? <BuyerChatPage key={`messages-${user?.username ?? 'guest'}`} shopId={locationHash.split('/')[2]}/> : route === 'sellerMessages' ? <SellerChatPage key={`seller-messages-${user?.username ?? 'guest'}`} roundId={locationHash.split('/')[3]}/> : route === 'members' ? <MembersPage key={`members-${user?.username ?? 'guest'}`}/> : route === 'orders' || route === 'sellerOrders' ? <OrdersPage key={`${route}-${user?.username ?? 'guest'}-${user?.canManageShops}`} seller={route === 'sellerOrders'} id={orderId}/> : route === 'cart' ? <CartPage key={`cart-${user?.username ?? 'guest'}`}/> : <ProtectedPanel key={`${route}-${user?.username ?? 'guest'}-${user?.canManageShops}`} route={route} onSessionChange={applySession} onReauthenticate={(username, reason) => { applySession({ user: null, expiresAt: null }); setLoginNotice({ username, reason }); go('login'); }}/>}
  </ChatWidgetProvider></ReceptionProvider></AuthContext.Provider>;
}

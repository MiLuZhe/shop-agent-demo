import { useEffect, useState, type FormEvent } from 'react';
import { sumCartMoney, type CartDto, type CartItemDto, type CartPreviewDto, type SkuDto } from '@shop/contracts';
import { api, ApiRequestError } from '../api.ts';
import { useAuth } from '../auth/context.ts';
import './styles.css';
import { CheckoutForm } from '../orders/orders.tsx';

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const message = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
export function AddToCart({ sku, productId }: { sku: SkuDto; productId?: string }) {
  const { user, pending } = useAuth();
  const [quantity, setQuantity] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState('');
  async function add(e: FormEvent) {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setNote('');
    try { await api('/cart/items', json('POST', { skuId: sku.id, quantity })); setNote('已加入购物车'); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <div className="cart-add">
    {pending ? <p role="status">正在确认登录状态…</p> : user && !user.canShop ? <p className="muted">工作账号仅用于店铺工作，购买请使用独立的买家账号。</p> : !user ? <div className="guest-purchase"><a className="buy-now" href="#/login">登录后立即购买</a>{productId && <a className="primary-action" href="#/login">登录后加入购物车</a>}</div> : <form onSubmit={(e) => { void add(e); }}>
      <div className="purchase-quantity"><span>数量</span><div className="quantity-stepper"><button type="button" aria-label="减少购买数量" disabled={busy || !sku.stockQuantity || quantity <= 1} onClick={() => { setQuantity((value) => Math.max(1, value - 1)); setNote(''); }}>−</button><input aria-label={`${sku.name}购买数量`} type="number" required min={1} max={Math.min(999, sku.stockQuantity)} value={quantity} disabled={busy || !sku.stockQuantity} onChange={(e) => { setQuantity(e.target.valueAsNumber); setNote(''); }}/><button type="button" aria-label="增加购买数量" disabled={busy || !sku.stockQuantity || quantity >= Math.min(999, sku.stockQuantity)} onClick={() => { setQuantity((value) => Math.min(999, sku.stockQuantity, Number.isFinite(value) ? value + 1 : 1)); setNote(''); }}>+</button></div><small>件</small></div>
      {productId && <button type="button" className="buy-now" disabled={busy || !sku.stockQuantity} onClick={(event) => {
        if (event.currentTarget.form?.reportValidity()) window.location.hash = `/checkout/${productId}?sku=${sku.id}&quantity=${quantity}`;
      }}>立即购买</button>}
      <button className="primary-action" disabled={busy || !sku.stockQuantity}>{busy ? '加入中…' : '加入购物车'}</button>
    </form>}
    {error && <p className="auth-error" role="alert">{error}</p>}{note && <p className="manage-success" role="status">{note} <a className="action-link" href="#/cart">去购物车</a></p>}
  </div>;
}
function CartRow({ item, selected, busy, onSelect, onSave, onDelete }: { item: CartItemDto; selected: boolean; busy: boolean; onSelect: () => void; onSave: (quantity: number) => Promise<void>; onDelete: () => void }) {
  const [quantity, setQuantity] = useState(item.quantity);
  useEffect(() => setQuantity(item.quantity), [item.quantity, item.version]);
  return <article className={`cart-row ${item.available ? '' : 'cart-invalid'}`} aria-label={`${item.productName} ${item.skuName}`}>
    <input type="checkbox" aria-label={`勾选${item.skuName}`} checked={selected} disabled={busy || !item.available} onChange={onSelect}/>
    <div className="cart-description"><h2>{item.productName}</h2><small>店铺：{item.shopName}</small><p>{item.skuName}</p><p>当前单价 ¥{item.price} · 库存 {item.stockQuantity}</p>{item.reason && <p className="auth-error">{item.reason}</p>}</div>
    <div className="cart-row-actions"><form onSubmit={(e) => { e.preventDefault(); void onSave(quantity); }}><label>数量<input aria-label={`${item.skuName}数量`} type="number" required min={1} max={Math.min(999, Math.max(1, item.stockQuantity))} value={quantity} disabled={busy} onChange={(e) => setQuantity(e.target.valueAsNumber)}/></label><button disabled={busy || quantity === item.quantity || item.stockQuantity === 0}>更新数量</button></form><strong>¥{item.subtotal}</strong><button disabled={busy} onClick={onDelete}>删除</button></div>
  </article>;
}
export function CartPage() {
  const [data, setData] = useState<CartDto>(), [error, setError] = useState<Error>(), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0), [selected, setSelected] = useState<string[]>([]), [preview, setPreview] = useState<CartPreviewDto>(), [note, setNote] = useState('');
  const [checkoutLocked, setCheckoutLocked] = useState(false);
  useEffect(() => {
    const c = new AbortController(); setLoading(true); setError(undefined); setPreview(undefined);
    void api<CartDto>('/cart', { signal: c.signal }).then((value) => {
      setData(value); setSelected((ids) => ids.filter((id) => value.items.some((item) => item.id === id && item.available)));
    }).catch((e: Error) => { if (e.name !== 'AbortError') { setError(e); setData(undefined); } }).finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
  }, [revision]);
  async function mutate(item: CartItemDto, quantity?: number) {
    if (busy) return; setBusy(true); setError(undefined); setNote(''); setPreview(undefined);
    try {
      await api(`/cart/items/${item.id}`, json(quantity === undefined ? 'DELETE' : 'PUT', { version: item.version, ...(quantity === undefined ? {} : { quantity }) }));
      setNote(quantity === undefined ? '条目已删除' : '数量已更新'); setRevision((v) => v + 1);
    } catch (e) { setError(e instanceof Error ? e : new Error(message(e))); } finally { setBusy(false); }
  }
  async function showPreview() {
    if (busy) return; setBusy(true); setError(undefined); setNote('');
    try {
      const value = await api<CartPreviewDto>('/cart/preview', json('POST', { itemIds: selected }));
      setPreview(value);
      setData((old) => old ? { ...old, items: old.items.map((item) => value.items.find((fresh) => fresh.id === item.id) ?? item) } : old);
    } catch (e) { setPreview(undefined); setError(e instanceof Error ? e : new Error(message(e))); } finally { setBusy(false); }
  }
  const chosen = (data?.items ?? []).filter((item) => selected.includes(item.id) && item.available), available = (data?.items ?? []).filter((item) => item.available);
  const unauthorized = error instanceof ApiRequestError && error.status === 401, forbidden = error instanceof ApiRequestError && error.status === 403;
  return <main className="workspace cart-page"><div className="workspace-heading"><h1>购物车</h1></div>
    {error && <div className="access-state" role="alert"><p>{error.message}</p>{unauthorized ? <a className="action-link" href="#/login">前往登录</a> : forbidden ? <a className="action-link" href="#catalog">返回商店</a> : <button disabled={busy || checkoutLocked} onClick={() => setRevision((v) => v + 1)}>刷新购物车</button>}</div>}
    {note && <p className="manage-success" role="status">{note}</p>}
    {loading ? <p role="status">正在加载购物车…</p> : data && <>
      <div className="cart-toolbar"><label><input type="checkbox" aria-label="全选可售条目" checked={available.length > 0 && chosen.length === available.length} disabled={busy || checkoutLocked || !available.length} onChange={(e) => { setSelected(e.target.checked ? available.map((item) => item.id) : []); setPreview(undefined); }}/>全选可售条目</label><span>{data.items.length} / {data.maxItems} 种规格</span><button disabled={busy || checkoutLocked} onClick={() => setRevision((v) => v + 1)}>刷新购物车</button></div>
      {!data.items.length ? <section className="access-state"><h2>购物车还是空的</h2><p>去商品详情挑选喜欢的规格吧。</p><a className="primary-action" href="#catalog">去逛逛</a></section> : <>
        <div className="cart-items">{data.items.map((item) => <CartRow key={item.id} item={item} busy={busy || loading || checkoutLocked} selected={selected.includes(item.id) && item.available} onSelect={() => { setSelected((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id]); setPreview(undefined); }} onSave={(quantity) => mutate(item, quantity)} onDelete={() => { void mutate(item); }}/>)}</div>
        <div className="cart-summary"><p>已选 {chosen.length} 种规格 · {chosen.reduce((sum, item) => sum + item.quantity, 0)} 件 <strong aria-label="已选合计">¥{sumCartMoney(chosen)}</strong></p><button className="primary-action" disabled={busy || checkoutLocked || !chosen.length} onClick={() => { void showPreview(); }}>{busy ? '处理中…' : '查看结算清单'}</button></div>
      </>}
      {preview && <section className="cart-preview" aria-label="结算清单"><h2>结算清单</h2>{preview.items.map((item) => <p key={item.id}>{item.productName} · {item.skuName} × {item.quantity} <strong>¥{item.subtotal}</strong></p>)}<p>共 {preview.totalQuantity} 件，当前合计 <strong>¥{preview.totalAmount}</strong></p><CheckoutForm preview={preview} onLock={setCheckoutLocked} disabled={busy}/></section>}
    </>}
  </main>;
}

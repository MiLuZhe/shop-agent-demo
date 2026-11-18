import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { MAX_SAVED_ADDRESSES, sumCartMoney, orderStatusLabels, type CheckoutInput, type DirectCheckoutInput, type OrderDetailDto, type OrderSummaryDto, type Page, type CartPreviewDto, type RecipientInput, type SavedAddressDto } from '@shop/contracts';
import { api, ApiRequestError } from '../api.ts';
import './styles.css';
import { Dialog } from '../dialog.tsx';
import { AddressBook, RecipientFields, RecipientDetails, emptyRecipient } from '../auth/addresses.tsx';
const json = (body?: unknown): RequestInit => ({ method: 'POST', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
const message = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
type CheckoutFormProps = { onLock: (locked: boolean) => void; disabled: boolean } & (
  { preview: CartPreviewDto; direct?: never } | { preview?: never; direct: Pick<DirectCheckoutInput, 'skuId' | 'quantity' | 'unitPrice'> }
);
export function CheckoutForm({ preview, direct, onLock, disabled }: CheckoutFormProps) {
  const fieldId = useId(), form = useRef<HTMLFormElement>(null);
  const [recipient, setRecipient] = useState<RecipientInput>(emptyRecipient), [note, setNote] = useState('');
  const [open, setOpen] = useState(false), [addressBusy, setAddressBusy] = useState(false), [addressMessage, setAddressMessage] = useState(''), [addressRevision, setAddressRevision] = useState(0);
  const [savedAddresses, setSavedAddresses] = useState<SavedAddressDto[]>([]);
  const alreadySaved = savedAddresses.some((item) => item.recipientName === recipient.recipientName.trim() && item.recipientPhone === recipient.recipientPhone.trim() && item.recipientAddress === recipient.recipientAddress.trim());
  const addressesFull = savedAddresses.length >= MAX_SAVED_ADDRESSES;
  async function saveAddress() {
    if (addressBusy || busy || attempt || alreadySaved || addressesFull || !form.current?.reportValidity()) return;
    setAddressBusy(true); setAddressMessage('');
    try { const saved = await api<SavedAddressDto>('/account/addresses', json(recipient)); setSavedAddresses((items) => [...items.filter((item) => item.id !== saved.id), saved]); setAddressMessage('已保存到常用地址'); setAddressRevision((v) => v + 1); }
    catch (e) { setAddressMessage(message(e)); } finally { setAddressBusy(false); }
  }
  const [attempt, setAttempt] = useState<CheckoutInput | DirectCheckoutInput>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); if (busy || addressBusy || disabled) return;
    const payload = attempt ?? { checkoutKey: crypto.randomUUID(), ...(direct ? direct : { items: preview!.items.map((item) => ({ cartItemId: item.id, quantity: item.quantity, unitPrice: item.price, version: item.version })) }), ...recipient, buyerNote: note.trim() || null };
    setAttempt(payload); setBusy(true); setError(''); onLock(true);
    try {
      const order = await api<OrderDetailDto>(direct ? '/orders/direct' : '/orders', json(payload));
      window.location.hash = `/orders/${order.id}`;
    } catch (e) {
      setError(message(e));
      // A network/server error may occur after commit. Keep the same key and
      // exact payload for a retry, so a successful first request is replayed.
      if (e instanceof ApiRequestError && e.status >= 400 && e.status < 500) { setAttempt(undefined); onLock(false); }
    } finally { setBusy(false); }
  }
  const locked = busy || addressBusy || !!attempt || disabled;
  return <>
    <button className="primary-action" disabled={disabled} onClick={() => setOpen(true)}>填写收货信息并提交订单</button>
    {open && <Dialog title="确认订单与收货信息" busy={busy || addressBusy || !!attempt} onClose={() => setOpen(false)}>
      <div className="checkout-dialog-summary">{preview ? <>{preview.items.map((item) => <div key={item.id}>{item.productName} · {item.skuName} × {item.quantity}</div>)}<strong>订单合计 ¥{preview.totalAmount}</strong></> : <><p>购买数量：{direct!.quantity} 件 · 单价 ¥{direct!.unitPrice}</p><strong>订单合计 ¥{sumCartMoney([{ price: direct!.unitPrice, quantity: direct!.quantity }])}</strong></>}</div>
      <AddressBook disabled={locked} revision={addressRevision} onLoaded={setSavedAddresses} onSelect={(value) => { setRecipient({ recipientName: value.recipientName, recipientPhone: value.recipientPhone, recipientAddress: value.recipientAddress }); setAddressMessage(''); }}/>
      <form ref={form} className="checkout-form" aria-label="提交订单" onSubmit={(e) => { void submit(e); }}>
        <h3>本次收货信息</h3><fieldset disabled={locked}>
          <RecipientFields value={recipient} onChange={(value) => { setRecipient(value); setAddressMessage(''); }}/>
          <label htmlFor={`${fieldId}-note`}>买家备注（可选）<textarea id={`${fieldId}-note`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}/></label>
        </fieldset>
        <button type="button" disabled={locked || alreadySaved || addressesFull} onClick={() => { void saveAddress(); }}>{addressBusy ? '保存中…' : alreadySaved ? '已保存为常用地址' : addressesFull ? '常用地址已满（3/3）' : '保存本次地址为常用地址'}</button>
        {addressesFull && !alreadySaved && <p className="muted">可编辑或删除上方的常用地址后再保存，也可直接使用本次地址下单。</p>}
        {addressMessage && <p role="status">{addressMessage}</p>}

        {error && <p className="auth-error" role="alert">{error}</p>}
        {attempt && !busy && <p>提交结果暂未确认，请重试原请求，或<a className="action-link" href="#/orders">查看我的订单</a>确认。重试期间保留相同收货信息与商品清单。</p>}
        <div className="address-actions"><button type="button" disabled={busy || addressBusy || !!attempt} onClick={() => setOpen(false)}>返回修改商品</button><button className="primary-action" disabled={busy || addressBusy || disabled}>{busy ? '正在提交…' : attempt ? '重试原订单提交' : '确认并提交订单'}</button></div>
      </form>
    </Dialog>}
  </>;

}
function OrderDetail({ id, seller }: { id: string; seller: boolean }) {
  const [data, setData] = useState<OrderDetailDto>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [confirmation, setConfirmation] = useState<'cancel' | 'mock-pay' | 'ship'>();
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const path = seller ? '/seller/orders' : '/orders';
  useEffect(() => {
    const c = new AbortController(); setData(undefined); setError(''); setConfirmation(undefined);
    void api<OrderDetailDto>(`${path}/${id}`, { signal: c.signal }).then(setData).catch((e: Error) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => c.abort();
  }, [id, seller, revision]);
  useEffect(() => {
    const dialog = confirmationDialog.current;
    if (confirmation && dialog && !dialog.open) dialog.showModal();
    else if (!confirmation && dialog?.open) dialog.close();
  }, [confirmation]);
  async function act() {
    if (!confirmation || busy) return; setBusy(true); setError('');
    try { setData(await api<OrderDetailDto>(`${path}/${id}/${confirmation}`, json())); setConfirmation(undefined); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="order-detail" aria-label="订单详情">
    {error && <p className="auth-error" role="alert">{error}</p>}
    <div className="order-actions"><a className="action-link" href={seller ? '#/seller/orders' : '#/orders'}>返回订单列表</a><button disabled={busy} onClick={() => setRevision((v) => v + 1)}>刷新订单</button></div>
    {!data ? !error && <p role="status">正在读取订单…</p> : <>
      <h2>{orderStatusLabels[data.status]}</h2><p>店铺：{data.shopName}</p><p className="order-code">订单号 {data.orderNo}</p><p>下单时间 {new Date(data.createdAt).toLocaleString('zh-CN', { hour12: false })}</p>
      <div className="order-lines">{data.items.map((item) => <article key={item.id}><div><h3>{item.productName}</h3><p>{item.skuName}{seller && !/^sku_[0-9a-f]{32}$/.test(item.skuCode) ? ` · 商家货号：${item.skuCode}` : ''}</p><p>成交单价 ¥{item.unitPrice} × {item.quantity}</p></div><strong>¥{item.subtotal}</strong></article>)}</div>
      <p className="order-total">订单总额 <strong>¥{data.totalAmount}</strong></p>
      <section className="order-recipient"><h3>下单时的收货信息</h3><RecipientDetails value={data}/>{data.buyerNote && <p>买家备注：{data.buyerNote}</p>}</section>
      {data.paidAt && <p>模拟支付时间：{new Date(data.paidAt).toLocaleString('zh-CN', { hour12: false })} · 演示支付，无真实资金交易</p>}
      {data.cancelledAt && <p>取消时间：{new Date(data.cancelledAt).toLocaleString('zh-CN', { hour12: false })} · 库存已恢复</p>}
      {data.shippedAt && <p>卖家标记发货时间：{new Date(data.shippedAt).toLocaleString('zh-CN', { hour12: false })} · 演示流程已结束</p>}
      <div className="order-actions">{!seller && data.status === 'pending_payment' && <><button className="primary-action" disabled={busy} onClick={() => setConfirmation('mock-pay')}>模拟支付</button><button disabled={busy} onClick={() => setConfirmation('cancel')}>取消订单</button></>}{seller && data.status === 'pending_shipment' && <button className="primary-action" disabled={busy} onClick={() => setConfirmation('ship')}>标记已发货</button>}</div>
      <dialog ref={confirmationDialog} className="order-confirm-dialog" aria-labelledby="order-confirm-title" onCancel={(event) => { event.preventDefault(); if (!busy) setConfirmation(undefined); }} onClick={(event) => { if (event.target === confirmationDialog.current && !busy) setConfirmation(undefined); }}>

        <h2 id="order-confirm-title">{confirmation === 'cancel' ? '取消订单' : confirmation === 'mock-pay' ? '模拟支付' : '确认发货'}</h2>
        <p>{confirmation === 'cancel' ? '确认取消此待支付订单吗？取消后将恢复对应商品库存。' : confirmation === 'mock-pay' ? '确认模拟支付此订单？此操作仅用于演示，不会扣除真实资金。' : '确认将此订单标记为已发货吗？该状态用于演示订单流程。'}</p>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <div className="order-confirm-actions"><button disabled={busy} onClick={() => setConfirmation(undefined)}>返回</button><button className="primary-action" disabled={busy} onClick={() => { void act(); }}>{busy ? '处理中…' : '确认操作'}</button></div>
      </dialog>
    </>}
  </section>;
}
export function OrdersPage({ seller, id }: { seller: boolean; id?: string }) {
  const [data, setData] = useState<Page<OrderSummaryDto>>(), [status, setStatus] = useState(''), [page, setPage] = useState(1), [revision, setRevision] = useState(0), [error, setError] = useState<Error>();
  const path = seller ? '/seller/orders' : '/orders';
  useEffect(() => {
    if (id) return;
    const c = new AbortController(); setData(undefined); setError(undefined);
    void api<Page<OrderSummaryDto>>(`${path}?page=${page}&pageSize=12${status ? `&status=${status}` : ''}`, { signal: c.signal }).then(setData).catch((e: Error) => { if (e.name !== 'AbortError') setError(e); });
    return () => c.abort();
  }, [seller, id, page, status, revision]);
  return <main className="workspace orders-page"><div className="workspace-heading"><h1>{seller ? '订单管理' : '我的订单'}</h1></div>
    {id ? <OrderDetail key={`${seller}-${id}`} id={id} seller={seller}/> : <>
      <div className="order-actions"><label>订单状态<select aria-label="订单状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(orderStatusLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label><button onClick={() => setRevision((v) => v + 1)}>重新加载订单</button></div>
      {error ? <section className="access-state" role="alert"><p>{error.message}</p>{error instanceof ApiRequestError && error.status === 401 && <a className="action-link" href="#/login">前往登录</a>}</section> : !data ? <p role="status">正在加载订单…</p> : <>
        {!data.items.length ? <section className="access-state"><h2>暂无符合条件的订单</h2><a className="action-link" href="#catalog">去逛逛商店</a></section> : <div className="order-list">{data.items.map((order) => <article key={order.id}><div><h2>{orderStatusLabels[order.status]}</h2><p>店铺：{order.shopName}</p><p className="order-code">{order.orderNo}</p><p>{new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}</p></div><strong>¥{order.totalAmount}</strong><a className="primary-action" href={`#${seller ? '/seller' : ''}/orders/${order.id}`}>查看订单</a></article>)}</div>}
        <nav className="manage-pagination" aria-label="订单分页"><span>共 {data.total} 单 · 第 {page} 页</span><button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>上一页</button><button disabled={page * 12 >= data.total} onClick={() => setPage((v) => v + 1)}>下一页</button></nav>
      </>}
    </>}
  </main>;
}

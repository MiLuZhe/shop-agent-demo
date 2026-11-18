import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { DEFAULT_SHOP_ID, type ChatAgentDto, type ChatChannelDto, type ChatProductDto, type ChatRoundDetailsDto, type ChatRoundDto, type ChatShopDto, type Page } from '@shop/contracts';
import { api, ApiRequestError } from '../api.ts';
import { useAuth } from '../auth/context.ts';
import { Avatar } from '../auth/avatar.tsx';
import { Dialog } from '../dialog.tsx';
import { ChatComposer } from './composer.tsx';
import { MessageHistory } from './messages.tsx';
import { errorMessage, useChatPoll } from './polling.ts';
import { ReceptionStatus } from './reception.tsx';
import { ReceptionTools } from './settings.tsx';
import { ReceptionSummaryDialog } from './assist.tsx';
import { useChatLive, useChatLiveRecovery } from './live.ts';
import { ChatActivity } from './activity.tsx';
import './styles.css';

const statusLabel = { agent: '导购接待中', waiting_seller: '等待客服接待', seller: '人工接待中', closed: '已结束' };
const buyerHref = (shopId: string) => `#/messages/${shopId}`;
const sellerHref = (roundId: string) => `#/seller/messages/${roundId}`;
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚无消息';
function Pager({ page, total, onChange }: { page: number; total: number; onChange: (value: number) => void }) {
  return total > 12 ? <nav className="chat-pagination" aria-label="咨询分页"><button disabled={page === 1} onClick={() => onChange(page - 1)}>上一页</button><span>{page} / {Math.ceil(total / 12)}</span><button disabled={page * 12 >= total} onClick={() => onChange(page + 1)}>下一页</button></nav> : null;
}
function FetchError({ error, retry }: { error: string; retry: () => void }) {
  return <div className="chat-fetch-error" role="alert">{error}<button onClick={retry}>重新加载咨询</button></div>;
}
function EndDialog({ round, sequence, seller = false, onClose, onChanged }: { round: ChatRoundDto; sequence: number; seller?: boolean; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [blocked, setBlocked] = useState(false);
  async function submit() {
    if (busy || blocked) return; setBusy(true);
    try {
      await api(`${seller ? '/seller/chat' : '/chat'}/rounds/${round.id}/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: round.version, lastSequence: sequence }) });
      onChanged(); onClose();
    } catch (err) { setError(errorMessage(err)); setBlocked(true); onChanged(); }
    finally { setBusy(false); }
  }
  return <Dialog title="结束本轮咨询" busy={busy} onClose={onClose}><p>聊天记录会保留，再次发送消息将开始新的咨询。</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>取消</button><button className="primary-action" disabled={busy || blocked} onClick={() => { void submit(); }}>{busy ? '正在结束…' : '确认结束咨询'}</button></div>
  </Dialog>;
}
function Gate({ seller, detail = false, actions, children }: { seller: boolean; detail?: boolean; actions?: ReactNode; children: ReactNode }) {
  const { user, pending } = useAuth();
  const screen = useRef<HTMLElement>(null);
  useEffect(() => { window.scrollTo(0, 0); }, []);
  useLayoutEffect(() => {
    const element = screen.current;
    if (!element) return;
    // Navigation can wrap onto extra lines. Size the chat from its actual top,
    // and also follow the visual viewport when a mobile keyboard opens.
    const measure = () => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      element.style.setProperty('--chat-screen-height', `${Math.max(0, (window.visualViewport?.height ?? window.innerHeight) - top)}px`);
    };
    const observer = new ResizeObserver(measure);
    const header = document.querySelector('.store-header');
    if (header) observer.observe(header);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, []);
  return <main ref={screen} className={`chat-page chat-screen ${seller ? detail ? 'seller-chat-detail' : 'seller-chat-inbox' : ''}`}><div className="chat-screen-heading"><h1>{seller ? detail ? '接待会话' : '咨询接待' : '我的消息'}</h1>{!pending && user && (!seller || user.canManageShops) && actions && <div className="chat-screen-actions">{actions}</div>}</div>
    {pending ? <p role="status">正在确认登录状态…</p> : !user ? <section className="access-state"><h2>请先登录</h2><p>登录后即可查看咨询和聊天记录。</p><a className="primary-action" href="#/login">前往登录</a></section> : seller && !user.canManageShops ? <section className="access-state" role="alert"><h2>此功能需要店铺授权</h2><a className="text-action" href="#/messages">查看我的消息</a></section> : children}
  </main>;
}
export function BuyerThread({ shopId, revision, onChange, active = true, product, onProductCleared, onDeliveryPendingChange }: { shopId: string; revision: number; onChange: () => void; active?: boolean; product?: ChatProductDto; onProductCleared?: () => void; onDeliveryPendingChange?: (pending: boolean) => void }) {
  const { user } = useAuth(); const live = useChatLive(`/chat/shops/${shopId}/events`, active, user?.username);
  const { data, error, denied } = useChatPoll<ChatShopDto>(`/chat/shops/${shopId}`, revision + live.revision, active, user?.username, live.connected ? 15000 : 3000);
  useChatLiveRecovery(live, data);
  const [messageDenied, setMessageDenied] = useState(false);
  const [ending, setEnding] = useState<{ round: ChatRoundDto; sequence: number }>(), [deliveryPending, setDeliveryPending] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false), [handoffError, setHandoffError] = useState('');
  useEffect(() => { if (data) setMessageDenied(false); }, [data]);
  async function handoff() {
    const round = data?.channel?.activeRound;
    if (!round || handoffBusy) return;
    setHandoffBusy(true); setHandoffError('');
    try { await api(`/chat/rounds/${round.id}/handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); onChange(); }
    catch (error) { setHandoffError(errorMessage(error)); }
    finally { setHandoffBusy(false); }
  }
  return <section className="chat-thread" aria-label="店铺聊天">
    {error && <FetchError error={error} retry={onChange}/>}
    {denied || live.denied || messageDenied ? <p className="chat-empty" role="alert">暂时无法访问此咨询，请重新加载。</p> : !data ? <p className="chat-empty" role={error ? undefined : 'status'}>{error ? '咨询暂时无法打开。' : '正在打开咨询…'}</p> : <>
      <div className="chat-thread-heading"><div><h2>{data.shopName}</h2><p>{data.channel?.activeRound ? data.channel.activeRound.waitingBuyerSince ? '等待你的回复' : data.channel.activeRound.offlineSince ? '客服暂时离线，正在安排接待' : statusLabel[data.channel.activeRound.status] : data.channel ? '上次咨询已结束，可继续发送新问题' : '发送第一条消息，开始咨询'}</p></div><div className="chat-heading-actions"><button onClick={onChange} type="button">刷新咨询</button>{data.channel?.activeRound && <button disabled={!!error || handoffBusy || deliveryPending} onClick={() => setEnding({ round: data.channel!.activeRound!, sequence: data.channel!.latestSequence })}>结束咨询</button>}</div></div>
      {data.channel?.activeRound?.status === 'agent' && <div className="chat-reception-bar"><span>自动导购接待中</span><button type="button" disabled={handoffBusy || !!error} onClick={() => { void handoff(); }}>{handoffBusy ? '正在转接…' : '转人工'}</button></div>}
      {handoffError && <p className="auth-error" role="alert">{handoffError}</p>}
      {data.channel ? <MessageHistory active={active} key={data.channel.id} path={`/chat/channels/${data.channel.id}/messages`} revision={revision + live.revision} pollMs={live.connected ? 15000 : 3000} username={user!.username} activity={<ChatActivity sending={deliveryPending} progress={active && !handoffBusy && !ending && !error ? live.connected ? live.value?.progress : data.channel.activeRound?.status === 'agent' && ['queued', 'running'].includes(data.channel.activeRound.agentRun?.status ?? '') ? { kind: 'guide', phase: data.channel.activeRound.agentRun?.status === 'queued' ? 'queued' : 'processing', startedAt: data.channel.activeRound.createdAt } : null : null}/>} onAccessDenied={() => { setMessageDenied(true); onChange(); }}/> : <div className="chat-empty chat-welcome"><span aria-hidden="true">◌</span><h3>有什么想了解的？</h3><p>商品选择、规格和订单问题，都可以在这里咨询店铺。</p></div>}
      <ChatComposer path={`/chat/shops/${shopId}/messages`} canSend={active && !error && !ending} onSent={onChange} product={product} onProductCleared={onProductCleared} onDeliveryPendingChange={value => { setDeliveryPending(value); onDeliveryPendingChange?.(value); }}/>
    </>}
    {ending && !denied && !live.denied && !messageDenied && <EndDialog {...ending} onClose={() => setEnding(undefined)} onChanged={onChange}/>}
  </section>;
}
function BuyerInbox({ shopId }: { shopId: string }) {
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0); const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const { data, error } = useChatPoll<Page<ChatChannelDto>>(`/chat/channels?page=${page}&pageSize=12`, revision);
  return <div className="chat-layout"><aside className="chat-sidebar" aria-label="店铺消息列表"><div className="chat-sidebar-heading"><h2>店铺消息</h2><a className="action-link" href={buyerHref(DEFAULT_SHOP_ID)}>联系拾物 ↗</a></div>
    {error && <FetchError error={error} retry={refresh}/>}
    {!data && !error && <p className="chat-empty" role="status">正在加载…</p>}
    {data && !data.items.length && <p className="chat-empty">还没有咨询记录，可从商品页联系商家。</p>}
    <div className="chat-conversation-list">{data?.items.map((row) => <a className="chat-conversation-item" aria-current={row.shopId === shopId ? 'page' : undefined} key={row.id} href={buyerHref(row.shopId)}><strong>{row.shopName}</strong><span>{row.activeRound ? statusLabel[row.activeRound.status] : '上次咨询已结束'}</span><time>{time(row.lastMessageAt)}</time></a>)}</div>
    {data && <Pager page={page} total={data.total} onChange={setPage}/>}
  </aside><BuyerThread key={shopId} shopId={shopId} revision={revision} onChange={refresh}/></div>;
}
export function BuyerChatPage({ shopId = DEFAULT_SHOP_ID }: { shopId?: string }) {
  const { user } = useAuth();
  return <Gate seller={false}>{user && <BuyerInbox shopId={shopId}/>}</Gate>;
}
function ReceptionDialog({ type, details, onClose, onChanged }: { type: 'transfer' | 'close'; details: ChatRoundDetailsDto; onClose: () => void; onChanged: () => void }) {
  const [memberId, setMemberId] = useState(''), [resolution, setResolution] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [blocked, setBlocked] = useState(false), [allowOffline, setAllowOffline] = useState(false);
  const { data: agents, error: agentsError } = useChatPoll<{ items: ChatAgentDto[] }>('/seller/chat/agents');
  const options = agents?.items.filter((agent) => agent.username !== details.channel.buyer.username && agent.username !== details.round.assignedSeller?.username);
  const selected = options?.find(agent => agent.memberId === memberId), offline = !!selected && !selected.online;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || blocked) return; setBusy(true); setError('');
    try {
      await api(`/seller/chat/rounds/${details.round.id}/${type}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: details.round.version, ...(type === 'transfer' ? { memberId, allowOffline: !!details.round.canManage && offline && allowOffline } : { resolution }) }) });
      onChanged(); onClose();
    } catch (error) {
      setError(errorMessage(error));
      if (!(error instanceof ApiRequestError) || error.status === 409 || error.status >= 500 || error.code === 'INVALID_RESPONSE') { setBlocked(true); onChanged(); }
    } finally { setBusy(false); }
  }
  return <Dialog title={type === 'transfer' ? '转接咨询' : '结束接待'} busy={busy} onClose={onClose}><form className="chat-action-form" onSubmit={(event) => { void submit(event); }}><fieldset disabled={busy || blocked}>
    {type === 'transfer' ? <><div className="form-field"><label htmlFor="chat-transfer-member">接待人员</label><select id="chat-transfer-member" required value={memberId} onChange={(event) => { setMemberId(event.target.value); setAllowOffline(false); }}><option value="">请选择同事</option>{options?.map((agent) => <option key={agent.memberId} value={agent.memberId} disabled={agent.activeCount >= agent.capacity || (!agent.online && !details.round.canManage)}>{agent.displayName}（{agent.username}） · {{ owner: '店长', manager: '经理', staff: '店员' }[agent.role]} · {agent.activeCount}/{agent.capacity} · {agent.activeCount >= agent.capacity ? '已满' : agent.online ? '在线' : '离线'}</option>)}</select></div>{offline && details.round.canManage && <label className="reception-offline-confirm"><input type="checkbox" checked={allowOffline} onChange={event => setAllowOffline(event.target.checked)}/>确认指派给离线人员，等待其处理</label>}{agentsError && <p className="auth-error" role="alert">{agentsError}</p>}{options && !options.length && <p>暂无其他可接待的同事。</p>}</> : <><p>结束后保留聊天记录，买家再次发送消息会开始新的咨询。</p><div className="form-field"><label htmlFor="chat-resolution">处理摘要</label><textarea id="chat-resolution" required maxLength={1000} rows={4} value={resolution} onChange={(event) => setResolution(event.target.value)}/></div></>}
    <button className="primary-action" disabled={type === 'transfer' ? !memberId || !!agentsError || !selected || selected.activeCount >= selected.capacity || (offline && (!details.round.canManage || !allowOffline)) : !resolution.trim()}>{busy ? '提交中…' : type === 'transfer' ? '确认转接' : '确认结束'}</button>
  </fieldset>{error && <p className="auth-error" role="alert">{error}</p>}{blocked && <p className="muted">请关闭弹窗并核对最新接待状态后再操作。</p>}</form></Dialog>;
}
function SellerThread({ id, revision, onChange }: { id: string; revision: number; onChange: () => void }) {
  const { user } = useAuth(); const live = useChatLive(`/seller/chat/rounds/${id}/events`, true, user?.username);
  const { data, error, denied } = useChatPoll<ChatRoundDetailsDto>(`/seller/chat/rounds/${id}`, revision + live.revision, true, user?.username, live.connected ? 15000 : 3000);
  useChatLiveRecovery(live, data);
  const [history, setHistory] = useState(false), [action, setAction] = useState<{ type: 'transfer' | 'close' | 'end'; details: ChatRoundDetailsDto }>(), [messageDenied, setMessageDenied] = useState(false);
  const [summary, setSummary] = useState(false);
  const [waitingBusy, setWaitingBusy] = useState(false), [waitingError, setWaitingError] = useState('');
  useEffect(() => { if (data) setMessageDenied(false); }, [data]);
  const self = data?.channel.buyer.username === user?.username, round = data?.round;
  const fullHistory = history && !!round?.canReadHistory;
  async function toggleWaiting() {
    if (!round || waitingBusy) return; setWaitingBusy(true); setWaitingError('');
    try { await api(`/seller/chat/rounds/${id}/waiting`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: round.version, lastSequence: data!.channel.latestSequence, waiting: !round.waitingBuyerSince }) }); onChange(); }
    catch (err) { setWaitingError(errorMessage(err)); onChange(); }
    finally { setWaitingBusy(false); }
  }
  return <section className="chat-thread" aria-label="客服聊天">
    {error && <FetchError error={error} retry={onChange}/>}
    {denied || live.denied || messageDenied ? <p className="chat-empty" role="alert">暂时无法访问此咨询，请重新加载。</p> : !data || !round ? <p className="chat-empty" role={error ? undefined : 'status'}>{error ? '接待记录暂时无法打开。' : '正在打开接待记录…'}</p> : <>
      <div className="chat-thread-heading"><div className="chat-customer"><Avatar username={data.channel.buyer.username}/><div><h2>{data.channel.buyer.displayName}</h2><p>@{data.channel.buyer.username}{!round.waitingBuyerSince && !round.offlineSince ? ` · ${statusLabel[round.status]}` : ''}</p>{(round.waitingBuyerSince || round.offlineSince) && <p role="status">{round.waitingBuyerSince ? '等待买家回复' : round.needsHandoff ? '需要人工交接' : '离线保留中'}</p>}</div></div><button onClick={onChange}>刷新咨询</button></div>
      <div className="chat-reception-bar"><span title={round.assignedSeller ? `接待人员：${round.assignedSeller.displayName}（${round.assignedSeller.username}）` : undefined}>{round.assignedSeller ? `接待：${round.assignedSeller.displayName}` : '尚未分配接待人员'}{round.waitingBuyerSince ? ' · 等待买家' : ''}{round.offlineSince ? round.needsHandoff ? ' · 需要人工交接' : ' · 离线保留中' : ''}</span><div>
        {round.canReply && <button disabled={!!error || waitingBusy} onClick={() => { void toggleWaiting(); }}>{waitingBusy ? '更新中…' : round.waitingBuyerSince ? '恢复处理' : '等待买家'}</button>}
        {(round.canReply || round.canManage) && <button disabled={!!error} onClick={() => setAction({ type: 'transfer', details: data })}>转接咨询</button>}
        {round.canReply && <button disabled={!!error} onClick={() => setAction({ type: 'close', details: data })}>结束接待</button>}
        {round.canManage && round.status === 'agent' && <button disabled={!!error} onClick={() => setAction({ type: 'end', details: data })}>结束导购接待</button>}
      </div></div>
      {waitingError && <p className="auth-error" role="alert">{waitingError}</p>}
      <div className="chat-history-tabs" aria-label="聊天记录范围"><button aria-pressed={!fullHistory} onClick={() => setHistory(false)}>本轮消息</button><button aria-pressed={fullHistory} disabled={!round.canReadHistory} onClick={() => setHistory(true)}>全部历史</button><button onClick={() => setSummary(true)}>接待摘要</button>{data.channel.activeRound && data.channel.activeRound.id !== id && <a className="action-link" href={sellerHref(data.channel.activeRound.id)}>进入当前接待 ↗</a>}</div>
      <MessageHistory key={`${data.channel.id}-${fullHistory}`} path={`/seller/chat/channels/${data.channel.id}/messages${fullHistory ? '' : `?roundId=${id}`}`} readPath={round.canReply || round.canManage ? `/seller/chat/channels/${data.channel.id}/read` : undefined} revision={revision + live.revision} pollMs={live.connected ? 15000 : 3000} activity={<ChatActivity progress={live.value?.progress?.kind === 'guide' ? live.value.progress : null}/>} username={user!.username} onAccessDenied={() => { setMessageDenied(true); onChange(); }}/>
      {round.status === 'closed' ? <p className="chat-readonly">本轮接待已结束，记录仅供查看。</p> : <ChatComposer path={`/seller/chat/rounds/${id}/messages`} version={round.version} suggestionProgress={live.value?.progress} suggestionScope={round.canReply ? { roundId: id, version: round.version, lastSequence: data.channel.latestSequence } : undefined} canSend={round.canReply && !error} reason={self ? '不能作为客服接待自己发起的咨询。' : !round.canReply ? round.status === 'waiting_seller' ? '系统将自动分配给在线空闲客服，分配后即可回复。' : '此咨询由其他客服接待，你可以查看记录。' : undefined} onSent={onChange}/>}
    </>}
    {summary && !denied && !live.denied && !messageDenied && <ReceptionSummaryDialog roundId={id} onClose={() => setSummary(false)}/>}
    {action && !denied && !live.denied && !messageDenied && (action.type === 'end' ? <EndDialog seller round={action.details.round} sequence={action.details.channel.latestSequence} onChanged={onChange} onClose={() => setAction(undefined)}/> : <ReceptionDialog type={action.type} details={action.details} onChanged={onChange} onClose={() => setAction(undefined)}/>)}
  </section>;
}
function SellerInbox() {
  const [view, setView] = useState('mine'), [page, setPage] = useState(1), [revision, setRevision] = useState(0); const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const { data, error } = useChatPoll<Page<ChatRoundDetailsDto> & { canViewAll: boolean } >(`/seller/chat/rounds?view=${view}&page=${page}&pageSize=12`, revision);
  return <section className="reception-inbox" aria-label="接待列表">
      <div className="reception-inbox-heading"><div><h2>店铺咨询</h2></div><div className="reception-tools"><ReceptionTools onChanged={refresh}/><button onClick={refresh}>刷新列表</button></div></div>
      <div className="chat-inbox-tabs" aria-label="接待筛选">{(data?.canViewAll ? [['mine', '我的接待'], ['waiting', '等待分配'], ['all', '全部咨询'], ['closed', '已结束']] : [['mine', '我的接待'], ['closed', '我的已结束']]).map(([value, label]) => <button key={value} aria-pressed={view === value} onClick={() => { setView(value!); setPage(1); }}>{label}</button>)}</div>
      {error && <FetchError error={error} retry={refresh}/>}
      {!data && !error && <p className="chat-empty" role="status">正在加载…</p>}
      {data && !data.items.length && <div className="chat-empty reception-empty"><span aria-hidden="true">◌</span><h3>{view === 'mine' ? '还没有分配给你的咨询' : view === 'waiting' ? '暂时没有等待分配的咨询' : '暂无咨询记录'}</h3><p>{view === 'mine' ? '上线接待后，系统会自动为你分配等待中的买家。' : '新的咨询和接待进度会自动更新。'}</p></div>}
      <div className="reception-rows">{data?.items.map(({ round, channel, unreadCount, assignmentUnread }) => <a className="chat-conversation-item reception-row" key={round.id} href={sellerHref(round.id)}>
        <div className="reception-row-person"><Avatar username={channel.buyer.username}/><div><strong>{channel.buyer.displayName}</strong><span>@{channel.buyer.username}</span>{(assignmentUnread || !!unreadCount) && <span className="reception-unread" aria-label="未读提醒">{assignmentUnread ? '新分配' : ''}{assignmentUnread && !!unreadCount ? ' · ' : ''}{unreadCount ? `${unreadCount} 条未读` : ''}</span>}</div></div>
        <div className="reception-row-state"><span className={`reception-badge is-${round.status}`}>{round.waitingBuyerSince ? '等待买家' : statusLabel[round.status]}</span><span>{round.assignedSeller ? `接待：${round.assignedSeller.displayName}` : round.status === 'agent' ? '自动导购接待中' : '等待空闲客服'}</span>{round.offlineSince && <span>{round.needsHandoff ? '需要人工交接' : '离线保留中'}</span>}</div>
        <div className="reception-row-time"><span>最近消息</span><time>{time(channel.lastMessageAt)}</time></div><span className="reception-row-open">进入会话 ↗</span>
      </a>)}</div>
      {data && <Pager page={page} total={data.total} onChange={setPage}/>}
    </section>;
}
function SellerConversation({ roundId }: { roundId: string }) {
  const [revision, setRevision] = useState(0); const refresh = useCallback(() => setRevision((v) => v + 1), []);
  return <SellerThread key={roundId} id={roundId} revision={revision} onChange={refresh}/>;
}
export function SellerChatPage({ roundId }: { roundId?: string }) {
  const { user } = useAuth();
  return <Gate seller detail={!!roundId} actions={<><a className="text-action chat-return" aria-label={roundId ? '返回接待列表' : undefined} href={roundId ? '#/seller/messages' : '#/seller'}>{roundId ? <><span aria-hidden="true">←</span><span className="chat-return-label">返回接待列表</span></> : '返回工作台 ↗'}</a><ReceptionStatus/></>}>{user?.canManageShops && (roundId ? <SellerConversation roundId={roundId}/> : <SellerInbox/>)}</Gate>;
}

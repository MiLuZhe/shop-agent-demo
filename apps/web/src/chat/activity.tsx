import type { ChatProgressDto, ChatProgressPhase } from '@shop/contracts';

const labels: Record<ChatProgressPhase, string> = {
  queued: '正在等待导购处理…', processing: '正在处理你的咨询…', understanding: '正在整理你的需求…', filters: '正在查找合适的筛选条件…',
  searching: '正在搜索符合条件的商品…', details: '正在核对商品规格与库存…', composing: '正在整理推荐结果…', checking: '正在核对回复中的商品信息…',
};
export function ChatActivity({ progress, sending = false }: { progress?: ChatProgressDto | null; sending?: boolean }) {
  if (!sending && !progress) return null;
  const suggestion = progress?.kind === 'suggestion';
  const label = sending ? '正在发送消息…' : progress!.phase === 'composing' && progress!.lastAction
    ? `${({ filters: '已查询筛选条件', searching: '已搜索商品', details: '已查询商品规格' })[progress!.lastAction]}，正在整理${suggestion ? '建议回复' : '推荐结果'}…`
    : suggestion && progress!.phase === 'processing' ? '正在生成建议回复…'
    : suggestion && progress!.phase === 'understanding' ? '正在整理本轮咨询…'
    : suggestion && progress!.phase === 'composing' ? '正在草拟建议回复…'
    : suggestion && progress!.phase === 'checking' ? '正在核对建议回复…' : labels[progress!.phase];
  return <div className={`chat-activity${sending ? ' chat-activity-sending' : ''}`} role="status" aria-live="polite" aria-atomic="true">
    <span className="chat-activity-dot" aria-hidden="true"/><div><strong>{sending ? '消息发送中' : suggestion ? '回复助手' : '导购助手'}</strong><span>{label}</span></div>
    <span className="chat-activity-glow" aria-hidden="true"/>
  </div>;
}

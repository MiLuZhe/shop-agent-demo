import { Prisma } from '@shop/database';
import { chatProductSnapshotSchema, type ChatReceptionContextDto } from '@shop/contracts';
import { loadRequirements } from './agent-memory.ts';

type Tx = Prisma.TransactionClient;
export async function receptionContext(tx: Tx, round: Prisma.ConversationGetPayload<{}>, canSuggest: boolean): Promise<ChatReceptionContextDto> {
  const channel = await tx.chatChannel.findUniqueOrThrow({ where: { id: round.channel_id } });
  const questions = await tx.message.findMany({ where: { conversation_id: round.id, sender_type: 'buyer' }, orderBy: { sequence: 'desc' }, take: 3 });
  const inquiry = await tx.inquiry.findFirst({ where: { conversation_id: round.id }, orderBy: { created_at: 'desc' } });
  const event = await tx.message.findFirst({ where: { conversation_id: round.id, sender_type: 'system', OR: ['agent_handoff', 'staff_leave', 'offline_requeued', 'transferred', 'reassigned'].map(type => ({ event_data: { path: ['type'], equals: type } })) }, orderBy: { sequence: 'desc' } });
  const eventData = event?.event_data as { summary?: unknown; type?: string } | null;
  const notes = await tx.message.findMany({ where: { conversation_id: round.id, product_context: { not: Prisma.DbNull } }, orderBy: { sequence: 'desc' }, take: 8 });
  const products = [...new Map(notes.flatMap(row => { const p = chatProductSnapshotSchema.safeParse(row.product_context); return p.success ? [[`${p.data.id}:${p.data.skuId}`, p.data] as const] : []; })).values()].slice(0, 3);
  const requirements: string[] = [], unresolved: string[] = [];
  try {
    const memory = loadRequirements(round.requirement_state, round.agent_covered_sequence);
    if (memory.purpose) requirements.push(`用途：${memory.purpose.value}`);
    for (const condition of memory.constraints) {
      const v = condition.value, label = condition.level === 'hard' ? '要求' : condition.level === 'preference' ? '偏好' : '待确认';
      let value = '';
      if (v.kind === 'budget') value = `单价预算：${v.min ? `至少 ${v.min} 元` : ''}${v.min && v.max ? '，' : ''}${v.max ? `最多 ${v.max} 元` : ''}`;
      else if (v.kind === 'quantity') value = `数量：${v.value} 件`;
      else if (v.kind === 'keyword') value = `商品关键词：${v.value}`;
      else if (v.kind === 'text') value = `${v.excluded ? '排除' : '补充条件'}：${v.value}`;
      else if (v.kind === 'category') value = `分类：${(await tx.category.findFirst({ where: { id: v.categoryId, shop_id: round.shop_id } }))?.name ?? '原分类已不可用'}`;
      else if (v.kind === 'tag') value = `标签：${(await tx.tag.findFirst({ where: { id: v.tagId, shop_id: round.shop_id } }))?.name ?? '原标签已不可用'}`;
      else {
        const attribute = await tx.attributeDefinition.findFirst({ where: { id: v.filter.attributeId, shop_id: round.shop_id } });
        value = `${attribute?.name ?? '原属性已不可用'}：${condition.source.quote}`;
      }
      requirements.push(`${label} · ${value}`);
    }
    unresolved.push(...memory.unresolved.map(v => v.question));
  } catch { unresolved.push('已有需求记录暂时无法完整读取，请核对本轮聊天。'); }
  const reason: Record<string, string> = { user_request: '买家请求人工', missing_info: '商品资料不足', agent_failure: '自动导购无法继续', unresolved: '问题需要人工处理' };
  const eventReason: Record<string, string> = { staff_leave: '原客服离岗交接', offline_requeued: '原客服连接中断', transferred: '客服转接', reassigned: '管理人员重新指派' };
  return { version: round.updated_at.toISOString(), lastSequence: channel.next_sequence, requirements, unresolved,
    memoryBehind: !!questions[0] && questions[0].sequence > round.agent_covered_sequence,
    handoff: inquiry ? { reason: eventData?.type === 'agent_handoff' ? reason[inquiry.reason] ?? '人工咨询' : eventReason[eventData?.type ?? ''] ?? '买家咨询', question: inquiry.question.slice(0, 1000), note: typeof eventData?.summary === 'string' ? eventData.summary.slice(0, 1000) : null } : null,
    recentQuestions: questions.reverse().map(r => ({ sequence: r.sequence, content: r.content.slice(0, 1000) })), products, canSuggest };
}

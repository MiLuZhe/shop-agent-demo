import type { RequirementChange, RequirementConstraint } from '@shop/contracts';
import { constraintKey, type BuyerMemoryMessage } from './agent-memory.ts';

// A deliberately small deterministic preview grammar. It is not an NLP engine;
// the real provider will propose the same validated changes in the next phase.
export function mockRequirementChanges(messages: BuyerMemoryMessage[]): RequirementChange[] {
  const changes: RequirementChange[] = [];
  for (const message of messages) {
    const source = (quote: string) => ({ sequence: message.sequence, quote: quote.slice(0, 160) });
    if (message.productId) changes.push({ op: 'product', productId: message.productId, skuId: message.skuId, source: source(message.content) });
    for (const raw of message.content.split(/[，,。；;\n]/)) {
      const clause = raw.trim();
      if (!clause) continue;
      const set = (value: RequirementConstraint['value'], level: RequirementConstraint['level'] = 'hard', scope: RequirementConstraint['scope'] = 'global') => {
        changes.push({ op: 'set', constraint: { key: constraintKey(value), value, level, scope, source: source(clause) } });
      };
      if (/^(?:重新开始|重新来(?:一次)?|(?:刚才|前面|之前)的?(?:需求|条件)?不算(?:了)?|清空(?:需求|条件)|重置(?:需求|条件))$/.test(clause)) {
        changes.push({ op: 'reset', source: source(clause) }); continue;
      }
      if (/^(?:预算(?:不用管了?|不限|不限制|取消(?:限制)?)|不限预算)$/.test(clause)) {
        changes.push({ op: 'remove', key: 'budget', source: source(clause) }); continue;
      }
      if (/^(?:不限颜色|颜色(?:不限|随便|不限制))$/.test(clause)) {
        changes.push({ op: 'remove', key: 'text:color', source: source(clause) }); continue;
      }
      const budget = clause.match(/^(?:预算\s*(?:(?:改成|改为|提高到|降到|最多|不超过|上限|是|为)\s*)?|最多\s*|不超过\s*)(\d{1,10}(?:\.\d{1,2})?)\s*(?:元|块)?(左右)?$/);
      if (budget) { set({ kind: 'budget', min: null, max: budget[1]! }, budget[2] ? 'preference' : 'hard'); continue; }
      const keyword = clause.match(/^(?:搜索\s+|改找\s*|换成\s*)(.{1,100})$/);
      if (keyword) { set({ kind: 'keyword', value: keyword[1]! }, 'hard', 'product'); continue; }
      const purpose = clause.match(/^(?:用途(?:改成|改为|是|为|：|:)?|用来|用于)\s*(.{1,160})$/);
      if (purpose) { changes.push({ op: 'purpose', value: purpose[1]!, source: source(clause) }); continue; }
      const color = clause.match(/^(?:颜色(?:改成|改为|要|选|：|:)?|(?:不要|排除)|(?:最好|偏好))\s*(红色|蓝色|黑色|白色|绿色|黄色)$/);
      if (color) { set({ kind: 'text', dimension: 'color', value: color[1]!, excluded: /^(?:不要|排除)/.test(clause) }, /^(?:最好|偏好)/.test(clause) ? 'preference' : 'hard', 'product'); continue; }
      const quantity = clause.match(/^(?:数量(?:改成|改为|是|为|：|:)?|要)\s*(\d{1,4})\s*(?:个|件|只)?$/);
      if (quantity && Number(quantity[1]) > 0) set({ kind: 'quantity', value: Number(quantity[1]) });
    }
  }
  return changes;
}

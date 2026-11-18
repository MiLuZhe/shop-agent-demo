import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeepSeekCopilot } from './agent/copilot.ts';
import { wireResponse, wireTool, wireSequence } from './test-helpers/agent-wire.ts';
import type { CopilotContext } from './chat/reception-assist.ts';
function context(): CopilotContext { return { history: [{ role: 'buyer', content: '请介绍本店商品', productId: null, skuId: null }], historyIncomplete: false, requirements: [], unresolved: [], signal: new AbortController().signal, deadline: Date.now()+10000, assertActive: async()=>{}, call: async()=>({items:[]}), audit: ()=>{} }; }

test('copilot Responses wire has only read-only shop tools, no persistence and bounded structured output', async()=>{
 const wire=wireSequence([body=>{
  assert.equal(body.model,'deepseek-flash');assert.equal(body.store,false);assert.equal(body.stream,undefined);assert.ok(body.max_output_tokens<=1200);
  assert.deepEqual(body.tools.map((tool: {name:string})=>tool.name).sort(),['getFilters','getProductDetails','listCategories','listTags','searchProducts'].sort());
  return wireResponse({content:'请确认你需要的规格。'});
 }]);
 const result=await createDeepSeekCopilot({apiKey:'wire-test-not-a-real-key',transport:wire.fetch,estimate:()=>100})(context());
 assert.deepEqual(result,{content:'请确认你需要的规格。'});assert.equal(wire.bodies.length,1);
});

test('copilot uses scoped shop tool callbacks and rejects tool failures even if provider returns a draft', async()=>{
 let calls=0;const wire=wireSequence([()=>wireResponse(wireTool('searchProducts',{})),()=>wireResponse({content:'根据已查询资料草拟'})]);
 const c=context();c.call=async(name)=>{calls++;assert.equal(name,'searchProducts');return{items:[]};};
 assert.deepEqual(await createDeepSeekCopilot({apiKey:'wire-test-not-a-real-key',transport:wire.fetch,estimate:()=>100})(c),{content:'根据已查询资料草拟'});assert.equal(calls,1);
 const denied=wireSequence([()=>wireResponse(wireTool('searchProducts',{})),()=>wireResponse({content:'不可提交'})]);
 const d=context();d.call=async()=>{throw Error('private error details');};
 await assert.rejects(createDeepSeekCopilot({apiKey:'wire-test-not-a-real-key',transport:denied.fetch,estimate:()=>100})(d),error=>error instanceof Error&&!error.message.includes('private error details'));
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
const work=path.join(homedir(),'.local/share/shop-agent-demo/verification/showcase-deploy-20261118');
const base=(process.env.SHOWCASE_URL??'https://127.0.0.1:8443').replace(/\/$/,'');
const local=base==='https://127.0.0.1:8443';
if(!local&&base!=='https://47.111.162.237')throw new Error('Unexpected showcase URL');
const output=path.join(work,local?'local-acceptance':'vps-acceptance');await mkdir(output,{recursive:true,mode:0o700});
const {accounts}=JSON.parse(await readFile(path.join(work,'demo-accounts.json'),'utf8'));
const shop='00000000-0000-4000-8000-000000000003';
const report={startedAt:new Date().toISOString(),base,localTestCertificate:local,viaSshTunnel:false,checks:[],realModel:true,sseConnections:0,pageErrorTypes:[]};
let phase='launch',browser;const contexts=[];const check=(name,data={})=>report.checks.push({name,passed:true,...data});
try{
 browser=await chromium.launch({args:['--no-proxy-server']});const actors={};
 for(const account of accounts){
  phase='login-'+account.kind;
  const context=await browser.newContext({ignoreHTTPSErrors:local,viewport:{width:1440,height:900}});contexts.push(context);
  const page=await context.newPage();page.on('pageerror',e=>report.pageErrorTypes.push(e.name));
  page.on('response',r=>{if(new URL(r.url()).pathname.endsWith('/events')&&r.status()===200)report.sseConnections++;});
  await page.goto(base+'/#/login');await page.getByLabel('账号',{exact:true}).fill(account.username);await page.getByLabel('密码',{exact:true}).fill(account.password);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'登录',exact:true}).click();const login=await response;assert.equal(login.status(),200);
  const cookie=(await login.allHeaders())['set-cookie']??'';assert.ok(/; Secure/i.test(cookie)&&/HttpOnly/i.test(cookie)&&/SameSite=Lax/i.test(cookie));
  await expect(page.getByRole('heading',{name:account.kind==='customer'?'我的账号':'卖家工作台',exact:true})).toBeVisible();
  const identity=(await (await context.request.get(base+'/api/auth/me')).json()).user;assert.equal(identity.username,account.username);
  actors[account.kind==='customer'?'buyer':account.role]={context,page};check('secure-login-'+account.username);
 }
 const {buyer,staff,owner}=actors;
 const get=async(actor,url)=>{const r=await actor.context.request.get(base+url);assert.equal(r.status(),200);return r.json();};
 const post=async(actor,url,data)=>{const r=await actor.context.request.post(base+url,{headers:{origin:base},data});assert.ok(r.ok(),`Request failed in ${phase}: ${r.status()}`);return r.json();};
 phase='role-isolation';
 assert.equal((await buyer.context.request.get(base+'/api/seller/overview')).status(),403);
 for(const actor of [staff,owner])assert.equal((await actor.context.request.get(base+'/api/cart')).status(),403);
 assert.equal((await staff.context.request.get(base+'/api/seller/members')).status(),403);
 assert.equal((await owner.context.request.get(base+'/api/seller/members')).status(),200);check('three-account-role-isolation');
 phase='catalogue';const catalogue=await get(buyer,'/api/products?pageSize=50');assert.equal(catalogue.total,30);
 const cup=(await get(buyer,'/api/products?q='+encodeURIComponent('水杯'))).items;assert.equal(cup.length,3);assert.ok(cup.every(p=>/杯/.test(p.name)));check('thirty-products-and-water-cup-search');
 await buyer.page.goto(base+'/#catalog');
 const publicImages=buyer.page.locator('.product-card img');await expect(publicImages.first()).toBeVisible({timeout:15000});
 for(let i=0;i<Math.min(await publicImages.count(),4);i++){const image=publicImages.nth(i);await image.scrollIntoViewIfNeeded();await expect.poll(()=>image.evaluate(i=>i.complete&&i.naturalWidth>0)).toBe(true);}
 await buyer.page.screenshot({path:path.join(output,'catalogue.png'),fullPage:true});check('visible-tos-product-images');
 // Availability is explicit: logging into a work account alone does not force human reception.
 await post(staff,'/api/seller/chat/availability',{available:false});await post(owner,'/api/seller/chat/availability',{available:false});
 await buyer.page.goto(base+`/#/messages/${shop}`);
 const state=()=>get(buyer,`/api/chat/shops/${shop}`);
 const initial=await state();if(initial.channel?.activeRound)await post(buyer,`/api/chat/rounds/${initial.channel.activeRound.id}/end`,{version:initial.channel.activeRound.version,lastSequence:initial.channel.latestSequence});
 const messages=async()=>{const current=await state();assert.ok(current.channel);return get(buyer,`/api/chat/channels/${current.channel.id}/messages?limit=50`);};
 async function ask(content,name,maxPrice){
  phase=name;const before=(await state()).channel?.latestSequence??0;
  await buyer.page.getByLabel('消息内容',{exact:true}).fill(content);const delivery=buyer.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/chat/shops/${shop}/messages`&&r.request().method()==='POST');await buyer.page.getByRole('button',{name:'发送消息',exact:true}).click();assert.ok((await delivery).ok());
  await expect.poll(async()=>{const s=await state();return s.channel?.activeRound?.agentRun?.status;},{timeout:70000,intervals:[500,1000]}).toBe('completed');
  const all=(await messages()).items;const reply=all.filter(m=>m.senderType==='agent'&&m.sequence>before).at(-1);assert.ok(reply,'Missing completed agent reply');
  const cards=reply.productCards??[];assert.ok(cards.length>=1&&cards.length<=3);assert.ok(cards.every(c=>Number(c.price)<=maxPrice));
  await expect(buyer.page.getByRole('article',{name:'导购助手消息',exact:true}).last()).toContainText(reply.content,{timeout:10000});
  check(name,{cards:cards.map(c=>({name:c.name,skuName:c.skuName,price:c.price,reason:c.reason}))});return{cards,reply};
 }
 await ask('我想买一个水杯，预算不超过100元，请推荐本店现在能买的商品。','live-water-cup',100);
 await ask('价格上限改成50元，其他要求不变，请继续推荐。','live-budget-follow-up',50);
 phase='new-round';let current=await state();await post(buyer,`/api/chat/rounds/${current.channel.activeRound.id}/end`,{version:current.channel.activeRound.version,lastSequence:current.channel.latestSequence});
 const related=await ask('请搜索“饮水器皿”，这是我本次的商品关键词，单价最多100元。如果没有完全匹配的，也请推荐1至3件用途相近的商品。','live-related-products',100);
 assert.equal(new Set(related.cards.map(c=>c.productId)).size,related.cards.length);assert.ok(related.cards.every(c=>c.reason.startsWith('相关选择：')));
 await buyer.page.screenshot({path:path.join(output,'agent-related.png'),fullPage:true});
 phase='product-card-navigation';const selected=related.cards[0];
 await buyer.page.getByRole('article',{name:'导购助手消息',exact:true}).last().getByRole('link',{name:`查看推荐商品：${selected.name}`,exact:true}).click();
 await expect(buyer.page.getByRole('region',{name:'商品详情',exact:true})).toBeVisible();assert.ok(buyer.page.url().includes(`sku=${selected.skuId}`));
 await expect(buyer.page.getByRole('radio',{checked:true})).toContainText(selected.skuName);check('recommended-sku-navigation');
 await buyer.page.goto(base+`/#/messages/${shop}`);await buyer.page.reload();
 await expect(buyer.page.getByRole('article',{name:'导购助手消息',exact:true}).last()).toContainText(related.reply.content);check('history-survives-refresh');
 phase='human-handoff';await staff.page.goto(base+'/#/seller/messages');
 await staff.page.getByRole('button',{name:'上线接待',exact:true}).click();await expect(staff.page.getByText('在线 · 等待分配',{exact:true})).toBeVisible();
 await buyer.page.getByRole('button',{name:'转人工',exact:true}).click();
 await expect.poll(async()=>(await state()).channel?.activeRound?.assignedSeller?.username,{timeout:12000}).toBe('staff_demo');
 current=await state();await staff.page.goto(base+`/#/seller/messages/${current.channel.activeRound.id}`);
 await expect(staff.page.getByLabel('消息内容',{exact:true})).toBeEnabled();
 const human='你好，我是演示店员，已接入并看到了前面的商品需求。';await staff.page.getByLabel('消息内容',{exact:true}).fill(human);await staff.page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(buyer.page.getByRole('region',{name:'聊天记录',exact:true}).getByText(human,{exact:true})).toBeVisible({timeout:10000});check('human-handoff-and-live-reply');
 const ownerRound=await get(owner,`/api/seller/chat/rounds/${current.channel.activeRound.id}`);assert.equal(ownerRound.round.canManage,true);assert.equal(ownerRound.round.canReply,false);check('owner-oversees-without-impersonating-assignee');
 await staff.page.screenshot({path:path.join(output,'staff-reception.png'),fullPage:true});
 phase='streaming';assert.ok(report.sseConnections>0);assert.deepEqual(report.pageErrorTypes,[]);check('sse-through-nginx',{connections:report.sseConnections});
 for(const {page} of Object.values(actors))assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));check('desktop-layout');
 // Leave a completed, inspectable test transcript rather than occupying staff capacity.
 current=await state();await post(buyer,`/api/chat/rounds/${current.channel.activeRound.id}/end`,{version:current.channel.activeRound.version,lastSequence:current.channel.latestSequence});await post(staff,'/api/seller/chat/availability',{available:false});
 report.passed=true;
}catch(error){report.passed=false;report.failedPhase=phase;report.errorType=error.name;report.errorLine=String(error.stack).match(/verify-showcase\.mjs:\d+:\d+/)?.[0];process.exitCode=1;}
finally{for(const context of contexts)await context.close().catch(()=>{});await browser?.close().catch(()=>{});report.completedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failedPhase:report.failedPhase,errorType:report.errorType}));}

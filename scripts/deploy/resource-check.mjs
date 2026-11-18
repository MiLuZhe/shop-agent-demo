import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { request } from '@playwright/test';
const work=path.join(homedir(),'.local/share/shop-agent-demo/verification/showcase-deploy-20261118');
const base=process.env.SHOWCASE_URL??'https://127.0.0.1:8443';const local=base==='https://127.0.0.1:8443';
if(!local&&base!=='https://47.111.162.237')throw new Error('Unexpected showcase URL');
const duration=Number(process.env.SHOWCASE_RESOURCE_SECONDS??(local?'180':'900'));if(!Number.isInteger(duration)||duration<30||duration>1200)throw new Error('Invalid resource-check duration');
const accounts=JSON.parse(await readFile(path.join(work,'demo-accounts.json'),'utf8')).accounts;
const contexts=await Promise.all(accounts.map(()=>request.newContext({baseURL:base,ignoreHTTPSErrors:local})));
const report={startedAt:new Date().toISOString(),base,viaSshTunnel:false,durationSeconds:duration,requests:0,failedRequests:0,samples:[],authentications:3};
const ssh=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ProxyCommand=none','-o','ProxyJump=none','aly_vps'];
const sampleProgram=await readFile(new URL('./sample-resources.py',import.meta.url),'utf8');
function sample(){
 const data=local?execFileSync('python3',['-c',sampleProgram,'shop-showcase-local'],{encoding:'utf8',timeout:15000}):execFileSync('ssh',[...ssh,'python3 - shop-agent-showcase'],{input:sampleProgram,encoding:'utf8',timeout:25000});return JSON.parse(data);
}

try{
 await Promise.all(contexts.map(async(c,i)=>{const response=await c.post('/api/auth/login',{headers:{origin:base},data:{username:accounts[i].username,password:accounts[i].password}});assert.equal(response.status(),200);}));
 const start=Date.now();let nextSample=0;
 while(Date.now()-start<duration*1000){
  if(Date.now()-start>=nextSample){report.samples.push({elapsedSeconds:Math.round((Date.now()-start)/1000),...sample()});nextSample+=15000;}
  await Promise.all(contexts.map(async(c,i)=>{const response=await c.get(i===0?'/api/chat/channels':'/api/seller/chat/rounds?view=mine');report.requests++;if(!response.ok())report.failedRequests++;await response.dispose();}));
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 report.samples.push({elapsedSeconds:duration,...sample()});
 assert.equal(report.failedRequests,0);
 for(const s of report.samples){for(const c of s.containers){assert.equal(c.restarts,0);assert.equal(c.oomKilled,false);assert.equal(Number(c.memoryEvents.oom_kill??0),0);assert.equal(c.health,'healthy');}if(!local)assert.ok(s.availableMiB>=200,'Insufficient VPS memory headroom');}
 report.passed=true;
}catch(error){report.passed=false;report.errorType=error.name;process.exitCode=1;}
finally{for(const c of contexts)await c.dispose();report.completedAt=new Date().toISOString();await writeFile(path.join(work,local?'local-resource.json':'vps-resource.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,requests:report.requests,failedRequests:report.failedRequests,samples:report.samples.length}));}

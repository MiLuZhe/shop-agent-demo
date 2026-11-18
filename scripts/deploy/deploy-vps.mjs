import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{readFile,writeFile}from'node:fs/promises';import{homedir}from'node:os';import path from'node:path';
const work=path.join(homedir(),'.local/share/shop-agent-demo/verification/showcase-deploy-20261118');
assert.equal(JSON.parse(await readFile(path.join(work,'upload-result.json'),'utf8')).payloadVerified,true);
const program=await readFile(new URL('./remote-deploy.py',import.meta.url),'utf8');
const result=await new Promise((resolve,reject)=>{const child=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=12','-o','ProxyCommand=none','-o','ProxyJump=none','aly_vps','python3 -'],{stdio:['pipe','inherit','inherit']});child.stdin.end(program);child.on('error',reject);child.on('exit',code=>resolve(code));});
await writeFile(path.join(work,'deploy-exit.json'),JSON.stringify({code:result,completedAt:new Date().toISOString()}));process.exitCode=result??1;

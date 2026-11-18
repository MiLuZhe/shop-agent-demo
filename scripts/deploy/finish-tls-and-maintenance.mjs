import{spawn}from'node:child_process';import{readFile,writeFile}from'node:fs/promises';import{homedir}from'node:os';import path from'node:path';
const work=path.join(homedir(),'.local/share/shop-agent-demo/verification/showcase-deploy-20261118');
const script=await readFile(new URL('./remote-maintenance.py',import.meta.url),'utf8');
const code=await new Promise((resolve,reject)=>{const c=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=12','-o','ProxyCommand=none','-o','ProxyJump=none','aly_vps','python3 -'],{stdio:['pipe','inherit','inherit']});c.stdin.end(script);c.on('error',reject);c.on('exit',resolve);});await writeFile(path.join(work,'maintenance-exit.json'),JSON.stringify({code,completedAt:new Date().toISOString()}));process.exitCode=code??1;

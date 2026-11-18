import assert from 'node:assert/strict';import{Agent,fetch as directFetch}from'undici';import{spawn,execFileSync}from'node:child_process';import{readFile,writeFile}from'node:fs/promises';import{homedir}from'node:os';import path from'node:path';import{randomBytes}from'node:crypto';
const work=path.join(homedir(),'.local/share/shop-agent-demo/verification/showcase-deploy-20261118');assert.equal(JSON.parse(await readFile(path.join(work,'deploy-exit.json'),'utf8')).code,0);
const dispatcher=new Agent({connect:{timeout:10000}});const fetch=(url,options)=>directFetch(url,{...options,dispatcher});
const ssh=['-o','BatchMode=yes','-o','ConnectTimeout=12','-o','ProxyCommand=none','-o','ProxyJump=none','aly_vps'];const token=randomBytes(12).toString('hex');
const prepare=`import subprocess,pathlib,json\np=pathlib.Path('/home/miluzhe/apps/shop-agent-showcase');tag=json.loads((p/'images.lock.json').read_text())['images']['web']['tag']\nsubprocess.run(['docker','run','--rm','--network=none','--memory','64m','--entrypoint','sh','-v','shop-agent-showcase_acme:/acme',tag,'-c','mkdir -p /acme/.well-known/acme-challenge && printf %s ${token} > /acme/.well-known/acme-challenge/showcase-probe'],check=True)\n`;
execFileSync('ssh',[...ssh,'python3 -'],{input:prepare,stdio:['pipe','inherit','inherit']});
const probe=await fetch('http://47.111.162.237/.well-known/acme-challenge/showcase-probe',{signal:AbortSignal.timeout(12000),redirect:'error'});assert.equal(probe.status,200,'Public HTTP challenge must be reachable');assert.equal(await probe.text(),token);
const program=`import pathlib,subprocess,json,datetime,sys
root=pathlib.Path('/home/miluzhe/apps/shop-agent-showcase');base=['docker','compose','--project-name','shop-agent-showcase','--project-directory',str(root),'-f',str(root/'compose.yaml')];phase='staging';r={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
def run(args,**kwargs):return subprocess.run(args,check=True,cwd=root,**kwargs)
try:
 common=base+['run','--rm','certbot','certonly','--webroot','--webroot-path','/var/www/acme','--ip-address','47.111.162.237','--preferred-profile','shortlived','--register-unsafely-without-email','--agree-tos','--non-interactive']
 run(common+['--staging','--cert-name','47.111.162.237-staging'])
 phase='trusted-certificate';run(common+['--cert-name','47.111.162.237'])
 phase='https-start';env=root/'.env';text=env.read_text();text=text.replace("TLS_MODE='bootstrap'","TLS_MODE='https'");env.write_text(text);env.chmod(0o600)
 run(base+['up','-d','--wait','--wait-timeout','90','web']);run(base+['exec','-T','web','nginx','-t'])
 phase='tls-validation';curl=['curl','--noproxy','*','--silent','--resolve','47.111.162.237:443:127.0.0.1','--max-time','15','--output','/dev/null','--write-out','%{http_code}'];status=subprocess.check_output(curl+['https://47.111.162.237/api/health'],text=True).strip()
 if status!='200':raise RuntimeError('Trusted HTTPS API health failed')
 phase='remove-staging';run(base+['run','--rm','certbot','delete','--cert-name','47.111.162.237-staging','--non-interactive'])
 r.update(passed=True,trustedHttpsApi=200,publicHttpChallengeVerified=True,stagingPassed=True,completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
except Exception as e:r.update(passed=False,phase=phase,errorType=type(e).__name__)
(root/'https-result.json').write_text(json.dumps(r,indent=2));print(json.dumps(r));sys.exit(0 if r['passed']else 1)
`;
const code=await new Promise((resolve,reject)=>{const c=spawn('ssh',[...ssh,'python3 -'],{stdio:['pipe','inherit','inherit']});c.stdin.end(program);c.on('error',reject);c.on('exit',resolve);});
if(code===0){const response=await fetch('https://47.111.162.237/api/health',{signal:AbortSignal.timeout(15000),redirect:'error'});assert.equal(response.status,200);}
await writeFile(path.join(work,'https-exit.json'),JSON.stringify({code,completedAt:new Date().toISOString()}));await dispatcher.destroy();process.exitCode=code??1;

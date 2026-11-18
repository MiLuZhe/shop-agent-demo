import assert from 'node:assert/strict';import{execFileSync,spawn}from'node:child_process';import{readFile,writeFile,copyFile,chmod,stat}from'node:fs/promises';import{homedir}from'node:os';import path from'node:path';import{createHash}from'node:crypto';
const work=path.join(homedir(),'.local/share/shop-agent-demo/verification/showcase-deploy-20261118'),remote='/home/miluzhe/apps/shop-agent-showcase';
for(const file of ['local-acceptance/report.json','local-resource.json','local-static/report.json'])assert.equal(JSON.parse(await readFile(path.join(work,file),'utf8')).passed,true,'Local acceptance must pass before upload');
assert.equal(JSON.parse(await readFile(path.join(work,'backend-full-result.json'),'utf8')).code,0);assert.equal(JSON.parse(await readFile(path.join(work,'artifact-validation.json'),'utf8')).imageLockVerified,true);
const ssh=['-o','BatchMode=yes','-o','ConnectTimeout=12','-o','ProxyCommand=none','-o','ProxyJump=none'];
execFileSync('ssh',[...ssh,'aly_vps','python3 -'],{input:`from pathlib import Path\np=Path('${remote}')\nif p.exists() and any(p.iterdir()) and not (p/'images.lock.json').exists():raise SystemExit('Target directory is not an existing showcase release')\np.mkdir(parents=True,exist_ok=True,mode=0o700)\np.chmod(0o700)\n(Path.home()/'.docker/cli-plugins').mkdir(parents=True,exist_ok=True,mode=0o700)\n`,stdio:['pipe','inherit','inherit']});
const payload={
 'compose.yaml':path.join(work,'production/compose.yaml'),'.env':path.join(work,'production/.env'),'api.env':path.join(work,'production/api.env'),'postgres.env':path.join(work,'production/postgres.env'),
 'demo.dump':path.join(work,'release/demo.dump'),'images.lock.json':path.join(work,'release/images.lock.json'),'archive.json':path.join(work,'release/archive.json'),
 'images.tar.gz':path.join(work,'release/images.tar.gz'),'renew-certificate.sh':'deploy/renew-certificate.sh','backup-database.sh':'deploy/backup-database.sh','stop-showcase.sh':'deploy/stop-showcase.sh',
};
const manifest={createdAt:new Date().toISOString(),release:JSON.parse(await readFile(payload['images.lock.json'],'utf8')).release,files:{}};
for(const[name,file]of Object.entries(payload)){const b=await readFile(file);manifest.files[name]={bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};}
await writeFile(path.join(work,'release/payload.json'),JSON.stringify(manifest,null,2),{mode:0o600});payload['payload.json']=path.join(work,'release/payload.json');
for(const[name,file]of Object.entries(payload)){
 console.log(JSON.stringify({uploading:name,bytes:(await stat(file)).size}));
 await new Promise((resolve,reject)=>{const c=spawn('scp',[...ssh,'-o','Compression=no',file,`aly_vps:${remote}/${name}.upload`],{stdio:['ignore','inherit','inherit']});c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(new Error('Encrypted release upload failed')));});
 execFileSync('ssh',[...ssh,'aly_vps','python3 -'],{input:`from pathlib import Path\nimport os\np=Path('${remote}/${name}.upload');p.chmod(0o600);os.replace(p,Path('${remote}/${name}'))\n`,stdio:['pipe','ignore','inherit']});
}
// A local Compose binary avoids installing host Node or changing daemon services.
const plugin='/usr/libexec/docker/cli-plugins/docker-compose';
const existing=execFileSync('ssh',[...ssh,'aly_vps','docker compose version --short 2>/dev/null || true'],{encoding:'utf8'}).trim();
if(!existing){await new Promise((resolve,reject)=>{const c=spawn('scp',[...ssh,plugin,'aly_vps:/home/miluzhe/.docker/cli-plugins/docker-compose.upload'],{stdio:['ignore','inherit','inherit']});c.on('exit',code=>code===0?resolve():reject(new Error('Compose upload failed')));c.on('error',reject);});execFileSync('ssh',[...ssh,'aly_vps','python3 -'],{input:"from pathlib import Path\np=Path.home()/'.docker/cli-plugins/docker-compose.upload';p.chmod(0o755);p.rename(p.with_name('docker-compose'))\n",stdio:['pipe','ignore','inherit']});}
execFileSync('ssh',[...ssh,'aly_vps','python3 -'],{input:`from pathlib import Path\nimport json,hashlib\np=Path('${remote}');m=json.loads((p/'payload.json').read_text())\nfor n,v in m['files'].items():\n f=p/n\n if f.stat().st_size!=v['bytes']:raise SystemExit('Payload size mismatch')\n h=hashlib.sha256()\n with f.open('rb') as stream:\n  for chunk in iter(lambda:stream.read(1048576),b''):h.update(chunk)\n if h.hexdigest()!=v['sha256']:raise SystemExit('Payload checksum mismatch')\nfor n in ['renew-certificate.sh','backup-database.sh','stop-showcase.sh']:(p/n).chmod(0o750)\nprint(json.dumps({'release':m['release'],'payloadChecksumsVerified':True,'credentialsPrinted':False}))\n`,stdio:['pipe','inherit','inherit']});
await writeFile(path.join(work,'upload-result.json'),JSON.stringify({completedAt:new Date().toISOString(),release:manifest.release,payloadVerified:true,encryptedSsh:true,remoteDirectory:remote},null,2));

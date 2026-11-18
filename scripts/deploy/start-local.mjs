import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const work=path.join(homedir(),'.local/share/shop-agent-demo/verification/showcase-deploy-20261118'),directory=path.join(work,'local');
const args=['compose','--project-name','shop-showcase-local','--project-directory',directory,'-f',path.join(directory,'compose.yaml')];
const compose=(...a)=>execFileSync('docker',[...args,...a],{stdio:'inherit'});
compose('config','--quiet');compose('up','-d','--wait','--wait-timeout','60','postgres');
const count=execFileSync('docker',[...args,'exec','-T','postgres','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname=\x27public\x27"'],{encoding:'utf8'}).trim();
if(count==='0'){
 const r=spawnSync('docker',[...args,'exec','-T','postgres','sh','-c','exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error'],{input:readFileSync(path.join(work,'release/demo.dump')),stdio:['pipe','ignore','pipe']});
 if(r.status!==0)throw new Error('Release database restore failed; inspect the isolated database');
}
const lock=JSON.parse(readFileSync(path.join(work,'release/images.lock.json'),'utf8'));
execFileSync('docker',['run','--rm','--network=none','--entrypoint','sh','--memory','64m','-v','shop-showcase-local_certificates:/target','-v',`${path.join(work,'local-certificate')}:/source:ro`,lock.images.web.tag,'-c','mkdir -p /target/live/127.0.0.1 && cp /source/*.pem /target/live/127.0.0.1/ && chmod 600 /target/live/127.0.0.1/privkey.pem'],{stdio:'inherit'});
compose('up','-d','--wait','--wait-timeout','90','api','web');
console.log('Isolated production containers are ready at https://127.0.0.1:8443 (local test certificate only).');

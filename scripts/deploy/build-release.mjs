import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
const work=path.join(homedir(),'.local/share/shop-agent-demo/verification/showcase-deploy-20261118'),build=path.join(work,'build');
if(!process.argv.includes('--reuse-generated'))execFileSync('pnpm',['db:generate'],{stdio:'inherit'});
execFileSync('pnpm',['--filter','@shop/web','build'],{stdio:'inherit'});
rmSync(path.join(build,'api'),{recursive:true,force:true});
execFileSync('pnpm',['--filter','@shop/api','deploy','--legacy','--prod','--offline',path.join(build,'api')],{stdio:'inherit'});
function pruneTests(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){if(e.name==='test-helpers')rmSync(p,{recursive:true,force:true});else pruneTests(p);}else if(/\.test\.[cm]?tsx?$/.test(e.name))rmSync(p);}}
pruneTests(path.join(build,'api/src'));
const imageInfo=tag=>JSON.parse(execFileSync('docker',['image','inspect',tag],{encoding:'utf8'}))[0];
const bases={node:imageInfo('node:24.21.0-bookworm-slim'),nginx:imageInfo('nginx:stable-alpine'),postgres:imageInfo('postgres:17.11-bookworm'),certbot:imageInfo('certbot/certbot:v5.4.0')};
const hash=createHash('sha256');
function hashTree(dir){for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,e.name);if(e.isDirectory())hashTree(p);else if(e.isFile()){hash.update(p);hash.update(readFileSync(p));}}}
for(const d of ['apps/shop-api/src','apps/shop-api/assets','packages/contracts/src','packages/database/src','deploy'])hashTree(d);
hash.update(readFileSync('pnpm-lock.yaml'));const release='20261118-'+hash.digest('hex').slice(0,12);
if(!existsSync(path.join(build,'api/node_modules/@shop/database/src/generated/client.ts')))throw new Error('Prepare the production dependency package first');
cpSync('apps/web/dist',path.join(build,'web'),{recursive:true});cpSync('deploy/nginx',path.join(build,'nginx'),{recursive:true});cpSync('deploy/web-entrypoint.sh',path.join(build,'web-entrypoint.sh'));
function compress(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())compress(p);else if(/\.(js|css|svg|html)$/.test(e.name))writeFileSync(p+'.gz',gzipSync(readFileSync(p),{level:9}));}}
compress(path.join(build,'web'));
const tags={api:`shop-showcase-api:${release}`,web:`shop-showcase-web:${release}`,postgres:`shop-showcase-postgres:${release}`,certbot:`shop-showcase-certbot:${release}`};
execFileSync('docker',['build','--network=none','--build-arg',`NODE_IMAGE=${bases.node.RepoDigests[0]}`,'-f','deploy/Dockerfile.api','-t',tags.api,build],{stdio:'inherit'});
execFileSync('docker',['build','--network=none','--build-arg',`NGINX_IMAGE=${bases.nginx.RepoDigests[0]}`,'-f','deploy/Dockerfile.web','-t',tags.web,build],{stdio:'inherit'});
execFileSync('docker',['tag','postgres:17.11-bookworm',tags.postgres]);execFileSync('docker',['tag','certbot/certbot:v5.4.0',tags.certbot]);
const images=Object.fromEntries(Object.entries(tags).map(([name,tag])=>{const i=imageInfo(tag);return[name,{tag,id:i.Id,layers:i.RootFS.Layers,sourceDigest:bases[name]?.RepoDigests?.[0]??null}];}));
const out=path.join(work,'release');mkdirSync(out,{recursive:true,mode:0o700});cpSync('deploy/compose.yaml',path.join(out,'compose.yaml'));
writeFileSync(path.join(out,'images.lock.json'),JSON.stringify({release,platform:'linux/amd64',createdAt:new Date().toISOString(),images,bases:Object.fromEntries(Object.entries(bases).map(([k,v])=>[k,v.RepoDigests[0]]))},null,2));
writeFileSync(path.join(work,'build-result.json'),JSON.stringify({release,images:tags,buildNetwork:'none',apiProductionPackage:true,frontendPrecompressed:true},null,2));
console.log(JSON.stringify({release,images:tags}));

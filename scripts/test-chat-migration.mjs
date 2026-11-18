import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { open, readFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../packages/database/src/index.ts';
import { DEFAULT_SHOP_ID } from '../packages/contracts/src/common.ts';
process.loadEnvFile(new URL('../.env', import.meta.url));
const [dump] = process.argv.slice(2);
if (!dump) throw new Error('Usage: test-chat-migration.mjs pre-chat.dump');
const admin=createDatabase(), name=`chat_migration_${randomUUID().replaceAll('-','').slice(0,12)}`;
const url=new URL(process.env.DATABASE_URL); url.pathname=`/${name}`;
const env={...process.env,DATABASE_URL:url.toString()}, isolated=createDatabase(url.toString());
const temporary=await mkdtemp(join(tmpdir(),'shop-chat-migration-'));
async function run(command,args,inputFile) {
 const input=inputFile ? await open(inputFile,'r') : null;
 try { await new Promise((resolve,reject)=> {
  const child=spawn(command,args,{env,stdio:[input?.fd??'ignore','pipe','pipe']}); let output='';
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${command} failed: ${output.replaceAll(url.toString(),'[database URL]')}`)));
 }); } finally { await input?.close(); }
}
let created=false;
try {
 await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);created=true;
 await run('docker',['compose','exec','-T','postgres','pg_restore','-U','shop_agent','-d',name,'--no-owner'],dump);
 const buyer=randomUUID(), rounds=[randomUUID(),randomUUID()], messages=[randomUUID(),randomUUID()];
 await isolated.$executeRaw`INSERT INTO users(id,username,display_name) VALUES (${buyer}::uuid,${`migration_${buyer.replaceAll('-','')}`},'旧咨询测试')`;
 for (let i=0;i<2;i++) {
  await isolated.$executeRaw`INSERT INTO conversations(id,shop_id,buyer_id,status) VALUES (${rounds[i]}::uuid,${DEFAULT_SHOP_ID}::uuid,${buyer}::uuid,${i===0?'closed':'waiting_seller'})`;
  await isolated.$executeRaw`INSERT INTO messages(id,conversation_id,sender_type,sender_user_id,content) VALUES (${messages[i]}::uuid,${rounds[i]}::uuid,'buyer',${buyer}::uuid,${`历史消息${i}`})`;
 }
 const snapshot=join(temporary,'legacy.json');
 await run(process.execPath,['--import','tsx','scripts/verify-chat-migration.mjs','before',snapshot]);
 // A genuine legacy conflict must abort the whole migration without partial DDL.
 const conflict=randomUUID();
 await isolated.$executeRaw`INSERT INTO conversations(id,shop_id,buyer_id,status) VALUES (${conflict}::uuid,${DEFAULT_SHOP_ID}::uuid,${buyer}::uuid,'waiting_seller')`;
 const migration=await readFile(new URL('../packages/database/prisma/migrations/202610210002_chat_channels/migration.sql',import.meta.url),'utf8');
 const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg'), client=new pg.Client({connectionString:url.toString()});await client.connect();
 try {
  await assert.rejects(client.query(migration),/Multiple active legacy conversations/); await client.query('ROLLBACK');
  assert.equal((await client.query("SELECT to_regclass('public.chat_channels') AS name")).rows[0].name,null);
 } finally {await client.end();}
 await isolated.$executeRaw`DELETE FROM conversations WHERE id=${conflict}::uuid`;
 await run('pnpm',['db:migrate']);
 await run(process.execPath,['--import','tsx','scripts/verify-chat-migration.mjs','after',snapshot]);
 const channels=await isolated.chatChannel.findMany({where:{buyer_id:buyer}});assert.equal(channels.length,1);
 const migrated=await isolated.conversation.findMany({where:{buyer_id:buyer},orderBy:{created_at:'asc'}});
 assert.equal(migrated.length,2);assert.ok(migrated.every(r=>r.channel_id===channels[0].id));
 assert.ok(migrated.find(r=>r.status==='closed').ended_at);assert.equal(migrated.find(r=>r.status!=='closed').ended_at,null);
 const history=await isolated.message.findMany({where:{channel_id:channels[0].id},orderBy:{sequence:'asc'}});
 assert.deepEqual(history.map(r=>r.sequence),[1,2]);assert.equal(channels[0].next_sequence,2);
 await run('pnpm',['db:migrate']); // Deployment itself must be repeatable.
 console.log('Restored old database: conflict rollback, all 18 original tables preserved, historical rounds/messages backfilled, 19 tables and repeatable migration passed.');
} finally {
 await isolated.$disconnect();
 if(created){await admin.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${name} AND pid<>pg_backend_pid()`;await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);}
 await admin.$disconnect();
}

import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createDatabase } from '../packages/database/src/index.ts';
import { checkDemoSeed } from './check-demo-seed.mjs';
process.loadEnvFile(new URL('../.env', import.meta.url));
const [dump, snapshot] = process.argv.slice(2);
if (!dump || !snapshot) throw new Error('Usage: node --import tsx scripts/test-account-migration.mjs old.dump legacy-data.json');
const temporaryDatabase = `account_migration_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const url = new URL(process.env.DATABASE_URL); url.pathname = `/${temporaryDatabase}`;
const env = { ...process.env, DATABASE_URL: url.toString() };
async function run(command, args, inputFile) {
  const input = inputFile ? await open(inputFile, 'r') : null;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { env, stdio: [input?.fd ?? 'ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
      child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${output.replaceAll(url.toString(), '[database URL]')}`)));
    });
  } finally { await input?.close(); }
}
const admin = createDatabase(); let created = false;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${temporaryDatabase}"`); created = true;
  await run('docker', ['compose','exec','-T','postgres','pg_restore','-U','shop_agent','-d',temporaryDatabase,'--no-owner'], dump);
  await run('pnpm', ['db:migrate']);
  await run(process.execPath, ['--import','tsx','scripts/verify-account-migration.mjs','after',snapshot]);
  const isolated = createDatabase(url.toString());
  try {
    const tables = await isolated.$queryRaw`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'_prisma_migrations'`;
    if (tables[0].count !== 17) throw new Error('Isolated database did not migrate to 17 tables');
    if (await isolated.user.count({ where: { platform_role: 'admin' } }) !== 0) throw new Error('Migration unexpectedly granted platform admin');
    await checkDemoSeed(isolated, () => run('pnpm', ['db:seed']));
    const demo = await isolated.user.findUniqueOrThrow({ where: { id: '00000000-0000-4000-8000-000000000001' } });
    const userCount = await isolated.user.count();
    await isolated.user.update({ where: { id: demo.id }, data: { username: 'buyer_demo_after_rename', display_name: '改名后种子验收' } });
    await checkDemoSeed(isolated, () => run('pnpm', ['db:seed']));
    if (await isolated.user.count() !== userCount || await isolated.user.findUnique({ where: { username: demo.username } })) throw new Error('Seed recreated a renamed demo account');
    const renamed = await isolated.user.findUniqueOrThrow({ where: { id: demo.id } });
    if (renamed.username !== 'buyer_demo_after_rename' || renamed.display_name !== '改名后种子验收' || renamed.password_hash !== demo.password_hash) throw new Error('Seed reset a renamed demo identity');
    const retired = await isolated.accountName.findUniqueOrThrow({ where: { username: demo.username } });
    if (!retired.retired_at) throw new Error('Old account name was not reserved');
    if (await isolated.user.count({ where: { platform_role: 'admin' } }) !== 0) throw new Error('Seed unexpectedly granted platform admin');
  } finally { await isolated.$disconnect(); }
  console.log('Account migration restore, 17 tables, original row preservation and rename-safe repeated seeds passed.');
} finally {
  if (created) {
    await admin.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${temporaryDatabase} AND pid<>pg_backend_pid()`;
    await admin.$executeRawUnsafe(`DROP DATABASE "${temporaryDatabase}"`);
    console.log('Isolated migration test database removed.');
  }
  await admin.$disconnect();
}

import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createDatabase } from '../packages/database/src/index.ts';
process.loadEnvFile(new URL('../.env', import.meta.url));
const [dump, snapshot] = process.argv.slice(2);
if (!dump || !snapshot) throw new Error('Usage: node --import tsx scripts/test-shop-migration.mjs old.dump legacy-data.json');
const temporaryDatabase = `shop_migration_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
  await run(process.execPath, ['--import','tsx','scripts/verify-shop-migration.mjs','after',snapshot]);
  const isolated = createDatabase(url.toString());
  try {
    const tables = await isolated.$queryRaw`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'_prisma_migrations'`;
    if (tables[0].count !== 16) throw new Error('Isolated database did not migrate to 16 tables');
    const before = await isolated.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, password_hash: true } });
    await run('pnpm', ['db:seed']); await run('pnpm', ['db:seed']);
    const after = await isolated.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, password_hash: true } });
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Seed changed existing user identities or credentials');
    await run(process.execPath, ['--import','tsx','scripts/verify-shop-migration.mjs','after',snapshot]);
  } finally { await isolated.$disconnect(); }
  console.log('Isolated old-database restore, migration, row preservation and two seed reruns passed.');
} finally {
  if (created) {
    await admin.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${temporaryDatabase} AND pid<>pg_backend_pid()`;
    await admin.$executeRawUnsafe(`DROP DATABASE "${temporaryDatabase}"`);
    console.log('Isolated migration test database removed.');
  }
  await admin.$disconnect();
}

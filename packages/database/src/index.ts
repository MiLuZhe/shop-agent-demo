import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.ts';

export { Prisma } from './generated/client.ts';
export type { PrismaClient } from './generated/client.ts';

export function databasePoolMax(raw?: string) {
  if (raw === undefined) return 10;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 20) throw new Error('Invalid DATABASE_POOL_MAX');
  return Number(raw);
}

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: 5000, max: databasePoolMax(process.env.DATABASE_POOL_MAX) });
  return new PrismaClient({ adapter });
}

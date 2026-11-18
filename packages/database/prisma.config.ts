import { defineConfig } from 'prisma/config';

// Resolve the root .env independently of the shell working directory.
process.loadEnvFile(new URL('../../.env', import.meta.url));

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL! },
});

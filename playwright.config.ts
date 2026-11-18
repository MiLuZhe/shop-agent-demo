import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const environmentFile = new URL('./.env', import.meta.url);
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);

// Keep readiness checks on loopback even when the developer shell uses an HTTP proxy.
const localBypass = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
process.env.NO_PROXY = localBypass;
process.env.no_proxy = localBypass;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90000, // Includes a real login limiter Retry-After (at most 60 seconds).
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
  webServer: [
    { command: 'pnpm dev:api', url: 'http://127.0.0.1:3000/api/health', reuseExistingServer: !process.env.CI, timeout: 30000 },
    { command: 'pnpm dev:web', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI, timeout: 30000 },
  ],
});

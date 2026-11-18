import type { Page } from '@playwright/test';
// UI tests share one loopback IP and intentionally switch many accounts. Respect
// the real limiter rather than weakening it or trusting spoofed forwarding headers.
export async function submitLogin(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const response = await responsePromise;
    if (response.status() !== 429) return;
    if (attempt === 1) throw new Error('登录限流重试仍被拒绝');
    const seconds = Number(response.headers()['retry-after']);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error('登录限流缺少有效 Retry-After');
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 200));
  }
}
export async function openAccount(page: Page, section: '个人资料' | '账号与安全' = '个人资料') {
  const panel = page.getByRole('dialog', { name: '账号菜单', exact: true });
  if (!await panel.isVisible()) await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  await panel.getByRole('link', { name: section, exact: true }).click();
}
export async function logoutFromMenu(page: Page) {
  const panel = page.getByRole('dialog', { name: '账号菜单', exact: true });
  if (!await panel.isVisible()) await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  await panel.getByRole('button', { name: '退出登录', exact: true }).click();
}

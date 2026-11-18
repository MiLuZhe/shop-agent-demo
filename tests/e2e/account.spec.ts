import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import { DEFAULT_SHOP_ID } from '../../packages/contracts/src/common.ts';
import { submitLogin, openAccount } from './login.ts';

const test = base.extend<{ account: { names: string[]; ids: string[]; login: (index: number, username?: string) => Promise<void>; changeOutside: () => Promise<void> } }>({
  account: async ({ page }, use) => {
    const db = createDatabase(), prefix = `account_ui_${randomUUID().slice(0, 8)}`, ids = [randomUUID(), randomUUID()], names = ids.map((_, i) => `${prefix}_${i}`);
    try {
      const password_hash = await hashPassword('AccountUi123!');
      await db.user.createMany({ data: ids.map((id, i) => ({ id, username: names[i]!, display_name: '同名用户', password_hash })) });
      await db.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: ids[1]!, role: 'owner' } });
      await use({ names, ids, login: async (index, username = names[index]!) => {
        await page.goto('/#/login'); await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill('AccountUi123!'); await submitLogin(page);
        await expect(page.getByRole('heading', { name: index === 1 ? '卖家工作台' : '我的账号', exact: true })).toBeVisible();
      }, changeOutside: async () => {
        const row = await db.user.findUniqueOrThrow({ where: { id: ids[0] } });
        await db.user.update({ where: { id: ids[0] }, data: { display_name: '另一页面的昵称', updated_at: new Date(Math.max(Date.now(), row.updated_at.getTime() + 1)) } });
      } });
    } finally {
      await db.shopMember.deleteMany({ where: { user_id: { in: ids } } }); await db.user.deleteMany({ where: { id: { in: ids } } }); await db.$disconnect();
    }
  },
});
test('top-right account menu edits nicknames and accounts, retires old names and preserves invitation identity', async ({ page, account }, info) => {
  await account.login(0); await page.locator('.store-nav').getByRole('link', { name: '发现好物', exact: true }).click();
  const entry = page.getByRole('button', { name: '账号菜单', exact: true }); await expect(entry).toBeVisible();
  const entryBox = await entry.boundingBox(), brandBox = await page.getByRole('link', { name: '拾物首页', exact: true }).boundingBox(); expect(entryBox!.x).toBeGreaterThan(brandBox!.x);
  await openAccount(page); await page.getByLabel('昵称', { exact: true }).fill('新的重复昵称'); await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await expect(entry).toHaveAttribute('title', new RegExp('新的重复昵称')); await expect(page.getByRole('status').filter({ hasText: '昵称已保存' })).toBeVisible();
  await openAccount(page, '账号与安全'); await page.getByRole('button', { name: '修改账号', exact: true }).click();
  const next = `${account.names[0]}_new`; await page.getByLabel('新账号', { exact: true }).fill(next); await page.getByRole('button', { name: '检查账号是否可用', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: '账号可以使用' })).toBeVisible();
  await page.getByLabel('当前密码', { exact: true }).fill('wrong'); await page.getByRole('button', { name: '保存账号并重新登录', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('当前密码不正确');
  await page.getByLabel('当前密码', { exact: true }).fill('AccountUi123!'); await page.getByRole('button', { name: '保存账号并重新登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号登录', exact: true })).toBeVisible(); await expect(page.getByLabel('账号', { exact: true })).toHaveValue(next); await expect(page.getByRole('status')).toContainText('请使用新账号重新登录');
  await page.getByLabel('账号', { exact: true }).fill(account.names[0]!); await page.getByLabel('密码', { exact: true }).fill('AccountUi123!'); await submitLogin(page); await expect(page.getByRole('alert')).toContainText('账号或密码错误');
  await page.getByLabel('账号', { exact: true }).fill(next); await page.getByLabel('密码', { exact: true }).fill('AccountUi123!'); await submitLogin(page); await expect(page.locator('.account-card').getByText(next, { exact: true })).toBeVisible();
  for (const path of ['/api/auth/me','/api/account']) { const response = await page.request.get(path); const body = await response.text(); expect(response.status()).toBe(200); for (const id of account.ids) expect(body).not.toContain(id); }
  await openAccount(page, '账号与安全'); await page.getByRole('button', { name: '修改账号', exact: true }).click(); await page.getByLabel('新账号', { exact: true }).fill(account.names[0]!); await page.getByRole('button', { name: '检查账号是否可用', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: '账号已被使用或保留' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath('account-management.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await account.login(1); await page.getByRole('link', { name: '店员管理', exact: true }).click();
  expect((await page.request.post('/api/seller/members', { data: { username: account.names[0], role: 'staff' } })).status()).toBe(404);
  await page.getByRole('button', { name: '添加成员', exact: true }).click(); await page.getByLabel('成员账号', { exact: true }).fill(next); await page.getByRole('button', { name: '确认添加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不能将个人买家账号添加为店员'); await expect(page.getByRole('dialog', { name: '添加成员', exact: true })).toBeVisible();
  const members = await page.request.get('/api/seller/members'); for (const id of account.ids) expect(await members.text()).not.toContain(id);
});
test('unavailable accounts and stale nickname edits recover without changing another user', async ({ page, account }) => {
  await account.login(0); await openAccount(page, '账号与安全'); await page.getByRole('button', { name: '修改账号', exact: true }).click(); await page.getByLabel('新账号', { exact: true }).fill(account.names[1]!); await page.getByRole('button', { name: '检查账号是否可用', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: '账号已被使用或保留' })).toBeVisible();
  await page.getByLabel('当前密码', { exact: true }).fill('AccountUi123!'); await page.getByRole('button', { name: '保存账号并重新登录', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('账号已被使用或保留');
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await openAccount(page); await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('同名用户'); await account.changeOutside(); await page.getByLabel('昵称', { exact: true }).fill('旧页面的修改'); await page.getByRole('button', { name: '保存昵称', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('资料已更新');
  await page.getByRole('button', { name: '重新加载账号资料', exact: true }).click(); await expect(page.getByLabel('昵称', { exact: true })).toHaveValue('另一页面的昵称'); await expect(page.locator('.profile-username')).toHaveText(account.names[0]!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('avatar menu is on the right, supports dismissal and uses a stable local avatar', async ({ page, account }, info) => {
  await account.login(0);
  await expect(page.locator('.store-nav').getByRole('link', { name: '我的账号', exact: true })).toHaveCount(0);
  const cardBox = await page.locator('.account-card').boundingBox(); expect(Math.abs(cardBox!.x + cardBox!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(2);
  await expect(page.locator('.account-card')).not.toContainText('普通用户'); await expect(page.locator('.account-card')).not.toContainText('平台身份'); await expect(page.getByLabel('任职信息', { exact: true })).toHaveCount(0);
  const trigger = page.getByRole('button', { name: '账号菜单', exact: true }), avatar = trigger.locator('.user-avatar');
  await expect(avatar).toHaveText('A'); const color = await avatar.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.reload(); await expect(avatar).toHaveText('A'); expect(await avatar.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(color);
  await trigger.click(); const panel = page.getByRole('dialog', { name: '账号菜单', exact: true }); await expect(panel).toContainText(account.names[0]!);
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter'); await expect(panel).toBeVisible(); await page.getByRole('link', { name: '拾物首页', exact: true }).click(); await expect(panel).toHaveCount(0);
  await trigger.click(); const box = await panel.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath('account-menu.png'), fullPage: true });
  await panel.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(trigger).toHaveCount(0); expect((await page.request.get('/api/account')).status()).toBe(401);
});
test('password form rejects mismatches and wrong passwords, then requires a new-password login', async ({ page, account }) => {
  await account.login(0); await openAccount(page, '账号与安全');
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true }); await expect(dialog).toBeVisible();
  await page.getByLabel('修改密码的当前密码', { exact: true }).fill('discard-me'); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '修改密码', exact: true }).click(); await expect(page.getByLabel('修改密码的当前密码', { exact: true })).toHaveValue('');
  const next = 'NewUiPassword123!';
  await page.getByLabel('修改密码的当前密码', { exact: true }).fill('AccountUi123!'); await page.getByLabel('新密码', { exact: true }).fill(next); await page.getByLabel('确认新密码', { exact: true }).fill('DifferentUi123!');
  await page.getByRole('button', { name: '保存密码并重新登录', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('两次新密码不一致');
  await page.getByLabel('修改密码的当前密码', { exact: true }).fill('wrong'); await page.getByLabel('确认新密码', { exact: true }).fill(next); await page.getByRole('button', { name: '保存密码并重新登录', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('当前密码不正确');
  await page.getByLabel('修改密码的当前密码', { exact: true }).fill('AccountUi123!'); await page.getByLabel('新密码', { exact: true }).fill(next); await page.getByLabel('确认新密码', { exact: true }).fill(next); await page.getByRole('button', { name: '保存密码并重新登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号登录', exact: true })).toBeVisible(); await expect(page.getByRole('status')).toContainText('请使用新密码重新登录');
  await page.getByLabel('密码', { exact: true }).fill('AccountUi123!'); await submitLogin(page); await expect(page.getByRole('alert')).toContainText('账号或密码错误');
  await page.getByLabel('密码', { exact: true }).fill(next); await submitLogin(page); await expect(page.locator('.profile-username')).toHaveText(account.names[0]!);
});

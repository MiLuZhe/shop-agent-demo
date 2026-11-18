import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import { DEFAULT_SHOP_ID } from '../../packages/contracts/src/common.ts';
import { submitLogin } from './login.ts';

const test = base.extend<{ members: { prefix: string; login: (index: number) => Promise<void> } }>({
  members: async ({ page }, use) => {
    const db = createDatabase(), prefix = `members_ui_${randomUUID().slice(0, 8)}`, users = Array.from({ length: 4 }, () => randomUUID());
    try {
      const password_hash = await hashPassword('MembersUi123!');
      await db.user.createMany({ data: users.map((id, i) => ({ id, username: `${prefix}_${i}`, display_name: `店员管理测试${i}`, password_hash, account_kind: 'work' })) });
      for (const [index, role] of [[0, 'owner'], [1, 'manager'], [2, 'staff']] as const) await db.shopMember.create({ data: { shop_id: DEFAULT_SHOP_ID, user_id: users[index]!, role } });
      await use({ prefix, login: async (index) => {
        await page.goto('/#/login'); await page.getByLabel('账号', { exact: true }).fill(`${prefix}_${index}`); await page.getByLabel('密码', { exact: true }).fill('MembersUi123!'); await submitLogin(page);
        await expect(page.getByRole('heading', { name: '卖家工作台', exact: true })).toBeVisible();
      } });
    } finally {
      const owned = await db.user.findMany({ where: { username: { startsWith: prefix } }, select: { id: true } }); const ownedIds = owned.map((u) => u.id);
      await db.shopMember.deleteMany({ where: { user_id: { in: ownedIds } } }); await db.user.deleteMany({ where: { id: { in: ownedIds } } }); await db.$disconnect();
    }
  },
});
test('owner manages members through the workspace, with protected owners and responsive forms', async ({ page, members }, info) => {
  await members.login(0);
  const modules = page.getByRole('navigation', { name: '管理模块' });
  const productTab = modules.getByRole('button', { name: '商品与规格', exact: true });
  const memberLink = modules.getByRole('link', { name: '店员管理', exact: true });
  const productBox = await productTab.boundingBox(), memberBox = await memberLink.boundingBox();
  expect(productBox && memberBox && Math.abs(productBox.y - memberBox.y)).toBeLessThanOrEqual(2);
  await memberLink.click();
  await expect(page.getByRole('heading', { name: '店员管理', exact: true })).toBeVisible();
  await page.getByLabel('搜索成员', { exact: true }).fill(members.prefix); await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.manage-row')).toHaveCount(3);
  const owner = page.locator('.manage-row').filter({ hasText: `${members.prefix}_0` });
  await expect(owner).toContainText('店长身份受保护'); await expect(owner.getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: '添加成员', exact: true }).click(); await page.getByLabel('成员账号', { exact: true }).fill(`${members.prefix}_3`); await page.getByRole('button', { name: '确认添加', exact: true }).click();
  const target = page.locator('.manage-row').filter({ hasText: `${members.prefix}_3` }); await expect(target).toContainText('店员');
  await target.getByRole('button', { name: `编辑 ${members.prefix}_3`, exact: true }).click(); await page.getByLabel('成员角色', { exact: true }).selectOption('manager');
  await page.getByRole('button', { name: '保存成员', exact: true }).click(); await expect(target).toContainText('经理');
  await target.getByRole('button').click(); await page.getByLabel('成员状态', { exact: true }).selectOption('disabled'); await page.getByRole('button', { name: '保存成员', exact: true }).click(); await expect(target).toContainText('停用');
  await target.getByRole('button').click(); await page.getByLabel('成员状态', { exact: true }).selectOption('active'); await page.getByLabel('成员角色', { exact: true }).selectOption('staff'); await page.getByRole('button', { name: '保存成员', exact: true }).click();
  await expect(target).toContainText('在岗'); await expect(target).toContainText('店员');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath('members.png'), fullPage: true });
});
test('manager and staff cannot see the owner entry or bypass it by typing the page URL', async ({ page, members }) => {
  for (const index of [1, 2]) {
    await members.login(index); await expect(page.getByRole('link', { name: '店员管理', exact: true })).toHaveCount(0);
    await page.goto('/#/seller/members'); await expect(page.getByRole('alert')).toContainText('店内角色无权');
    await expect(page.getByLabel('成员账号', { exact: true })).toHaveCount(0);
    expect((await page.request.get('/api/seller/members')).status()).toBe(403);
    expect((await page.request.post('/api/seller/members', { data: { username: `${members.prefix}_3`, role: 'manager' } })).status()).toBe(403);
  }
});

test('owner creates a dedicated work account from the member dialog', async ({ page, members }) => {
  await members.login(0); await page.goto('/#/seller/members');
  await page.getByRole('button', { name: '添加成员', exact: true }).click();
  await page.getByLabel('添加方式', { exact: true }).selectOption('create');
  const name = `${members.prefix}_new`;
  await page.getByLabel('成员账号', { exact: true }).fill(name);
  await page.getByLabel('成员昵称', { exact: true }).fill('新同事');
  await page.getByLabel('初始密码', { exact: true }).fill(' '.repeat(12));
  await page.getByRole('button', { name: '确认添加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('初始密码不能全部为空白字符');
  await page.getByLabel('初始密码', { exact: true }).fill('NewWorkUser123!');
  await page.getByRole('button', { name: '确认添加', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加成员', exact: true })).toHaveCount(0);
  await page.getByLabel('搜索成员', { exact: true }).fill(name); await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.manage-row').filter({ hasText: name })).toContainText('新同事');
  await page.goto('/#/login'); await page.getByLabel('账号', { exact: true }).fill(name); await page.getByLabel('密码', { exact: true }).fill('NewWorkUser123!'); await submitLogin(page);
  await expect(page.getByRole('heading', { name: '卖家工作台', exact: true })).toBeVisible();
  expect((await page.request.get('/api/cart')).status()).toBe(403);
});

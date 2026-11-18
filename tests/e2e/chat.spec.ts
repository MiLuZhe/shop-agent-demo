import { randomUUID } from 'node:crypto';
import { devices, expect, test as base, type Page, type BrowserContext } from '@playwright/test';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import { submitLogin } from './login.ts';
import { lockDispatch } from '../../apps/shop-api/src/chat/dispatch.ts';
import type {} from '../../apps/shop-api/src/shops/access.ts';
import type { ChatRoundDetailsDto, OrderDetailDto } from '../../packages/contracts/src/index.ts';

type Fixture = {
  db: ReturnType<typeof createDatabase>; users: string[]; names: string[]; members: string[]; productId: string; shopId: string;
  login: (page: Page, index: number) => Promise<void>; openStaff: (index: number) => Promise<Page>;
};
const test = base.extend<{ chat: Fixture }>({
  chat: async ({ page, browser }, use, info) => {
    const db = createDatabase(), prefix = `chat_ui_${randomUUID().slice(0, 8)}`, users = Array.from({ length: 5 }, () => randomUUID()), names = users.map((_, i) => `${prefix}_${i}`), members: string[] = [], contexts: BrowserContext[] = [], productId = randomUUID(), shopId = randomUUID();
    const routeShop = (target: Page) => target.route('**/api/seller/**', (route) => route.continue({ headers: { ...route.request().headers(), 'x-shop-id': shopId } }));
    await routeShop(page);
    async function login(target: Page, index: number) {
      await target.goto('/#/login'); await target.getByLabel('账号', { exact: true }).fill(names[index]!); await target.getByLabel('密码', { exact: true }).fill('ChatUiTest123!'); await submitLogin(target);
      await expect(target.getByRole('heading', { name: index > 0 && index < 4 ? '卖家工作台' : '我的账号', exact: true })).toBeVisible();
    }
    try {
      await db.shop.create({ data: { id: shopId, slug: prefix, name: '咨询测试店铺', chat_capacity: 1 } });
      const password_hash = await hashPassword('ChatUiTest123!');
      await db.user.createMany({ data: users.map((id, i) => ({ id, username: names[i]!, display_name: i ? `接待同事${i}` : '聊天测试买家', password_hash })) });
      for (let i = 1; i < 4; i++) {
        const row = await db.shopMember.create({ data: { user_id: users[i]!, shop_id: shopId, role: i === 3 ? 'manager' : 'staff' } }); members[i] = row.id;
      }
      await db.product.create({ data: { id: productId, shop_id: shopId, name: `${prefix}商品`, status: 'active', skus: { create: { sku_code: `${prefix}_sku`, name: '测试规格', price: '1.00', stock_quantity: 2 } } } });
      await use({ db, users, names, members, productId, shopId, login, openStaff: async (index) => {
        const context = await browser.newContext({ ...devices[info.project.name === 'mobile' ? 'iPhone 13' : 'Desktop Chrome'], baseURL: info.project.use.baseURL }); contexts.push(context); const target = await context.newPage(); await routeShop(target); await login(target, index); return target;
      } });
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      // A stopped dev server/browser must not prevent the database cleanup.
      if (!page.isClosed()) await page.goto('/#catalog').catch(() => {});
      try {
        await db.$transaction(async tx => {
          // Agent writes take a shared shop lock before checking the round. Hold
          // the exclusive lock through cleanup so a late reply cannot race FK deletion.
          await tx.$queryRaw`SELECT id FROM shops WHERE id=${shopId}::uuid FOR UPDATE`;
          await lockDispatch(tx, shopId);
          const rounds = await tx.conversation.findMany({ where: { buyer_id: { in: users } }, select: { id: true } }); const ids = rounds.map((r) => r.id);
          await tx.inquiry.deleteMany({ where: { conversation_id: { in: ids } } }); await tx.message.deleteMany({ where: { conversation_id: { in: ids } } }); await tx.conversation.deleteMany({ where: { id: { in: ids } } });
          await tx.chatChannel.deleteMany({ where: { buyer_id: { in: users } } });
          const orders = await tx.order.findMany({ where: { buyer_id: { in: users } }, select: { id: true } });
          await tx.orderItem.deleteMany({ where: { order_id: { in: orders.map((order) => order.id) } } });
          await tx.order.deleteMany({ where: { buyer_id: { in: users } } });
          await tx.cartItem.deleteMany({ where: { user_id: { in: users } } });
          await tx.sku.deleteMany({ where: { product_id: productId } }); await tx.product.deleteMany({ where: { id: productId } });
          await tx.shopMember.deleteMany({ where: { user_id: { in: users } } }); await tx.user.deleteMany({ where: { id: { in: users } } }); await tx.shop.delete({ where: { id: shopId } });
        }, { timeout: 10000, maxWait: 10000 });
      } finally { await db.$disconnect(); }
    }
  },
});
const messages = (page: Page) => page.getByRole('region', { name: '聊天记录', exact: true });
async function send(page: Page, content: string) { await page.getByLabel('消息内容', { exact: true }).fill(content); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(messages(page).getByText(content, { exact: true })).toBeVisible(); await expect(page.getByLabel('消息内容', { exact: true })).toHaveValue(''); }
async function requestHuman(page: Page, shopId: string) {
  const current = await page.request.get(`/api/chat/shops/${shopId}`);
  if (current.ok() && (await current.json()).channel?.activeRound?.status === 'agent') {
    const completed = page.waitForResponse((response) => response.url().includes('/api/chat/rounds/') && response.url().endsWith('/handoff') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '转人工', exact: true }).click();
    expect((await completed).status()).toBe(200);
  }
}

test('mock guide shows verified cards, survives staff availability and hands off from buyer UI', async ({ page, chat }, info) => {
  test.skip(process.env.AGENT_MODE !== 'mock', 'Requires the explicit mock preview mode');
  await chat.login(page, 0); await page.goto(`/#/messages/${chat.shopId}`);
  await send(page, '看看本店商品');
  const recommendation = messages(page).getByRole('link', { name: `查看推荐商品：${(await chat.db.product.findUniqueOrThrow({ where: { id: chat.productId } })).name}`, exact: true });
  await expect(recommendation).toBeVisible({ timeout: 10000 }); await expect(recommendation).toContainText('¥1.00');
  expect(await chat.db.inquiry.count({ where: { conversation: { shop_id: chat.shopId } } })).toBe(0);
  const staff = await chat.openStaff(1); await staff.goto('/#/seller/messages'); await staff.getByRole('button', { name: '上线接待', exact: true }).click();
  await expect(staff.getByText('在线 · 等待分配', { exact: true })).toBeVisible();
  expect((await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId } })).status).toBe('agent');
  await expect(page.getByRole('button', { name: '转人工', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('agent-guide.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '转人工', exact: true }).click();
  await expect(page.getByRole('region', { name: '店铺聊天', exact: true }).getByText('人工接待中', { exact: true })).toBeVisible({ timeout: 10000 });
  await staff.locator('.reception-row').filter({ hasText: chat.names[0]! }).click(); await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await send(staff, '人工继续为你解答'); await expect(messages(page).getByText('人工继续为你解答', { exact: true })).toBeVisible({ timeout: 10000 });
});

test('recommendation cards open their SKU from full-page and floating conversations without covering the product', async ({ page, chat }, info) => {
  test.skip(process.env.AGENT_MODE !== 'mock', 'Requires the explicit mock preview mode');
  await chat.login(page, 0); await page.goto(`/#/messages/${chat.shopId}`);
  await send(page, '看看本店商品');
  const product = await chat.db.product.findUniqueOrThrow({ where: { id: chat.productId }, include: { skus: true } });
  const name = `查看推荐商品：${product.name}`;
  const recommendation = messages(page).getByRole('link', { name, exact: true });
  await expect(recommendation).toBeVisible({ timeout: 10000 });
  await expect(recommendation).toHaveAttribute('href', `#/products/${product.id}?sku=${product.skus[0]!.id}`);
  expect(await recommendation.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
  await recommendation.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: '商品详情', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: '测试规格 ¥1.00', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: '咨询这件商品 ↗', exact: true }).click();
  const widget = page.getByRole('dialog', { name: '客服咨询', exact: true });
  await expect(widget).toBeVisible();
  const floatingCard = widget.getByRole('link', { name, exact: true });
  await expect(floatingCard).toBeVisible();
  if (info.project.name === 'mobile') expect(await widget.locator('.chat-messages').evaluate(element => element.clientHeight)).toBeGreaterThan(130);
  await page.screenshot({ path: info.outputPath('recommendation-card.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await floatingCard.click();
  await expect(widget).toBeHidden();
  await expect(page.getByRole('region', { name: '商品详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '联系客服', exact: true }).click();
  await expect(widget.getByRole('link', { name, exact: true })).toBeVisible();
  await widget.getByRole('link', { name: '完整对话 ↗', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/messages/${chat.shopId}$`));
  await expect(page.getByRole('dialog', { name: '客服咨询', exact: true })).toHaveCount(0);
  await expect(messages(page).getByRole('link', { name, exact: true })).toBeVisible();
});

test('mock memory keeps the search after a budget change and restores it after refresh', async ({ page, chat }) => {
  test.skip(process.env.AGENT_MODE !== 'mock', 'Requires explicit mock mode');
  await chat.login(page, 0); await page.goto(`/#/messages/${chat.shopId}`);
  const product = await chat.db.product.findUniqueOrThrow({ where: { id: chat.productId } });
  const latest = () => messages(page).getByRole('article', { name: '导购助手消息', exact: true }).last();
  await send(page, `搜索 ${product.name}，预算最多0`);
  await expect(latest()).toContainText('没有找到可售规格', { timeout: 10000 });
  await expect(latest().getByRole('link')).toHaveCount(0);
  await send(page, '预算改成2');
  await expect(latest().getByRole('link', { name: `查看推荐商品：${product.name}`, exact: true })).toBeVisible({ timeout: 10000 });
  await page.reload(); await expect(page.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await send(page, '颜色蓝色');
  await expect(latest()).toContainText('尚未核实', { timeout: 10000 });
  await expect(latest().getByRole('link')).toHaveCount(0);
  await send(page, '不限颜色');
  await expect(latest().getByRole('link', { name: `查看推荐商品：${product.name}`, exact: true })).toBeVisible({ timeout: 10000 });
  const state = (await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId } })).requirement_state as { schemaVersion: number; constraints: { key: string }[] };
  expect(state.schemaVersion).toBe(2);
  expect(state.constraints.map(c => c.key).sort()).toEqual(['budget', 'keyword']);
});


test('reception list and conversation are separate pages; busy staff do not receive a second buyer', async ({ page, chat }, info) => {
  await chat.login(page, 0); await page.goto(`/#/messages/${chat.shopId}`);
  const staff = await chat.openStaff(1); await staff.goto('/#/seller/messages');
  await expect(staff.getByRole('heading', { name: '咨询接待', exact: true })).toBeVisible();
  await expect(staff.getByLabel('消息内容', { exact: true })).toHaveCount(0);
  await staff.getByRole('button', { name: '上线接待', exact: true }).click();
  await expect(staff.getByText('在线 · 等待分配', { exact: true })).toBeVisible();
  await send(page, '第一位买家等待接待');
  await staff.locator('.reception-row').filter({ hasText: chat.names[0]! }).click();
  await expect(staff.getByRole('heading', { name: '接待会话', exact: true })).toBeVisible();
  await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await expect(staff.locator('.chat-sidebar')).toHaveCount(0);
  await expect(staff.getByRole('button', { name: '接手咨询', exact: true })).toHaveCount(0);
  if (info.project.name === 'desktop') {
    const thread = await staff.locator('.chat-thread').boundingBox(), workspace = await staff.locator('.chat-page').boundingBox();
    expect(thread!.width).toBeGreaterThan(workspace!.width * .9);
  }
  const secondBuyer = await chat.openStaff(4); await secondBuyer.goto(`/#/messages/${chat.shopId}`); await send(secondBuyer, '第二位买家等待分配'); await requestHuman(secondBuyer, chat.shopId);
  const queued = await chat.db.conversation.findFirstOrThrow({ where: { buyer_id: chat.users[4] } }); expect(queued.status).toBe('waiting_seller'); expect(queued.assigned_seller_id).toBeNull();
  await staff.getByRole('button', { name: '结束接待', exact: true }).click();
  const dialog = staff.getByRole('dialog', { name: '结束接待', exact: true }); await dialog.getByLabel('处理摘要', { exact: true }).fill('完成第一位买家的咨询'); await dialog.getByRole('button', { name: '确认结束', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await staff.getByRole('link', { name: '返回接待列表', exact: false }).click();
  await staff.locator('.reception-row').filter({ hasText: chat.names[4]! }).click(); await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await expect(messages(staff).getByText('第二位买家等待分配', { exact: true })).toBeVisible();
  await staff.getByRole('button', { name: '暂停接待', exact: true }).click(); await expect(staff.getByRole('button', { name: '上线接待', exact: true })).toBeVisible();
  await send(staff, '暂停新咨询后继续处理已有接待'); await expect(messages(secondBuyer).getByText('暂停新咨询后继续处理已有接待', { exact: true })).toBeVisible({ timeout: 10000 });
  await send(page, '第一位买家重新咨询'); await requestHuman(page, chat.shopId);
  const waiting = await chat.db.conversation.findFirstOrThrow({ where: { buyer_id: chat.users[0], status: { not: 'closed' } } }); expect(waiting.status).toBe('waiting_seller');
  const colleague = await chat.openStaff(2); await colleague.goto('/#/seller/messages'); await colleague.getByRole('button', { name: '上线接待', exact: true }).click();
  await colleague.locator('.reception-row').filter({ hasText: chat.names[0]! }).click(); await expect(colleague.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await staff.evaluate(() => window.scrollTo(0, 0)); await staff.screenshot({ path: info.outputPath('reception-conversation.png'), fullPage: true });
  await staff.getByRole('link', { name: '返回接待列表', exact: false }).click(); await staff.screenshot({ path: info.outputPath('reception-list.png'), fullPage: true });
  expect(await staff.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('buyer and staff chat, transfer without losing history, close and continue in a new round', async ({ page, chat }, info) => {
  await chat.login(page, 0); await page.goto(`/#/products/${chat.productId}`); await page.getByRole('button', { name: '咨询这件商品', exact: false }).click();
  await expect(page.getByRole('dialog', { name: '客服咨询', exact: true })).toBeVisible(); await expect(page.getByText('发送第一条消息，开始咨询', { exact: true })).toBeVisible();
  expect(await chat.db.chatChannel.count({ where: { buyer_id: chat.users[0] } })).toBe(0);
  await send(page, '请帮我介绍一下这个商品'); await requestHuman(page, chat.shopId);
  const productMessage = await chat.db.message.findFirstOrThrow({ where: { sender_user_id: chat.users[0], sender_type: 'buyer' } });
  expect((productMessage.product_context as { id: string }).id).toBe(chat.productId);
  const first = await chat.db.conversation.findFirstOrThrow({ where: { buyer_id: chat.users[0] } });
  const staff = await chat.openStaff(1); await staff.locator('.store-nav').getByRole('link', { name: '咨询接待', exact: true }).click();
  await expect(messages(staff)).toHaveCount(0);
  await staff.getByRole('button', { name: '上线接待', exact: true }).click();
  await staff.locator('.chat-conversation-item').filter({ hasText: chat.names[0]! }).click();
  await expect(staff.getByRole('heading', { name: '接待会话', exact: true })).toBeVisible();
  await expect(staff.getByRole('region', { name: '接待列表', exact: true })).toHaveCount(0); await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await expect(messages(staff).getByRole('link', { name: '查看咨询商品：', exact: false })).toHaveCount(1);
  await send(staff, '你好，这款商品有货，可以介绍规格。'); await expect(messages(page).getByText('你好，这款商品有货，可以介绍规格。', { exact: true })).toBeVisible({ timeout: 10000 });
  const second = await chat.openStaff(2); await second.goto('/#/seller/messages'); await second.getByRole('button', { name: '上线接待', exact: true }).click();
  await staff.getByRole('button', { name: '转接咨询', exact: true }).click(); const transfer = staff.getByRole('dialog', { name: '转接咨询', exact: true });
  await transfer.getByLabel('接待人员', { exact: true }).selectOption(chat.members[2]!); await transfer.getByRole('button', { name: '确认转接', exact: true }).click(); await expect(transfer).toHaveCount(0);
  await expect(staff.getByText('暂时无法访问此咨询，请重新加载。', { exact: true })).toBeVisible();
  // Keep the next-round assignee deterministic instead of assuming the
  // random tie-breaker will choose the previous assignee again.
  await staff.goto('/#/seller/messages'); await staff.getByRole('button', { name: '暂停接待', exact: true }).click();
  await second.goto(`/#/seller/messages/${first.id}`); await expect(second.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await expect(messages(second).getByText('请帮我介绍一下这个商品', { exact: true })).toBeVisible(); await send(second, '我来继续为你解答。');
  await second.getByRole('button', { name: '结束接待', exact: true }).click(); const close = second.getByRole('dialog', { name: '结束接待', exact: true });
  await close.getByLabel('处理摘要', { exact: true }).fill('已说明商品规格和库存'); await close.getByRole('button', { name: '确认结束', exact: true }).click(); await expect(close).toHaveCount(0);
  await expect(second.getByText('本轮接待已结束，记录仅供查看。', { exact: true })).toBeVisible();
  await expect(page.getByText('上次咨询已结束，可继续发送新问题', { exact: true })).toBeVisible({ timeout: 10000 });
  await send(page, '我想再问一下适用场景'); expect(await chat.db.chatChannel.count({ where: { buyer_id: chat.users[0] } })).toBe(1);
  const rounds = await chat.db.conversation.findMany({ where: { buyer_id: chat.users[0] } }); expect(rounds).toHaveLength(2);
  const latest = rounds.find((r) => r.status !== 'closed')!; expect(latest.id).not.toBe(first.id);
  await second.getByRole('link', { name: '进入当前接待', exact: false }).click();
  await expect(messages(second).getByText('我想再问一下适用场景', { exact: true })).toBeVisible(); await expect(messages(second).getByText('请帮我介绍一下这个商品', { exact: true })).toHaveCount(0);
  await second.getByRole('button', { name: '全部历史', exact: true }).click(); await expect(messages(second).getByText('请帮我介绍一下这个商品', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const target of [page, second]) {
    const fits = await target.locator('.chat-thread').evaluate((thread) => { const button = thread.querySelector('.chat-composer-footer button'); return !button || button.getBoundingClientRect().bottom <= thread.getBoundingClientRect().bottom; }); expect(fits).toBe(true);
    await target.evaluate(() => window.scrollTo(0, 0));
  }
  await page.screenshot({ path: info.outputPath('buyer-chat.png'), fullPage: true }); await second.screenshot({ path: info.outputPath('seller-chat.png'), fullPage: true });
});

test('message retry after a lost response reuses the key, history pages preserve records and revoked staff lose access', async ({ page, chat }) => {
  await chat.login(page, 0); await page.goto(`/#/messages/${chat.shopId}`);
  let dropped = false;
  await page.route(`**/api/chat/shops/${chat.shopId}/messages`, async (route) => {
    if (!dropped) { dropped = true; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByLabel('消息内容', { exact: true }).fill('断线时只发送一次'); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(page.getByRole('button', { name: '重试发送', exact: true })).toBeVisible();
  await expect(page.getByLabel('消息内容', { exact: true })).toHaveValue('断线时只发送一次'); await page.getByRole('button', { name: '重试发送', exact: true }).click();
  await expect(page.getByLabel('消息内容', { exact: true })).toHaveValue('');
  await requestHuman(page, chat.shopId);
  const channel = await chat.db.chatChannel.findFirstOrThrow({ where: { buyer_id: chat.users[0] } });
  expect(await chat.db.message.count({ where: { channel_id: channel.id, content: '断线时只发送一次' } })).toBe(1);
  for (let i = 1; i <= 53; i++) expect((await page.request.post(`/api/chat/shops/${chat.shopId}/messages`, { data: { content: `历史测试消息 ${i}`, clientMessageId: randomUUID() } })).status()).toBe(201);
  await page.reload(); await expect(messages(page).getByText('历史测试消息 53', { exact: true })).toBeVisible(); await expect(messages(page).getByText('断线时只发送一次', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click(); await expect(messages(page).getByText('断线时只发送一次', { exact: true })).toBeVisible();
  await messages(page).evaluate((node) => { node.scrollTop = 30; });
  const readingPosition = await messages(page).evaluate((node) => node.scrollTop);
  expect((await page.request.post(`/api/chat/shops/${chat.shopId}/messages`, { data: { content: '阅读历史时到达的新消息', clientMessageId: randomUUID() } })).status()).toBe(201);
  await expect(messages(page).getByText('阅读历史时到达的新消息', { exact: true })).toBeAttached({ timeout: 10000 });
  expect(Math.abs(await messages(page).evaluate((node) => node.scrollTop) - readingPosition)).toBeLessThan(2);
  const staff = await chat.openStaff(1); const round = await chat.db.conversation.findFirstOrThrow({ where: { channel_id: channel.id } }); await staff.goto(`/#/seller/messages/${round.id}`);
  await staff.getByRole('button', { name: '上线接待', exact: true }).click(); await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await chat.db.shopMember.update({ where: { id: chat.members[1] }, data: { status: 'disabled' } });
  await expect(staff.getByRole('region', { name: '客服聊天', exact: true }).getByText('暂时无法访问此咨询，请重新加载。', { exact: true })).toBeVisible();
  await expect(staff.getByLabel('消息内容', { exact: true })).toHaveCount(0); await expect(messages(staff)).toHaveCount(0);
  const manager = await chat.openStaff(3); await manager.goto(`/#/seller/messages/${round.id}`); await manager.getByRole('button', { name: '转接咨询', exact: true }).click();
  const dialog = manager.getByRole('dialog', { name: '转接咨询', exact: true }); await dialog.getByLabel('接待人员', { exact: true }).selectOption(chat.members[3]!); await dialog.getByLabel('确认指派给离线人员，等待其处理').check(); await dialog.getByRole('button', { name: '确认转接', exact: true }).click();
  await expect(manager.getByLabel('消息内容', { exact: true })).toBeEnabled();
});

test('chat guards guests and non-staff; text stays literal and blank messages cannot send', async ({ page, chat }) => {
  await page.goto(`/#/messages/${chat.shopId}`); await expect(page.getByRole('heading', { name: '请先登录', exact: true })).toBeVisible();
  await chat.login(page, 0); await page.goto('/#/seller/messages'); await expect(page.getByRole('heading', { name: '此功能需要店铺授权', exact: true })).toBeVisible();
  await page.goto(`/#/messages/${chat.shopId}`); const input = page.getByLabel('消息内容', { exact: true }); await expect(input).toBeEnabled(); await input.fill('   '); await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await send(page, '<img src=x onerror=alert(1)>\n第二行文字'); await expect(messages(page).locator('img')).toHaveCount(0); await expect(input).toHaveAttribute('maxlength', '4000');
  await page.goto(`/#/messages/${randomUUID()}`); await expect(page.getByText('暂时无法访问此咨询，请重新加载。', { exact: true })).toBeVisible(); await expect(input).toHaveCount(0);
});


test('floating launcher preserves a draft when minimized, pauses polling and reuses the fixed message channel', async ({ page, chat }, info) => {
  await chat.login(page, 0);
  await page.goto(`/#/products/${chat.productId}`); await page.getByRole('button', { name: '咨询这件商品', exact: false }).click();
  await page.getByRole('button', { name: '收起客服窗口', exact: true }).click(); await page.evaluate(() => { location.hash = '/account'; });
  const launcher = page.getByRole('button', { name: '联系客服', exact: true }); await expect(launcher).toBeVisible();
  await launcher.click(); const panel = page.getByRole('dialog', { name: '客服咨询', exact: true }); await expect(panel).toBeVisible();
  const input = panel.getByLabel('消息内容', { exact: true }); await expect(input).toBeEnabled(); await input.fill('先保留这个草稿');
  expect(await chat.db.chatChannel.count({ where: { buyer_id: chat.users[0] } })).toBe(0);
  const toolbar = await panel.locator('.chat-widget-toolbar').boundingBox(), header = await page.locator('.store-header').boundingBox();
  expect(toolbar!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  const button = await panel.getByRole('button', { name: '发送消息', exact: true }).boundingBox(), bounds = await panel.boundingBox();
  expect(button!.y + button!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  await panel.getByRole('button', { name: '收起客服窗口', exact: true }).click(); await expect(panel).toBeHidden();
  let polling = 0; const observe = (request: import('@playwright/test').Request) => { if (request.url().includes('/api/chat/')) polling++; }; page.on('request', observe);
  await page.waitForTimeout(3300); expect(polling).toBe(0); page.off('request', observe);
  await page.getByRole('button', { name: '联系客服', exact: true }).click(); await expect(input).toHaveValue('先保留这个草稿');
  await panel.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(messages(page).getByText('先保留这个草稿', { exact: true })).toBeVisible();
  expect(await chat.db.chatChannel.count({ where: { buyer_id: chat.users[0] } })).toBe(1);
  await page.keyboard.press('Escape'); await expect(panel).toBeHidden();
  await page.getByRole('button', { name: '联系客服', exact: true }).click(); await expect(messages(page).getByText('先保留这个草稿', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('floating-chat.png'), fullPage: true });
  await page.locator('.store-nav').getByRole('link', { name: '消息', exact: true }).click();
  await page.locator('.chat-conversation-item').filter({ hasText: '咨询测试店铺' }).click(); await expect(messages(page).getByText('先保留这个草稿', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '联系客服', exact: true })).toHaveCount(0);
});

test('product shortcut carries the selected SKU and an uncertain send cannot be changed or duplicated', async ({ page, chat }, info) => {
  const extra = await chat.db.sku.create({ data: { product_id: chat.productId, sku_code: `widget_${randomUUID()}`, name: '另一种规格', price: '2.00', stock_quantity: 3 } });
  await chat.login(page, 0); await page.goto(`/#/products/${chat.productId}`);
  await page.getByRole('radio', { name: /另一种规格/ }).click();
  await page.getByRole('button', { name: '咨询这件商品', exact: false }).click();
  const panel = page.getByRole('dialog', { name: '客服咨询', exact: true }); await expect(panel.locator('.chat-product-draft')).toContainText('另一种规格');
  let dropped = false;
  await page.route(`**/api/chat/shops/${chat.shopId}/messages`, async (route) => {
    if (!dropped) { dropped = true; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed'); }
    else await route.continue();
  });
  await panel.getByLabel('消息内容', { exact: true }).fill('这个规格适合我吗'); await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(panel.getByRole('button', { name: '重试发送', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '收起客服窗口', exact: true }).click();
  await page.getByRole('radio', { name: /测试规格/ }).click(); await page.getByRole('button', { name: '咨询这件商品', exact: false }).click();
  await expect(panel.getByRole('alert').filter({ hasText: '请先完成当前消息' })).toBeVisible(); await expect(panel.locator('.chat-product-draft')).toContainText('另一种规格');
  await panel.getByRole('button', { name: '重试发送', exact: true }).click(); await expect(panel.getByLabel('消息内容', { exact: true })).toHaveValue('');
  const stored = await chat.db.message.findMany({ where: { sender_user_id: chat.users[0], sender_type: 'buyer' } }); expect(stored).toHaveLength(1);
  expect((stored[0]!.product_context as { skuId: string }).skuId).toBe(extra.id);
  await expect(panel.locator('.chat-product-draft')).toHaveCount(0); await expect(messages(page).getByRole('link', { name: '查看咨询商品：', exact: false })).toHaveCount(1);
  const button = await panel.getByRole('button', { name: '发送消息', exact: true }).boundingBox(), bounds = await panel.boundingBox(); expect(button!.y + button!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  await page.screenshot({ path: info.outputPath('product-consultation.png'), fullPage: true });
});

test('guest shortcut requires login, customer accounts are isolated and work accounts have no launchers', async ({ page, chat }) => {
  await page.goto(`/#/products/${chat.productId}`); await page.getByRole('button', { name: '咨询这件商品', exact: false }).click();
  const panel = page.getByRole('dialog', { name: '客服咨询', exact: true }); await expect(panel.getByRole('link', { name: '前往登录', exact: true })).toBeVisible();
  expect(await chat.db.chatChannel.count({ where: { buyer_id: { in: chat.users } } })).toBe(0);
  await panel.getByRole('link', { name: '前往登录', exact: true }).click();
  await page.getByLabel('账号', { exact: true }).fill(chat.names[0]!); await page.getByLabel('密码', { exact: true }).fill('ChatUiTest123!'); await submitLogin(page);
  await expect(panel).toBeVisible(); await expect(panel.locator('.chat-product-draft')).toBeVisible(); await send(page, '这是第一个买家的咨询');
  const channel = await chat.db.chatChannel.findFirstOrThrow({ where: { buyer_id: chat.users[0] } });
  await chat.login(page, 4); await expect(page.getByRole('dialog', { name: '客服咨询', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '联系客服', exact: true }).click(); await expect(page.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await expect(messages(page).getByText('这是第一个买家的咨询', { exact: true })).toHaveCount(0); expect((await page.request.get(`/api/chat/channels/${channel.id}/messages`)).status()).toBe(404);
  await chat.login(page, 1); await page.goto(`/#/products/${chat.productId}`);
  await expect(page.getByRole('button', { name: '联系客服', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '咨询这件商品', exact: false })).toHaveCount(0);
  expect((await page.request.post(`/api/chat/shops/${chat.shopId}/messages`, { data: { productId: chat.productId, content: '绕过入口', clientMessageId: randomUUID() } })).status()).toBe(403);
});

test('DeepSeek guide returns a verified product card in the browser, persists after refresh and hands off', async ({ page, chat }, info) => {
  test.skip(process.env.AGENT_MODE !== 'deepseek', 'Requires explicit live DeepSeek mode and consumes model tokens');
  await chat.login(page, 0); await page.goto(`/#/products/${chat.productId}`);
  await page.getByRole('button', { name: '咨询这件商品', exact: false }).click();
  await send(page, '请查询这件商品现在可买的规格，并给我商品卡片。');
  const product = await chat.db.product.findUniqueOrThrow({ where: { id: chat.productId } });
  const recommendation = messages(page).getByRole('link', { name: `查看推荐商品：${product.name}`, exact: true });
  await expect(recommendation).toBeVisible({ timeout: 60000 }); await expect(recommendation).toContainText('¥1.00');
  await page.reload(); await page.goto(`/#/messages/${chat.shopId}`);
  await expect(recommendation).toBeVisible({ timeout: 10000 });
  const current = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId, buyer_id: chat.users[0] } });
  const actualMode = await page.request.get(`/api/chat/shops/${chat.shopId}`); expect((await actualMode.json()).channel.activeRound.agentRun.mode).toBe('deepseek');
  expect(current.agent_run_status).toBe('completed'); expect((current.requirement_state as { productScope: { productId: string } }).productScope.productId).toBe(chat.productId);
  await page.screenshot({ path: info.outputPath('deepseek-guide.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '转人工', exact: true }).click();
  await expect(page.getByRole('region', { name: '店铺聊天', exact: true }).getByText('等待客服接待', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(await chat.db.inquiry.count({ where: { conversation_id: current.id } })).toBe(1);
});

test('complete live shopping journey keeps orders private and chat ownership valid across handoff, transfer and reopening', async ({ page, chat }, info) => {
  test.skip(process.env.AGENT_MODE !== 'deepseek', 'Requires explicit live DeepSeek mode and consumes model tokens');
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const product = await chat.db.product.findUniqueOrThrow({ where: { id: chat.productId }, include: { skus: true } });
  const sku = product.skus[0]!;
  const sellerHeaders = { 'x-shop-id': chat.shopId };
  const roundView = async (target: Page, id: string) => {
    const response = await target.request.get(`/api/seller/chat/rounds/${id}`, { headers: sellerHeaders });
    expect(response.status()).toBe(200);
    return (await response.json() as ChatRoundDetailsDto).round;
  };

  await test.step('browse, consult the selected product and open the verified recommendation', async () => {
    await page.goto(`/#/products/${chat.productId}`);
    await expect(page.getByRole('link', { name: '登录后加入购物车', exact: true })).toBeVisible();
    await chat.login(page, 0);
    await page.goto(`/#/products/${chat.productId}`);
    await page.getByRole('button', { name: '咨询这件商品', exact: false }).click();
    await send(page, '请查询这件商品现在可买的规格，并给我商品卡片。');
    const recommendation = messages(page).getByRole('link', { name: `查看推荐商品：${product.name}`, exact: true });
    await expect(recommendation).toContainText('¥1.00', { timeout: 60000 });
    expect(await chat.db.order.count({ where: { buyer_id: chat.users[0] } })).toBe(0);
    await page.getByRole('button', { name: '收起客服窗口', exact: true }).click();
    await page.goto(`/#/messages/${chat.shopId}`);
    await recommendation.click();
    await expect(page.getByRole('region', { name: '商品详情', exact: true })).toBeVisible();
  });

  let orderId = '';
  await test.step('buy through the cart and confirm price, quantity and recipient snapshots', async () => {
    await page.getByRole('button', { name: '加入购物车', exact: true }).click();
    await expect(page.getByText('已加入购物车', { exact: false })).toBeVisible();
    await page.goto('/#/cart');
    await page.getByLabel('勾选测试规格', { exact: true }).check();
    await page.getByRole('button', { name: '查看结算清单', exact: true }).click();
    await page.getByRole('button', { name: '填写收货信息并提交订单', exact: true }).click();
    const form = page.getByRole('form', { name: '提交订单', exact: true });
    await form.getByLabel('收货人', { exact: true }).fill('全流程测试收件人');
    await form.getByLabel('联系电话', { exact: true }).fill('13800000000');
    await form.getByLabel('完整收货地址', { exact: true }).fill('测试省测试市边界测试路 1 号');
    await form.getByRole('button', { name: '确认并提交订单', exact: true }).click();
    await expect(page.getByRole('heading', { name: '待支付', exact: true })).toBeVisible();
    orderId = page.url().split('/').at(-1)!;
    const detail = await (await page.request.get(`/api/orders/${orderId}`)).json() as OrderDetailDto;
    expect(detail.shopId).toBe(chat.shopId); expect(detail.totalAmount).toBe('1.00');
    expect(detail.items).toHaveLength(1); expect(detail.items[0]!.skuId).toBe(sku.id);
    expect(detail.recipientName).toBe('全流程测试收件人');
    expect((await chat.db.sku.findUniqueOrThrow({ where: { id: sku.id } })).stock_quantity).toBe(1);
    expect((await (await page.request.get('/api/cart')).json()).items).toHaveLength(0);
  });

  const otherBuyer = await chat.openStaff(4);
  const firstStaff = await chat.openStaff(1);
  const secondStaff = await chat.openStaff(2);
  const manager = await chat.openStaff(3);
  const firstRound = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId, buyer_id: chat.users[0] } });

  await test.step('another buyer and an unrelated shop cannot read or mutate this order or conversation', async () => {
    for (const suffix of ['', '/mock-pay', '/cancel']) {
      const response = suffix ? await otherBuyer.request.post(`/api/orders/${orderId}${suffix}`) : await otherBuyer.request.get(`/api/orders/${orderId}`);
      expect(response.status()).toBe(404);
    }
    expect((await otherBuyer.request.get(`/api/chat/channels/${firstRound.channel_id}/messages`)).status()).toBe(404);
    expect((await otherBuyer.request.post(`/api/chat/rounds/${firstRound.id}/handoff`, { data: {} })).status()).toBe(404);
    for (const path of ['/api/cart', '/api/orders', '/api/account/addresses', `/api/chat/shops/${chat.shopId}`]) {
      expect((await firstStaff.request.get(path)).status(), path).toBe(403);
    }
    const unrelatedShopId = randomUUID(), unrelatedMemberId = randomUUID();
    try {
      await chat.db.shop.create({ data: { id: unrelatedShopId, slug: `journey_${randomUUID().slice(0, 8)}`, name: '全流程隔离店铺' } });
      await chat.db.shopMember.create({ data: { id: unrelatedMemberId, shop_id: unrelatedShopId, user_id: chat.users[3]!, role: 'manager' } });
      const headers = { 'x-shop-id': unrelatedShopId };
      expect((await manager.request.get(`/api/seller/orders/${orderId}`, { headers })).status()).toBe(404);
      expect((await manager.request.post(`/api/seller/orders/${orderId}/ship`, { headers })).status()).toBe(404);
      expect((await manager.request.get(`/api/seller/chat/rounds/${firstRound.id}`, { headers })).status()).toBe(404);
      const round = await roundView(manager, firstRound.id);
      expect((await manager.request.post(`/api/seller/chat/rounds/${firstRound.id}/transfer`, { headers: sellerHeaders, data: { version: round.version, memberId: unrelatedMemberId } })).status()).toBe(404);
    } finally {
      await chat.db.shopMember.deleteMany({ where: { id: unrelatedMemberId } });
      await chat.db.shop.deleteMany({ where: { id: unrelatedShopId } });
    }
  });

  await test.step('pay once, reject shipping before payment and preserve a single stock deduction', async () => {
    expect((await firstStaff.request.post(`/api/seller/orders/${orderId}/ship`, { headers: sellerHeaders })).status()).toBe(409);
    await page.getByRole('button', { name: '模拟支付', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(page.getByRole('heading', { name: '待发货', exact: true })).toBeVisible();
    expect((await page.request.post(`/api/orders/${orderId}/mock-pay`)).status()).toBe(200);
    expect((await page.request.post(`/api/orders/${orderId}/cancel`)).status()).toBe(409);
  });

  await test.step('duplicate human requests create one inquiry and an idle worker does not seize Agent work', async () => {
    await firstStaff.goto('/#/seller/messages');
    await firstStaff.getByRole('button', { name: '上线接待', exact: true }).click();
    expect((await chat.db.conversation.findUniqueOrThrow({ where: { id: firstRound.id } })).status).toBe('agent');
    await page.goto(`/#/messages/${chat.shopId}`);
    const handoffs = await Promise.all([0, 1].map(() => page.request.post(`/api/chat/rounds/${firstRound.id}/handoff`, { data: {} })));
    expect(handoffs.map((response) => response.status())).toEqual([200, 200]);
    await expect.poll(async () => (await chat.db.conversation.findUniqueOrThrow({ where: { id: firstRound.id } })).assigned_seller_id).toBe(chat.users[1]);
    expect(await chat.db.inquiry.count({ where: { conversation_id: firstRound.id } })).toBe(1);
    await firstStaff.goto(`/#/seller/messages/${firstRound.id}`);
    await expect(firstStaff.getByLabel('消息内容', { exact: true })).toBeEnabled();
    await send(firstStaff, '已核对商品，可以继续处理您的订单问题。');
    await expect(messages(page).getByText('已核对商品，可以继续处理您的订单问题。', { exact: true })).toBeVisible({ timeout: 10000 });
  });

  await test.step('transfer preserves history and rejects stale and unassigned staff writes', async () => {
    const previous = await roundView(firstStaff, firstRound.id);
    await secondStaff.goto('/#/seller/messages'); await secondStaff.getByRole('button', { name: '上线接待', exact: true }).click();
    await firstStaff.getByRole('button', { name: '转接咨询', exact: true }).click();
    const dialog = firstStaff.getByRole('dialog', { name: '转接咨询', exact: true });
    await dialog.getByLabel('接待人员', { exact: true }).selectOption(chat.members[2]!);
    await dialog.getByRole('button', { name: '确认转接', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const current = await roundView(firstStaff, firstRound.id);
    expect(current.version).not.toBe(previous.version);
    const reply = { clientMessageId: randomUUID(), content: '旧客服不应能发送这条消息', version: previous.version };
    expect((await firstStaff.request.post(`/api/seller/chat/rounds/${firstRound.id}/messages`, { headers: sellerHeaders, data: reply })).status()).toBe(409);
    expect((await firstStaff.request.post(`/api/seller/chat/rounds/${firstRound.id}/messages`, { headers: sellerHeaders, data: { ...reply, version: current.version } })).status()).toBe(403);
    expect((await manager.request.post(`/api/seller/chat/rounds/${firstRound.id}/messages`, { headers: sellerHeaders, data: { ...reply, clientMessageId: randomUUID(), version: current.version } })).status()).toBe(403);
    expect((await firstStaff.request.post(`/api/seller/chat/rounds/${firstRound.id}/close`, { headers: sellerHeaders, data: { version: current.version, resolution: '未授权结束' } })).status()).toBe(403);
    expect(await chat.db.message.count({ where: { conversation_id: firstRound.id, content: reply.content } })).toBe(0);
    await secondStaff.goto(`/#/seller/messages/${firstRound.id}`);
    await expect(messages(secondStaff).getByText('已核对商品，可以继续处理您的订单问题。', { exact: true })).toBeVisible();
    await send(secondStaff, '已经接手，订单问题由我继续跟进。');
    await expect(messages(page).getByText('已经接手，订单问题由我继续跟进。', { exact: true })).toBeVisible({ timeout: 10000 });
  });

  await test.step('ship the order and reject cancellation after shipping', async () => {
    await secondStaff.goto(`/#/seller/orders/${orderId}`);
    await secondStaff.getByRole('button', { name: '标记已发货', exact: true }).click();
    await secondStaff.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(secondStaff.getByRole('heading', { name: '已发货', exact: true })).toBeVisible();
    expect((await secondStaff.request.post(`/api/seller/orders/${orderId}/ship`, { headers: sellerHeaders })).status()).toBe(200);
    expect((await page.request.post(`/api/orders/${orderId}/cancel`)).status()).toBe(409);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.getByRole('heading', { name: '已发货', exact: true })).toBeVisible();
    expect((await chat.db.sku.findUniqueOrThrow({ where: { id: sku.id } })).stock_quantity).toBe(1);
    expect(await chat.db.order.count({ where: { buyer_id: chat.users[0] } })).toBe(1);
  });

  await test.step('close the round and start a fresh human round in the same persistent channel', async () => {
    await secondStaff.goto(`/#/seller/messages/${firstRound.id}`);
    await secondStaff.getByRole('button', { name: '结束接待', exact: true }).click();
    const dialog = secondStaff.getByRole('dialog', { name: '结束接待', exact: true });
    await dialog.getByLabel('处理摘要', { exact: true }).fill('已核对购买并完成发货咨询');
    await dialog.getByRole('button', { name: '确认结束', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.goto(`/#/messages/${chat.shopId}`);
    await send(page, '发货后再咨询一下使用方式');
    const rounds = await chat.db.conversation.findMany({ where: { channel_id: firstRound.channel_id } });
    expect(rounds).toHaveLength(2);
    const next = rounds.find((round) => round.status !== 'closed')!;
    expect(next.status).toBe('seller'); expect(next.assigned_seller_id).toBe(chat.users[1]);
    expect(next.requirement_state).toEqual({});
    expect(await chat.db.chatChannel.count({ where: { buyer_id: chat.users[0], shop_id: chat.shopId } })).toBe(1);
    await expect(messages(page).getByText('已经接手，订单问题由我继续跟进。', { exact: true })).toBeVisible();
    const old = await roundView(secondStaff, firstRound.id);
    expect((await secondStaff.request.post(`/api/seller/chat/rounds/${firstRound.id}/messages`, { headers: sellerHeaders, data: { version: old.version, clientMessageId: randomUUID(), content: '不能向结束轮次补发' } })).status()).toBe(409);
    expect(await chat.db.inquiry.count({ where: { conversation_id: firstRound.id, status: 'resolved' } })).toBe(1);
    expect(await chat.db.message.count({ where: { conversation_id: firstRound.id, sender_type: 'agent' } })).toBe(1);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('complete-shopping-chat-journey.png'), fullPage: true });
  });
});

test('owner configures reception capacity while ordinary staff cannot change it', async ({ page, chat }, info) => {
  await chat.db.shopMember.update({ where: { id: chat.members[3] }, data: { role: 'owner' } });
  await chat.login(page, 3); await page.goto('/#/seller/messages');
  await page.getByRole('button', { name: '接待容量', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '接待容量', exact: true });
  await expect(dialog.getByLabel('每名客服同时接待上限', { exact: true })).toHaveValue('1');
  await dialog.getByLabel('每名客服同时接待上限', { exact: true }).fill('3');
  await dialog.getByRole('button', { name: '保存容量', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('当前接待 0，容量 3', { exact: true })).toBeVisible();
  expect((await chat.db.shop.findUniqueOrThrow({ where: { id: chat.shopId } })).chat_capacity).toBe(3);
  await expect(page.getByRole('button', { name: '开启提示音', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开启提示音', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭提示音', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: '关闭提示音', exact: true })).toBeVisible();
  const staff = await chat.openStaff(1); await staff.goto('/#/seller/messages');
  await expect(staff.getByRole('button', { name: '接待容量', exact: true })).toHaveCount(0);
  const settings = await staff.request.get('/api/seller/chat/settings', { headers: { 'x-shop-id': chat.shopId } });
  expect((await staff.request.post('/api/seller/chat/settings', { headers: { 'x-shop-id': chat.shopId }, data: { capacity: 10, version: (await settings.json()).version } })).status()).toBe(403);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('reception-settings.png'), fullPage: true });
});

test('assignment and unread reminders survive refresh, respect reading position and never replace a reply draft', async ({ page, chat }, info) => {
  await chat.db.shop.update({ where: { id: chat.shopId }, data: { chat_capacity: 3 } });
  await chat.login(page, 0); const staff = await chat.openStaff(1); await staff.goto('/#/seller/messages');
  await staff.getByRole('button', { name: '上线接待', exact: true }).click();
  const post = async (target: Page, content: string) => { const response = await target.request.post(`/api/chat/shops/${chat.shopId}/messages`, { data: { content, clientMessageId: randomUUID() } }); expect(response.status()).toBe(201); return response.json(); };
  await post(page, '分配后应当提醒客服');
  const row = staff.locator('.reception-row').filter({ hasText: chat.names[0]! });
  await expect(row.getByLabel('未读提醒', { exact: true })).toContainText('新分配');
  await expect(staff.locator('.reception-nav-count')).toHaveText('1');
  await staff.reload(); await expect(staff.locator('.reception-nav-count')).toHaveText('1');
  await expect(row.getByLabel('未读提醒', { exact: true })).toContainText('1 条未读');
  await staff.screenshot({ path: info.outputPath('reception-unread-list.png'), fullPage: true });
  const first = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId } });
  await row.click(); await staff.bringToFront();
  const readState = () => chat.db.chatReadState.findUnique({ where: { channel_id_user_id: { channel_id: first.channel_id, user_id: chat.users[1]! } } });
  await expect.poll(async () => (await readState())?.read_sequence ?? 0).toBeGreaterThanOrEqual(2);
  await expect(staff.locator('.reception-nav-count')).toHaveCount(0);
  await staff.getByLabel('消息内容', { exact: true }).fill('保留正在编辑的回复');
  for (let i = 0; i < 12; i++) await post(page, `阅读位置测试 ${i}：${'商品说明。'.repeat(25)}`);
  const channel = await chat.db.chatChannel.findUniqueOrThrow({ where: { id: first.channel_id } });
  await expect.poll(async () => (await readState())?.read_sequence ?? 0).toBe(channel.next_sequence);
  await messages(staff).evaluate(node => { node.scrollTop = 0; });
  const oldSequence = (await readState())!.read_sequence;
  const next = await post(page, '阅读旧消息时，新消息保持未读');
  await expect(messages(staff).getByText('阅读旧消息时，新消息保持未读', { exact: true })).toBeAttached();
  expect((await readState())!.read_sequence).toBe(oldSequence);
  await expect(staff.locator('.reception-nav-count')).toHaveText('1');
  await expect(staff.getByLabel('消息内容', { exact: true })).toHaveValue('保留正在编辑的回复');
  await staff.getByRole('button', { name: '回到最新消息', exact: false }).click();
  await expect.poll(async () => (await readState())!.read_sequence).toBe(next.sequence);
  const secondBuyer = await chat.openStaff(4); await post(secondBuyer, '另一位买家需要帮助'); await staff.bringToFront();
  await expect(staff.getByRole('status', { name: '接待提醒', exact: true })).toBeVisible();
  await expect(staff).toHaveURL(new RegExp(`/seller/messages/${first.id}$`));
  await expect(staff.getByLabel('消息内容', { exact: true })).toHaveValue('保留正在编辑的回复');
  expect(await staff.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const fits = await staff.getByRole('button', { name: '发送消息', exact: true }).evaluate(button => button.getBoundingClientRect().bottom <= innerHeight + 1); expect(fits).toBe(true);
  await staff.screenshot({ path: info.outputPath('reception-notification-draft.png'), fullPage: true });
});

test('ordinary transfer excludes offline staff and management requires confirmation for an offline assignment', async ({ page, chat }, info) => {
  await chat.login(page, 0); const staff = await chat.openStaff(1); await staff.goto('/#/seller/messages');
  await staff.getByRole('button', { name: '上线接待', exact: true }).click();
  const sent = await page.request.post(`/api/chat/shops/${chat.shopId}/messages`, { data: { content: '测试离线转接', clientMessageId: randomUUID() } }); expect(sent.status()).toBe(201);
  const roundId = (await sent.json()).roundId;
  await staff.goto(`/#/seller/messages/${roundId}`); await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await staff.getByRole('button', { name: '转接咨询', exact: true }).click();
  const ordinaryDialog = staff.getByRole('dialog', { name: '转接咨询', exact: true });
  await expect(ordinaryDialog.locator(`option[value="${chat.members[2]}"]`)).toBeDisabled();
  await ordinaryDialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const manager = await chat.openStaff(3); await manager.goto(`/#/seller/messages/${roundId}`);
  await manager.getByRole('button', { name: '转接咨询', exact: true }).click();
  const dialog = manager.getByRole('dialog', { name: '转接咨询', exact: true });
  await dialog.getByLabel('接待人员', { exact: true }).selectOption(chat.members[2]!);
  await expect(dialog.getByRole('button', { name: '确认转接', exact: true })).toBeDisabled();
  await dialog.getByLabel('确认指派给离线人员，等待其处理').check();
  await manager.screenshot({ path: info.outputPath('reception-offline-assignment.png'), fullPage: true });
  await dialog.getByRole('button', { name: '确认转接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await chat.db.conversation.findUniqueOrThrow({ where: { id: roundId } })).assigned_seller_id).toBe(chat.users[2]);
  await expect(staff.getByText('暂时无法访问此咨询，请重新加载。', { exact: true })).toBeVisible();
  expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('waiting buyer and leave handoff work through dialogs while preserving history and permissions', async ({ page, chat }, info) => {
  await chat.login(page, 0);
  const first = await chat.openStaff(1); await first.goto('/#/seller/messages');
  await first.getByRole('button', { name: '上线接待', exact: true }).click();
  await page.goto(`/#/messages/${chat.shopId}`); await send(page, '咨询交接体验');
  const round = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId } });
  await first.goto(`/#/seller/messages/${round.id}`); await expect(first.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await send(first, '请提供想要的规格');
  await expect(messages(page).getByText('请提供想要的规格', { exact: true })).toBeVisible();
  await first.getByRole('button', { name: '等待买家', exact: true }).click();
  await expect(first.getByRole('button', { name: '恢复处理', exact: true })).toBeVisible();
  await expect(page.getByText('等待你的回复', { exact: true })).toBeVisible();
  expect((await chat.db.conversation.findUniqueOrThrow({ where: { id: round.id } })).waiting_buyer_since).not.toBeNull();
  await first.screenshot({ path: info.outputPath('reception-waiting-buyer.png'), fullPage: true });
  await send(page, '我要蓝色的');
  await expect(first.getByRole('button', { name: '等待买家', exact: true })).toBeVisible();
  const second = await chat.openStaff(2); await second.goto('/#/seller/messages');
  await second.getByRole('button', { name: '上线接待', exact: true }).click();
  await expect.poll(async () => { const response = await first.request.get('/api/seller/chat/availability', { headers: { 'x-shop-id': chat.shopId } }); return (await response.json()).activeCount; }).toBe(1);
  // Header availability is periodically refreshed. Wait for its actual control.
  await expect(first.getByRole('button', { name: '离岗交接', exact: true })).toBeVisible({ timeout: 20000 });
  expect(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await first.getByRole('button', { name: '发送消息', exact: true }).evaluate(button => button.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
  await first.getByRole('button', { name: '离岗交接', exact: true }).click();
  const dialog = first.getByRole('dialog', { name: '离岗交接', exact: true });
  await expect(dialog).toContainText('将 1 轮咨询');
  await first.screenshot({ path: info.outputPath('reception-leave-dialog.png'), fullPage: true });
  await dialog.getByRole('button', { name: '确认离岗交接', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await chat.db.conversation.findUniqueOrThrow({ where: { id: round.id } })).assigned_seller_id).toBe(chat.users[2]);
  await expect(first.getByText('暂时无法访问此咨询，请重新加载。', { exact: true })).toBeVisible();
  await second.goto(`/#/seller/messages/${round.id}`);
  await expect(messages(second).getByText('我要蓝色的', { exact: true })).toBeVisible();
  await send(second, '已接续为你处理');
  await expect(messages(page).getByText('已接续为你处理', { exact: true })).toBeVisible();
  expect(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await second.getByRole('button', { name: '发送消息', exact: true }).evaluate(button => button.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
});

test('buyer end dialog refuses unseen new replies and reopening retains the channel history', async ({ page, chat }, info) => {
  await chat.login(page, 0); const staff = await chat.openStaff(1); await staff.goto('/#/seller/messages');
  await staff.getByRole('button', { name: '上线接待', exact: true }).click();
  await page.goto(`/#/messages/${chat.shopId}`); await send(page, '结束前核对回复');
  const round = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId } });
  await staff.goto(`/#/seller/messages/${round.id}`); await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '结束咨询', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '结束本轮咨询', exact: true });
  await send(staff, '刚刚到达的人工回复');
  await dialog.getByRole('button', { name: '确认结束咨询', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('收到新消息');
  expect((await chat.db.conversation.findUniqueOrThrow({ where: { id: round.id } })).status).toBe('seller');
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(messages(page).getByText('刚刚到达的人工回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '结束咨询', exact: true }).click();
  await page.screenshot({ path: info.outputPath('reception-buyer-end.png'), fullPage: true });
  await dialog.getByRole('button', { name: '确认结束咨询', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await chat.db.conversation.findUniqueOrThrow({ where: { id: round.id } })).status).toBe('closed');
  await expect(page.getByText('上次咨询已结束，可继续发送新问题', { exact: true })).toBeVisible();
  await send(page, '新一轮问题');
  const rounds = await chat.db.conversation.findMany({ where: { channel_id: round.channel_id } });
  expect(rounds).toHaveLength(2); expect(rounds.filter(r => r.status !== 'closed')).toHaveLength(1);
  await expect(messages(page).getByText('刚刚到达的人工回复', { exact: true })).toBeVisible();
});

test('buyer and manager can end Agent rounds without assigning them to staff', async ({ page, chat }, info) => {
  test.skip(process.env.AGENT_MODE !== 'mock', 'Requires explicit mock mode');
  await chat.login(page, 0); await page.goto(`/#/messages/${chat.shopId}`); await send(page, '结束导购咨询');
  await expect(messages(page).getByRole('article', { name: '导购助手消息', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '结束咨询', exact: true }).click();
  await page.getByRole('dialog', { name: '结束本轮咨询', exact: true }).getByRole('button', { name: '确认结束咨询', exact: true }).click();
  await expect(page.getByText('上次咨询已结束，可继续发送新问题', { exact: true })).toBeVisible();
  await send(page, '再开一轮导购');
  await expect(messages(page).getByRole('article', { name: '导购助手消息', exact: true })).toHaveCount(2);
  const active = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId, status: 'agent' } });
  const staff = await chat.openStaff(1); await staff.goto(`/#/seller/messages/${active.id}`);
  await expect(staff.getByRole('heading', { name: '接待会话', exact: true })).toBeVisible();
  await expect(staff.getByRole('button', { name: '结束导购接待', exact: true })).toHaveCount(0);
  const manager = await chat.openStaff(3); await manager.goto(`/#/seller/messages/${active.id}`);
  await manager.getByRole('button', { name: '结束导购接待', exact: true }).click();
  await manager.screenshot({ path: info.outputPath('reception-manager-end-agent.png'), fullPage: true });
  await manager.getByRole('dialog', { name: '结束本轮咨询', exact: true }).getByRole('button', { name: '确认结束咨询', exact: true }).click();
  await expect.poll(async () => (await chat.db.conversation.findUniqueOrThrow({ where: { id: active.id } })).status).toBe('closed');
  expect(await chat.db.inquiry.count({ where: { conversation_id: active.id } })).toBe(0);
  expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('reception summary and reviewed suggestion stay private, preserve drafts and require manual sending', async ({ page, chat }, info) => {
  test.skip(process.env.AGENT_MODE !== 'mock', 'Requires explicit mock mode');
  await chat.login(page, 0); await page.goto(`/#/messages/${chat.shopId}`);
  await send(page, '搜索 商品，预算最多2');
  await expect(messages(page).getByRole('article', { name: '导购助手消息', exact: true })).toBeVisible();
  const staff = await chat.openStaff(1); await staff.goto('/#/seller/messages'); await staff.getByRole('button', { name: '上线接待', exact: true }).click();
  await requestHuman(page, chat.shopId);
  const round = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId } });
  await staff.goto(`/#/seller/messages/${round.id}`); await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  const before = await chat.db.message.count({ where: { conversation_id: round.id } });
  await staff.getByRole('button', { name: '接待摘要', exact: true }).click();
  const summary = staff.getByRole('dialog', { name: '接待摘要', exact: true });
  await expect(summary.getByRole('heading', { name: '已识别需求', exact: true })).toBeVisible();
  await expect(summary).toContainText('最多 2 元');
  await staff.screenshot({ path: info.outputPath('reception-context.png'), fullPage: true });
  await summary.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await staff.getByLabel('消息内容', { exact: true }).fill('保留原来的人工草稿');
  await staff.getByRole('button', { name: '建议回复', exact: true }).click();
  const dialog = staff.getByRole('dialog', { name: '建议回复', exact: true });
  await dialog.getByRole('button', { name: '生成建议', exact: true }).click();
  await expect(dialog.getByLabel('建议草稿', { exact: true })).not.toHaveValue('');
  const proposed = await dialog.getByLabel('建议草稿', { exact: true }).inputValue();
  expect(await chat.db.message.count({ where: { conversation_id: round.id } })).toBe(before);
  await expect(staff.getByLabel('消息内容', { exact: true })).toHaveValue('保留原来的人工草稿');
  await expect(dialog.getByRole('button', { name: '替换当前草稿', exact: true })).toBeDisabled();
  await dialog.getByLabel('确认替换当前草稿', { exact: true }).check();
  await staff.screenshot({ path: info.outputPath('reception-suggestion-review.png'), fullPage: true });
  await dialog.getByRole('button', { name: '替换当前草稿', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(staff.getByLabel('消息内容', { exact: true })).toHaveValue(proposed);
  expect(await chat.db.message.count({ where: { conversation_id: round.id } })).toBe(before);
  await staff.getByLabel('消息内容', { exact: true }).fill('这是人工审核修改后的答复');
  expect(await staff.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await staff.getByRole('button', { name: '发送消息', exact: true }).evaluate(node => node.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
  await staff.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(messages(page).getByText('这是人工审核修改后的答复', { exact: true })).toBeVisible();
  const sent = await chat.db.message.findFirstOrThrow({ where: { conversation_id: round.id, sender_type: 'seller' } }); expect(sent.sender_user_id).toBe(chat.users[1]);
  expect(await chat.db.message.count({ where: { conversation_id: round.id, content: proposed } })).toBe(0);
});

test('stale suggestions refuse sending after buyer supplements while retaining the editable draft', async ({ page, chat }) => {
  await chat.login(page, 0); const staff = await chat.openStaff(1); await staff.goto('/#/seller/messages'); await staff.getByRole('button', { name: '上线接待', exact: true }).click();
  await page.goto(`/#/messages/${chat.shopId}`); await send(page, '请帮我核对商品');
  const round = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId } });
  await staff.goto(`/#/seller/messages/${round.id}`); await expect(staff.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await staff.getByRole('button', { name: '建议回复', exact: true }).click();
  const dialog = staff.getByRole('dialog', { name: '建议回复', exact: true });
  await dialog.getByRole('button', { name: '生成建议', exact: true }).click();
  await expect(dialog.getByLabel('建议草稿', { exact: true })).toBeVisible();
  const proposed = await dialog.getByLabel('建议草稿', { exact: true }).inputValue();
  await dialog.getByRole('button', { name: '填入草稿', exact: true }).click();
  await send(page, '新增一个不同的要求');
  await staff.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(staff.getByRole('alert')).toContainText('重新生成建议');
  await expect(staff.getByLabel('消息内容', { exact: true })).toHaveValue(proposed);
  expect(await chat.db.message.count({ where: { conversation_id: round.id, sender_type: 'seller' } })).toBe(0);
  await staff.getByRole('button', { name: '改为手动回复', exact: true }).click();
  await send(staff, '已结合你的最新要求重新核对');
  await expect(messages(page).getByText('已结合你的最新要求重新核对', { exact: true })).toBeVisible();
});

test('ordinary staff cannot browse other tasks or later rounds, but managers retain shop supervision', async ({ page, chat }, info) => {
  await chat.login(page, 0); const first = await chat.openStaff(1); await first.goto('/#/seller/messages');
  await expect(first.getByRole('button', { name: '全部咨询', exact: true })).toHaveCount(0);
  await expect(first.getByRole('button', { name: '我的已结束', exact: true })).toBeVisible();
  await first.getByRole('button', { name: '上线接待', exact: true }).click();
  await page.goto(`/#/messages/${chat.shopId}`); await send(page, '原负责人的咨询');
  const original = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId } });
  await first.goto(`/#/seller/messages/${original.id}`); await expect(first.getByLabel('消息内容', { exact: true })).toBeEnabled();
  await first.getByRole('button', { name: '结束接待', exact: true }).click();
  const close = first.getByRole('dialog', { name: '结束接待', exact: true }); await close.getByLabel('处理摘要', { exact: true }).fill('本人已处理'); await close.getByRole('button', { name: '确认结束', exact: true }).click();
  await expect(first.getByText('本轮接待已结束，记录仅供查看。', { exact: true })).toBeVisible();
  await expect(first.getByRole('button', { name: '全部历史', exact: true })).toBeDisabled();
  await first.getByRole('button', { name: '暂停接待', exact: true }).click();
  const second = await chat.openStaff(2); await second.goto('/#/seller/messages'); await second.getByRole('button', { name: '上线接待', exact: true }).click();
  await send(page, '后来的私密咨询内容');
  const active = await chat.db.conversation.findFirstOrThrow({ where: { shop_id: chat.shopId, status: 'seller' } });
  await first.getByRole('button', { name: '刷新咨询', exact: true }).click();
  await expect(first.getByRole('link', { name: '进入当前接待', exact: false })).toHaveCount(0);
  const denied = await first.request.get(`/api/seller/chat/rounds/${active.id}`, { headers: { 'x-shop-id': chat.shopId } }); expect(denied.status()).toBe(404);
  await first.getByRole('button', { name: '接待摘要', exact: true }).click();
  const summary = first.getByRole('dialog', { name: '接待摘要', exact: true });
  await expect(summary).toContainText('原负责人的咨询'); await expect(summary).not.toContainText('后来的私密咨询内容');
  await first.screenshot({ path: info.outputPath('reception-staff-scope.png'), fullPage: true });
  const manager = await chat.openStaff(3); await manager.goto('/#/seller/messages'); await manager.getByRole('button', { name: '全部咨询', exact: true }).click();
  await expect(manager.locator('.reception-row')).toHaveCount(2);
  await manager.goto(`/#/seller/messages/${active.id}`); await expect(messages(manager).getByText('后来的私密咨询内容', { exact: true })).toBeVisible();
  await expect(manager.getByRole('button', { name: '建议回复', exact: true })).toHaveCount(0);
});

test('SSE task feedback shows actual lookup, fits both layouts and respects reduced motion', async ({ page, chat }, info) => {
  test.skip(process.env.CHAT_PROGRESS_FIXTURE !== '1', 'Requires isolated slow mock progress fixture');
  await chat.login(page, 0); await page.goto(`/#/messages/${chat.shopId}`);
  await send(page, '进度体验：搜索商品');
  const activity = messages(page).locator('.chat-activity');
  await expect(activity).toContainText('已搜索商品，正在整理推荐结果');
  expect(await activity.evaluate(node => { const b=node.getBoundingClientRect(), parent=node.closest('.chat-messages')!.getBoundingClientRect(); return b.left>=0 && b.right<=innerWidth && b.top>=parent.top && b.bottom<=Math.min(parent.bottom,innerHeight); })).toBe(true);
  await page.screenshot({path: info.outputPath('agent-task-progress.png'), fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  expect(await activity.locator('.chat-activity-glow').evaluate(node=>getComputedStyle(node,'::after').animationName)).toBe('none');
  await expect(messages(page).getByRole('article',{name:'导购助手消息',exact:true})).toBeVisible({timeout:10000});
  await expect(activity).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('SSE progress works in the product widget and closes on handoff without a late reply', async ({ page, chat }, info) => {
  test.skip(process.env.CHAT_PROGRESS_FIXTURE !== '1', 'Requires isolated slow mock progress fixture');
  await chat.login(page,0); await page.goto(`/#/products/${chat.productId}`);
  await page.getByRole('button',{name:'联系客服',exact:true}).click();
  const widget=page.getByRole('dialog',{name:'客服咨询',exact:true});
  await send(page,'进度体验：看看商品');
  await expect(widget.locator('.chat-activity')).toContainText('已查询商品规格');
  expect(await widget.locator('.chat-activity').evaluate(node=>{const b=node.getBoundingClientRect(), parent=node.closest('.chat-messages')!.getBoundingClientRect(); return b.top>=parent.top && b.bottom<=Math.min(parent.bottom,innerHeight); })).toBe(true);
  expect(await widget.getByRole('button',{name:'发送消息',exact:true}).evaluate(node=>node.getBoundingClientRect().bottom<=Math.min(innerHeight,node.closest('.chat-thread')!.getBoundingClientRect().bottom))).toBe(true);
  await page.screenshot({path:info.outputPath('widget-task-progress.png'),fullPage:true});
  await widget.getByRole('button',{name:'转人工',exact:true}).click();
  await expect(widget.locator('.chat-activity')).toHaveCount(0);
  await expect(widget.getByText('等待客服接待',{exact:true})).toBeVisible();
  await expect.poll(async()=>chat.db.message.count({where:{conversation:{shop_id:chat.shopId},sender_type:'agent'}})).toBe(0);
  await page.getByRole('button',{name:'收起客服窗口',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('SSE reconnect catches up and blocked streaming falls back to cursor polling', async ({ page, chat }) => {
  await chat.login(page,0);
  await page.route('**/events',route=>route.abort());
  await page.goto(`/#/messages/${chat.shopId}`); await send(page,'断开推送也能收到回复');
  await expect(messages(page).getByRole('article',{name:'导购助手消息',exact:true})).toBeVisible({timeout:10000});
  await page.unroute('**/events');
  // Drop only the first stream after a complete frame, then allow a real SSE
  // reconnect. The next snapshot must trigger cursor catch-up with no duplicates.
  let dropped=false;
  await page.route('**/events',async route=>{if(!dropped){dropped=true;await route.fulfill({status:200,contentType:'text/event-stream',body:'event: heartbeat\ndata: {}\n\n'});}else await route.continue();});
  await page.reload();
  await expect(messages(page).getByRole('article',{name:'导购助手消息',exact:true})).toHaveCount(1);
  await send(page,'重连后继续问');
  await expect(messages(page).getByRole('article',{name:'导购助手消息',exact:true})).toHaveCount(2,{timeout:10000});
  await page.unroute('**/events');
});

test('suggestion task feedback stays in the review dialog, cancellation preserves draft and sends nothing', async ({ page, chat }, info) => {
  test.skip(process.env.CHAT_PROGRESS_FIXTURE !== '1', 'Requires isolated slow mock progress fixture');
  await chat.login(page,0); const staff=await chat.openStaff(1); await staff.goto('/#/seller/messages'); await staff.getByRole('button',{name:'上线接待',exact:true}).click();
  await page.goto(`/#/messages/${chat.shopId}`); await send(page,'进度体验：请客服查找商品');
  const round=await chat.db.conversation.findFirstOrThrow({where:{shop_id:chat.shopId}});
  await staff.goto(`/#/seller/messages/${round.id}`); await staff.getByLabel('消息内容',{exact:true}).fill('保留人工草稿');
  await staff.getByRole('button',{name:'建议回复',exact:true}).click(); const dialog=staff.getByRole('dialog',{name:'建议回复',exact:true});
  await dialog.getByRole('button',{name:'生成建议',exact:true}).click(); await expect(dialog.locator('.chat-activity')).toContainText('已搜索商品，正在整理建议回复');
  await expect(messages(page).locator('.chat-activity')).toHaveCount(0);
  await staff.screenshot({path:info.outputPath('suggestion-task-progress.png'),fullPage:true});
  await dialog.getByRole('button',{name:'取消生成',exact:true}).click(); await expect(dialog).toHaveCount(0);
  await expect(staff.getByLabel('消息内容',{exact:true})).toHaveValue('保留人工草稿');
  expect(await chat.db.message.count({where:{conversation_id:round.id,sender_type:'seller'}})).toBe(0);
});

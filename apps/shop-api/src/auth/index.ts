import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma, type PrismaClient } from '@shop/database';
import { hashPassword, verifyPassword } from '@shop/database/password';
import { accountAvailabilitySchema, accountPasswordSchema, accountProfileSchema, accountRenameSchema, loginSchema, type AccountDto, type AuthUserDto, type SessionDto } from '@shop/contracts';
import { nextStamp } from '../transactions/locks.ts';

const cookieName = 'shop_session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export interface AuthSessions {
  now: () => number;
  isLive: (key: string, user: { id: string; status: string; password_hash: string | null; platform_role: string; auth_version: number }) => boolean;
}
interface Session { userId: string; expiresAt: number; credentialVersion: string }
interface Identity { user: AuthUserDto; userId: string; version: string; expiresAt: string }
declare module 'fastify' {
  interface FastifyRequest { identity: Identity | null; credentialVersion: string | null; sessionKey: string | null }
}
export interface AuthOptions {
  now?: () => number;
  ttlMs?: number;
  secureCookie?: boolean;
  trustedOrigins?: string[];
  loginLimit?: number;
}
function tokenFrom(request: FastifyRequest) {
  const matches = (request.headers.cookie ?? '').split(';').map((c) => c.trim()).filter((c) => c.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(cookieName.length + 1);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}
function setCookie(reply: FastifyReply, token: string, maxAge: number, secure: boolean) {
  reply.header('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
export async function requireUser(request: FastifyRequest) {
  if (!request.identity) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录，或重新登录后继续');
}
export async function requireBuyer(request: FastifyRequest) {
  await requireUser(request);
  if (!request.identity!.user.canShop) throw new HttpError(403, 'BUYER_ONLY', '工作账号不能使用个人购物功能，请使用独立的买家账号');
}
const credentialVersion = (user: { password_hash: string | null; platform_role: string; auth_version: number }) => digest(`${user.password_hash}\0${user.platform_role}\0${user.auth_version}`);
// The caller locks the user row before checking, keeping sensitive account
// changes from racing a membership mutation. Never expose this fingerprint.
export async function requireLiveIdentity(request: FastifyRequest, tx: Prisma.TransactionClient) {
  const user = await tx.user.findUnique({ where: { id: request.identity!.userId } });
  if (!user || user.status !== 'active' || !user.password_hash || credentialVersion(user) !== request.credentialVersion) {
    throw new HttpError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
  }
}
// Call after locking the user row. A classification change cannot pass a guard
// and then race a cart/order/address/chat write in the same request.
export async function requireLiveBuyer(request: FastifyRequest, tx: Prisma.TransactionClient) {
  await requireLiveIdentity(request, tx);
  const user = await tx.user.findUniqueOrThrow({ where: { id: request.identity!.userId } });
  if (user.account_kind !== 'customer' || user.platform_role !== 'user') throw new HttpError(403, 'BUYER_ONLY', '工作账号不能使用个人购物功能，请使用独立的买家账号');
}
export async function lockBuyerIdentity(request: FastifyRequest, tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM users WHERE id=${request.identity!.userId}::uuid FOR SHARE`;
  await requireLiveBuyer(request, tx);
}
export async function requirePlatformAdmin(request: FastifyRequest) {
  await requireUser(request);
  if (request.identity!.user.platformRole !== 'admin') throw new HttpError(403, 'PLATFORM_FORBIDDEN', '此功能仅限平台管理员使用');
}

export function registerAuth(app: FastifyInstance, db: PrismaClient, options: AuthOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1000;
  const secure = options.secureCookie ?? process.env.NODE_ENV === 'production';
  const trustedOrigins = new Set(options.trustedOrigins ?? (process.env.APP_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3000,http://localhost:3000').split(',').map((o) => o.trim()));
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  const accountAttempts = new Map<string, { count: number; expiresAt: number }>();
  app.decorateRequest('identity', null);
  app.decorateRequest('credentialVersion', null);
  app.decorateRequest('sessionKey', null);
  async function identity(user: { id: string; username: string; display_name: string; platform_role: string; account_kind: string }): Promise<AuthUserDto> {
    const count = await db.shopMember.count({ where: { user_id: user.id, status: 'active', shop: { status: 'active' } } });
    return { username: user.username, displayName: user.display_name, platformRole: user.platform_role as AuthUserDto['platformRole'], canManageShops: count > 0, canShop: user.account_kind === 'customer' && user.platform_role === 'user' };
  }
  function accountLimit(request: FastifyRequest, reply: FastifyReply, action: string, maximum: number, windowMs: number) {
    const current = now();
    for (const [key, entry] of accountAttempts) if (entry.expiresAt <= current) accountAttempts.delete(key);
    const key = `${request.identity!.userId}:${action}`;
    const entry = accountAttempts.get(key) ?? { count: 0, expiresAt: current + windowMs };
    if (entry.count >= maximum || (!accountAttempts.has(key) && accountAttempts.size >= 10000)) {
      reply.header('Retry-After', Math.max(1, Math.ceil((entry.expiresAt - current) / 1000)));
      throw new HttpError(429, 'ACCOUNT_RATE_LIMITED', '操作过于频繁，请稍后重试');
    }
    entry.count++; accountAttempts.set(key, entry);
  }
  const publicSession = (value: Identity): SessionDto => ({ user: value.user, expiresAt: value.expiresAt });
  async function publicAccount(value: Identity): Promise<AccountDto> {
    const memberships = await db.shopMember.findMany({ where: { user_id: value.userId, status: 'active', shop: { status: 'active' } }, select: { shop_id: true, role: true, shop: { select: { name: true } } }, orderBy: { shop_id: 'asc' } });
    return { user: value.user, expiresAt: value.expiresAt, version: value.version,
      shopPositions: memberships.map((member) => ({ shopId: member.shop_id, shopName: member.shop.name, role: member.role as AccountDto['shopPositions'][number]['role'] })) };
  }
  function revokeSessions(request: FastifyRequest, reply: FastifyReply) {
    for (const [key, session] of sessions) if (session.userId === request.identity!.userId) sessions.delete(key);
    setCookie(reply, '', 0, secure);
  }
  async function lockedAccount(tx: Prisma.TransactionClient, request: FastifyRequest, version: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${request.identity!.userId}::uuid FOR UPDATE`;
    await requireLiveIdentity(request, tx);
    const user = await tx.user.findUniqueOrThrow({ where: { id: request.identity!.userId } });
    if (user.updated_at.toISOString() !== version) throw new HttpError(409, 'ACCOUNT_CHANGED', '账号资料已更新，请重新加载后操作');
    return user;
  }
  async function accountWrite<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    try { return await db.$transaction(work, { maxWait: 10000, timeout: 15000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034','P2028'].includes(error.code)) throw new HttpError(409, 'ACCOUNT_BUSY', '其他操作正在修改账号，请重新加载后操作');
      throw error;
    }
  }
  app.addHook('onClose', async () => { sessions.clear(); attempts.clear(); accountAttempts.clear(); });
  app.addHook('onRequest', async (request, reply) => {
    // Apply before parsing bodies; future mutation routes inherit this check.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if ((origin && !trustedOrigins.has(origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', '请求来源不受信任');
      }
    }
    const token = tokenFrom(request);
    if (!token) return;
    // Resolve the live account so role changes and disabled accounts take effect.
    const key = digest(token);
    const session = sessions.get(key);
    if (!session || session.expiresAt <= now()) {
      sessions.delete(key);
      setCookie(reply, '', 0, secure);
      return;
    }
    const user = await db.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'active' || !user.password_hash || credentialVersion(user) !== session.credentialVersion || !['user', 'admin'].includes(user.platform_role)) {
      sessions.delete(key);
      setCookie(reply, '', 0, secure);
      return;
    }
    request.identity = { user: await identity(user), userId: user.id, version: user.updated_at.toISOString(), expiresAt: new Date(session.expiresAt).toISOString() };
    request.credentialVersion = session.credentialVersion;
    request.sessionKey = key;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/auth/') || request.url.startsWith('/api/account') || request.url.startsWith('/api/seller/') || request.url.startsWith('/api/admin/') || request.url.startsWith('/api/cart') || request.url.startsWith('/api/orders') || request.url.startsWith('/api/chat/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.post('/api/auth/login', async (request, reply): Promise<SessionDto> => {
    const current = now();
    for (const [key, attempt] of attempts) if (attempt.expiresAt <= current) attempts.delete(key);
    const bucket = attempts.get(request.ip) ?? { count: 0, expiresAt: current + 60_000 };
    if (bucket.count >= (options.loginLimit ?? 30) || (!attempts.has(request.ip) && attempts.size >= 10000)) {
      reply.header('Retry-After', Math.max(1, Math.ceil((bucket.expiresAt - current) / 1000)));
      throw new HttpError(429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请稍后再试');
    }
    bucket.count++;
    attempts.set(request.ip, bucket);
    const input = loginSchema.parse(request.body);
    const user = await db.user.findUnique({ where: { username: input.username } });
    const valid = await verifyPassword(input.password, user?.password_hash ?? null);
    if (!valid || !user || user.status !== 'active' || !['user', 'admin'].includes(user.platform_role)) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', '账号或密码错误，或账号不可用');
    }
    const authenticatedUser = await identity(user);
    // Do not accept an identity, role, or an existing session ID from the body.
    for (const [key, session] of sessions) if (session.expiresAt <= current) sessions.delete(key);
    if (sessions.size >= 10000) throw new HttpError(503, 'SESSION_CAPACITY', '登录服务繁忙，请稍后重试');
    const existing = tokenFrom(request);
    if (existing) sessions.delete(digest(existing));
    const token = randomBytes(32).toString('hex');
    const expiresAt = now() + ttlMs;
    sessions.set(digest(token), { userId: user.id, expiresAt, credentialVersion: credentialVersion(user) });
    setCookie(reply, token, Math.max(1, Math.floor(ttlMs / 1000)), secure);
    return { user: authenticatedUser, expiresAt: new Date(expiresAt).toISOString() };
  });
  app.get('/api/auth/me', async (request): Promise<SessionDto> => request.identity ? publicSession(request.identity) : { user: null, expiresAt: null });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = tokenFrom(request);
    if (token) sessions.delete(digest(token));
    setCookie(reply, '', 0, secure);
    return { ok: true };
  });
  app.get('/api/account', { preHandler: requireUser }, async (request) => publicAccount(request.identity!));
  app.get('/api/account/username-availability', { preHandler: requireUser }, async (request, reply) => {
    accountLimit(request, reply, 'availability', 60, 60_000);
    const { username } = accountAvailabilitySchema.parse(request.query);
    const existing = await db.accountName.findUnique({ where: { username } });
    return { available: !existing || (username === request.identity!.user.username && existing.retired_at === null && existing.user_id === request.identity!.userId) };
  });
  app.put('/api/account/profile', { preHandler: requireUser }, async (request, reply): Promise<AccountDto> => {
    accountLimit(request, reply, 'profile', 30, 60_000);
    const input = accountProfileSchema.parse(request.body);
    const user = await accountWrite(async (tx) => {
      const row = await lockedAccount(tx, request, input.version);
      if (row.display_name === input.displayName) return row;
      return tx.user.update({ where: { id: row.id }, data: { display_name: input.displayName, updated_at: nextStamp(row) } });
    });
    return publicAccount({ user: await identity(user), userId: user.id, expiresAt: request.identity!.expiresAt, version: user.updated_at.toISOString() });
  });
  app.put('/api/account/username', { preHandler: requireUser }, async (request, reply) => {
    accountLimit(request, reply, 'credentials', 5, 600_000);
    const input = accountRenameSchema.parse(request.body);
    const current = await db.user.findUnique({ where: { id: request.identity!.userId } });
    if (!await verifyPassword(input.currentPassword, current?.password_hash ?? null)) throw new HttpError(401, 'ACCOUNT_PASSWORD_INVALID', '当前密码不正确');
    let changed = false;
    try {
      changed = await accountWrite(async (tx) => {
        const row = await lockedAccount(tx, request, input.version);
        if (row.username === input.username) return false;
        if (await tx.accountName.findUnique({ where: { username: input.username } })) throw new HttpError(409, 'ACCOUNT_UNAVAILABLE', '账号已被使用或保留，请更换账号');
        await tx.user.update({ where: { id: row.id }, data: { username: input.username, updated_at: nextStamp(row) } });
        return true;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new HttpError(409, 'ACCOUNT_UNAVAILABLE', '账号已被使用或保留，请更换账号');
      throw error;
    }
    if (changed) {
      revokeSessions(request, reply);
      request.log.info({ event: 'account.renamed', actorId: request.identity!.userId }, 'account name changed');
    }
    return { username: input.username, reauthenticate: changed };
  });
  app.put('/api/account/password', { preHandler: requireUser }, async (request, reply) => {
    accountLimit(request, reply, 'credentials', 5, 600_000);
    const input = accountPasswordSchema.parse(request.body);
    const current = await db.user.findUnique({ where: { id: request.identity!.userId } });
    if (!await verifyPassword(input.currentPassword, current?.password_hash ?? null)) throw new HttpError(401, 'ACCOUNT_PASSWORD_INVALID', '当前密码不正确');
    const password_hash = await hashPassword(input.newPassword);
    const user = await accountWrite(async (tx) => {
      const row = await lockedAccount(tx, request, input.version);
      return tx.user.update({ where: { id: row.id }, data: { password_hash, updated_at: nextStamp(row) } });
    });
    revokeSessions(request, reply);
    request.log.info({ event: 'account.password.changed', actorId: request.identity!.userId }, 'account password changed');
    return { username: user.username, reauthenticate: true };
  });
  return { now, isLive: (key, user) => {
    const session = sessions.get(key);
    return !!session && session.userId === user.id && session.expiresAt > now() && user.status === 'active' && !!user.password_hash && session.credentialVersion === credentialVersion(user);
  } } satisfies AuthSessions;
}

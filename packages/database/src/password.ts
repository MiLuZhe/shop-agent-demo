import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const prefix = 'scrypt$32768$8$3';
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, parameters, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string) {
  if (!password || password.length > 128) throw new Error('Password length must be 1–128 characters');
  const salt = randomBytes(16).toString('hex');
  return `${prefix}$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

// The same work is performed for unknown users and accounts without a password.
const dummyHash = `${prefix}$${'0'.repeat(32)}$${'0'.repeat(128)}`;
export async function verifyPassword(password: string, storedHash: string | null) {
  const validFormat = storedHash !== null && /^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(storedHash);
  const candidate = validFormat ? storedHash : dummyHash;
  const parts = candidate.split('$');
  const actual = await derive(password, parts[4]!);
  const matches = timingSafeEqual(actual, Buffer.from(parts[5]!, 'hex'));
  return validFormat && matches;
}

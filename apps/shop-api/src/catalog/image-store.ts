import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TosClient } from '@volcengine/tos-sdk';
import { HttpError } from '../auth/index.ts';

export const imageTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export type ImageFormat = keyof typeof imageTypes;
export const managedImagePattern = /^\/api\/uploads\/([0-9a-f-]{36})\/([0-9a-f-]{36}\.(?:jpg|png|webp))$/;
export const legacyImagePattern = /^[a-z0-9-]+\.jpg$/;
export const uploadRoot = () => path.resolve(process.env.SHOP_UPLOAD_DIR ?? 'data/uploads');
export const demoMediaRoot = () => process.env.SHOP_DEMO_MEDIA_DIR ?? fileURLToPath(new URL('../../../web/public/demo-media/', import.meta.url));
export const imageKey = (shopId: string, filename: string) => `shops/${shopId}/images/${filename}`;
export const legacyKey = (filename: string) => `legacy/demo-media/${filename}`;
export interface StoredImage { versionId?: string }
export type ImageRead = { bytes: Buffer; contentType: string } | { redirect: string };
export interface ImageStore {
  readonly kind: 'local' | 'tos';
  put(shopId: string, filename: string, bytes: Buffer, contentType: string): Promise<StoredImage>;
  remove(shopId: string, filename: string, stored?: StoredImage): Promise<void>;
  read(shopId: string, filename: string): Promise<ImageRead>;
  readLegacy(filename: string): Promise<ImageRead>;
}
export function imageFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
export function assertImageOwnership(urls: string[], shopId: string) {
  for (const url of urls) {
    const managed = managedImagePattern.exec(url);
    if (managed && managed[1] !== shopId) throw new HttpError(400, 'IMAGE_SHOP_MISMATCH', '请使用本店上传的图片');
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url);
      if ([...parsed.searchParams.keys()].some(key => /^x-tos-/i.test(key))) throw new HttpError(400, 'TEMPORARY_IMAGE_URL', '请使用上传图片功能，临时签名链接不能保存为商品图片');
    }
  }
}
const missing = () => new HttpError(404, 'NOT_FOUND', '图片不存在或无权查看');
async function readLocal(filename: string, contentType: string): Promise<ImageRead> {
  try { return { bytes: await readFile(filename), contentType }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing(); throw error; }
}
export function createLocalImageStore(): ImageStore {
  return {
    kind: 'local',
    async put(shopId, filename, bytes) {
      const directory = path.join(uploadRoot(), shopId);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, filename), bytes, { flag: 'wx', mode: 0o600 });
      return {};
    },
    async remove(shopId, filename) { await unlink(path.join(uploadRoot(), shopId, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
    read: (shopId, filename) => readLocal(path.join(uploadRoot(), shopId, filename), imageTypes[filename.split('.').at(-1) as ImageFormat]),
    readLegacy: filename => readLocal(path.join(demoMediaRoot(), filename), 'image/jpeg'),
  };
}
export function createTosClient() {
  const region = process.env.TOS_REGION?.trim(), endpoint = process.env.TOS_ENDPOINT?.trim(), bucket = process.env.TOS_BUCKET?.trim();
  if (!region || !/^[-a-z0-9]+$/.test(region) || endpoint !== `tos-${region}.volces.com` || !bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !process.env.TOS_ACCESS_KEY || !process.env.TOS_SECRET_KEY) throw new Error('TOS backend configuration is incomplete or invalid');
  // Preserve other proxy exclusions; bypass only the configured TOS endpoints.
  const bypass = [...new Set([...(process.env.NO_PROXY ?? '').split(','), ...(process.env.no_proxy ?? '').split(','), endpoint, `${bucket}.${endpoint}`].map(x => x.trim()).filter(Boolean))].join(',');
  process.env.NO_PROXY = bypass; process.env.no_proxy = bypass;
  return { bucket, client: new TosClient({
    accessKeyId: process.env.TOS_ACCESS_KEY, accessKeySecret: process.env.TOS_SECRET_KEY,
    ...(process.env.TOS_SESSION_TOKEN ? { stsToken: process.env.TOS_SESSION_TOKEN } : {}),
    region, endpoint, secure: true, enableVerifySSL: true,
    requestTimeout: 10000, connectionTimeout: 5000, maxRetryCount: 0,
  }) };
}
export function createTosImageStore(): ImageStore {
  const { bucket, client } = createTosClient();
  const unavailable = () => new HttpError(503, 'IMAGE_STORAGE_UNAVAILABLE', '图片服务暂时不可用，请稍后重试');
  const signed = async (key: string): Promise<ImageRead> => {
    try { return { redirect: client.getPreSignedUrl({ bucket, key, method: 'GET', expires: 300 }) }; }
    catch { throw unavailable(); }
  };
  return {
    kind: 'tos',
    async put(shopId, filename, body, contentType) {
      try {
        const result = await client.putObject({ bucket, key: imageKey(shopId, filename), body, contentType, contentMD5: createHash('md5').update(body).digest('base64'), forbidOverwrite: true, cacheControl: 'private, max-age=3600' });
        return { versionId: result.data['x-tos-version-id'] };
      } catch { throw unavailable(); } // SDK exceptions can contain signed request headers.
    },
    async remove(shopId, filename, stored) {
      try { await client.deleteObject({ bucket, key: imageKey(shopId, filename), ...(stored?.versionId ? { versionId: stored.versionId } : {}) }); }
      catch { throw unavailable(); }
    },
    read: (shopId, filename) => signed(imageKey(shopId, filename)),
    readLegacy: filename => signed(legacyKey(filename)),
  };
}
export function createImageStore(): ImageStore {
  const mode = process.env.SHOP_IMAGE_STORAGE ?? 'local';
  if (mode === 'tos') return createTosImageStore();
  if (mode !== 'local') throw new Error('SHOP_IMAGE_STORAGE must be local or tos');
  return createLocalImageStore();
}
export const newImageFilename = (ext: ImageFormat) => `${randomUUID()}.${ext}`;

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const root = process.cwd();
process.loadEnvFile(path.join(root, '.env'));
const work = path.join(homedir(), '.local/share/shop-agent-demo/verification/showcase-deploy-20261118');
const production = process.argv.includes('--production');
const directory = path.join(work, production ? 'production' : 'local');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = JSON.parse(readFileSync(path.join(work, 'release/images.lock.json'), 'utf8'));
const secretPath = path.join(work, 'database-password');
const password = existsSync(secretPath) ? readFileSync(secretPath, 'utf8').trim() : randomBytes(30).toString('base64url');
if (!existsSync(secretPath)) writeFileSync(secretPath, password, { mode: 0o600 });
const ip = production ? '47.111.162.237' : '127.0.0.1';
const origin = `https://${ip}${production ? '' : ':8443'}`;
const previous = existsSync(path.join(directory, '.env')) ? readFileSync(path.join(directory, '.env'), 'utf8') : '';
const tlsMode = production ? previous.includes("TLS_MODE='https'") ? 'https' : 'bootstrap' : 'https';
const save = (name, data) => {
  const content = Object.entries(data).map(([key, value]) => {
    if (/[\r\n]/.test(String(value))) throw new Error('Environment values must be single-line');
    // Compose accepts single quotes literally and does not interpolate $ inside them.
    return `${key}='${String(value).replaceAll("'", "\\'")}'`;
  }).join('\n') + '\n';
  writeFileSync(path.join(directory, name), content, { mode: 0o600 }); chmodSync(path.join(directory, name), 0o600);
};
save('.env', {
  API_IMAGE: lock.images.api.tag, WEB_IMAGE: lock.images.web.tag, POSTGRES_IMAGE: lock.images.postgres.tag, CERTBOT_IMAGE: lock.images.certbot.tag,
  PUBLIC_IP: ip, PUBLIC_ORIGIN: origin, WEB_BIND: production ? '0.0.0.0' : '127.0.0.1', HTTP_PORT: production ? 80 : 8080, HTTPS_PORT: production ? 443 : 8443, TLS_MODE: tlsMode,
});
save('postgres.env', { POSTGRES_USER: 'shop_agent', POSTGRES_DB: 'shop_showcase', POSTGRES_PASSWORD: password });
const api = {
  NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=320', API_HOST: '0.0.0.0', API_PORT: '3000', DATABASE_POOL_MAX: '5',
  DATABASE_URL: `postgresql://shop_agent:${encodeURIComponent(password)}@postgres:5432/shop_showcase`, APP_ORIGINS: origin,
  AGENT_MODE: 'deepseek', AGENT_CONCURRENCY: '1', COPILOT_CONCURRENCY: '1', AGENT_QUEUE_LIMIT: '4',
  SHOP_IMAGE_STORAGE: 'tos', NO_PROXY: 'localhost,127.0.0.1,::1,postgres,api,api.deepseek.com,tos-cn-shanghai.volces.com,agent-shop-demo.tos-cn-shanghai.volces.com',
};
for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'TOS_ACCESS_KEY', 'TOS_SECRET_KEY', 'TOS_SESSION_TOKEN', 'TOS_REGION', 'TOS_ENDPOINT', 'TOS_BUCKET']) {
  if (process.env[key]) api[key] = process.env[key];
}
for (const key of ['DEEPSEEK_API_KEY', 'TOS_ACCESS_KEY', 'TOS_SECRET_KEY']) if (!api[key]) throw new Error('Required backend credentials are missing');
save('api.env', api);
writeFileSync(path.join(directory, 'compose.yaml'), readFileSync(path.join(root, 'deploy/compose.yaml')), { mode: 0o600 });
console.log(JSON.stringify({ environment: production ? 'production' : 'local', origin, credentialsPrinted: false, inheritedProxyCopied: false }));

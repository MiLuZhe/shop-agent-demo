import https from 'node:https';

// Explicit empty proxy configuration: this request always connects directly,
// including when NODE_USE_ENV_PROXY or HTTP(S)_PROXY is enabled in the shell.
const agent = new https.Agent({ proxyEnv: {} });
try {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('DEEPSEEK_API_KEY is missing or malformed');
  const base = new URL(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
  if (base.origin !== 'https://api.deepseek.com' || !['/', '/v1', '/v1/'].includes(base.pathname)
    || base.username || base.password || base.search || base.hash) {
    throw new Error('This smoke test only permits the official https://api.deepseek.com endpoint');
  }
  const endpoint = new URL(`${base.pathname.replace(/\/$/, '')}/responses`, base.origin);
  const payload = JSON.stringify({
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    input: 'This is an API connectivity test. Reply with exactly: DEEPSEEK_OK',
    max_output_tokens: 128,
    stream: false,
  });
  console.log(`POST ${endpoint.href} (direct connection; proxy disabled)`);
  const result = await new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: 'POST', agent, signal: AbortSignal.timeout(45_000),
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1_048_576) { res.destroy(new Error('Response exceeds smoke-test size limit')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new Error(`HTTP ${res.statusCode}: response is not JSON`)); return; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
  console.log(`HTTP ${result.status}`);
  if (result.status !== 200) {
    // Do not print raw errors, requests, headers or credentials.
    throw new Error('DeepSeek rejected the request (check HTTP status, credentials, balance and model access)');
  }
  const { body } = result;
  const output = (body.output ?? []).filter(item => item.type === 'message')
    .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text')
    .map(part => part.text ?? '').join('');
  if (body.object !== 'response' || body.status !== 'completed' || output.trim() !== 'DEEPSEEK_OK') {
    throw new Error('Response did not complete with the expected Responses API output');
  }
  console.log(JSON.stringify({
    object: body.object, status: body.status, model: body.model, output,
    input_tokens: body.usage?.input_tokens, output_tokens: body.usage?.output_tokens,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'DeepSeek smoke test failed');
  process.exitCode = 1;
} finally {
  agent.destroy();
}

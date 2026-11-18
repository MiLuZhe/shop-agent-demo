export class ApiRequestError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error('网络连接失败，请检查服务是否运行后重试');
  }
  let body;
  try { body = await response.json(); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiRequestError('服务暂时无法响应，请稍后重试', response.status, 'INVALID_RESPONSE');
  }
  if (!response.ok) {
    if (response.status === 401 && body.error?.code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('shop:session-expired'));
    throw new ApiRequestError(body.error?.message ?? '请求失败，请稍后重试', response.status, body.error?.code ?? 'REQUEST_ERROR');
  }
  return body as T;
}

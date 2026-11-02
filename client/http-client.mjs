export class ApiError extends Error {
  constructor(status, body) {
    super(body?.detail ?? body?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function apiRequest(baseUrl, method, path, { body, idempotencyKey, fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
  const response = await fetchImpl(new URL(path, `${baseUrl.replace(/\/$/, '')}/`), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Server returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) throw new ApiError(response.status, result);
  return { data: result, status: response.status, replayed: response.headers.get('idempotency-replayed') === 'true' };
}

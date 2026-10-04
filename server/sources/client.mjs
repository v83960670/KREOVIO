const USER_AGENT = 'KreovioTrendEngine/0.2 (+https://github.com/v83960670/KREOVIO; trend-intelligence)';

export function classifyTransportError(error) {
  const code = error?.cause?.code || error?.code || error?.name || 'NETWORK';
  if (code === 'AbortError' || code === 'TimeoutError') return { status: 'UNAVAILABLE', code: 'TIMEOUT' };
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
    return { status: 'UNAVAILABLE', code: 'NETWORK_UNAVAILABLE' };
  }
  return { status: 'UNAVAILABLE', code: String(code).slice(0, 40) };
}

export async function requestText(url, { method = 'GET', headers = {}, body, timeoutMs = 12_000, auth } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, application/xml, text/xml, text/plain, */*',
        ...(auth ? { Authorization: auth } : {}),
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let status = 'CONNECTED';
    let code = null;
    if (response.status === 401 || response.status === 403) {
      status = 'AUTHENTICATION_ERROR';
      code = `HTTP_${response.status}`;
    } else if (response.status === 429) {
      status = 'RATE_LIMITED';
      code = 'HTTP_429';
    } else if (response.status >= 500) {
      status = 'UNAVAILABLE';
      code = `HTTP_${response.status}`;
    } else if (!response.ok) {
      status = 'DEGRADED';
      code = `HTTP_${response.status}`;
    }
    return { ok: response.ok && status === 'CONNECTED', status, code, httpStatus: response.status, text, latencyMs: Date.now() - started };
  } catch (error) {
    const classified = classifyTransportError(error);
    return { ok: false, status: classified.status, code: classified.code, httpStatus: 0, text: '', latencyMs: Date.now() - started };
  }
}

export function parseJson(text) {
  if (!text || !text.trim()) return { json: null, error: 'EMPTY' };
  try {
    return { json: JSON.parse(text), error: null };
  } catch {
    return { json: null, error: 'NOT_JSON' };
  }
}

let gdeltChain = Promise.resolve();

/** GDELT asks callers to stay at or below one request every 5 seconds. */
export function withGdeltSpacing(task) {
  const run = gdeltChain.then(async () => {
    const wait = Math.max(0, 5_500 - (Date.now() - gdeltLast));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    gdeltLast = Date.now();
    return task();
  });
  gdeltChain = run.then(() => {}, () => {});
  return run;
}

let gdeltLast = 0;

import { createServer } from 'node:http';
import { getPricing } from './pricing.mjs';

const PORT = Number(process.env.API_PORT ?? 8787);
const HOST = process.env.API_HOST ?? '0.0.0.0';
const searchRate = new Map();
const LIMIT = 10;
const WINDOW_MS = 60_000;
const MAX_BODY = 12_000;

const connectors = [
  { id: 'search-interest', name: 'Search interest', status: 'not-connected', note: 'Requires an authorized, licensed search-trend provider.' },
  { id: 'youtube', name: 'YouTube', status: 'not-connected', note: 'Official API adapter and API project access are not configured.' },
  { id: 'reddit', name: 'Reddit', status: 'not-connected', note: 'Approved OAuth access and applicable data terms are not configured.' },
  { id: 'news', name: 'News', status: 'not-connected', note: 'A licensed news-data provider is not configured.' },
];

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(JSON.stringify(body));
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function allowSearch(request, response) {
  const key = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = searchRate.get(key) ?? { start: now, count: 0 };
  if (now - current.start >= WINDOW_MS) {
    current.start = now;
    current.count = 0;
  }
  current.count += 1;
  searchRate.set(key, current);
  if (searchRate.size > 5_000) {
    for (const [entry, value] of searchRate) if (now - value.start > WINDOW_MS) searchRate.delete(entry);
  }
  if (current.count > LIMIT) {
    send(response, 429, { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.', charged: false });
    return false;
  }
  return true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) {
    send(response, 404, { code: 'NOT_FOUND' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    send(response, 200, { ok: true, mode: 'preview', timestamp: new Date().toISOString() });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/status') {
    send(response, 200, {
      mode: 'preview',
      liveSearchEnabled: false,
      connectors,
      message: 'This build has no authorized data-provider connections. Searches will not be charged.',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/pricing') {
    send(response, 200, getPricing(url.searchParams.get('currency') ?? 'INR'));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/search') {
    if (!allowSearch(request, response)) return;
    try {
      const body = await parseBody(request);
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query.length < 2 || query.length > 100) {
        send(response, 400, { code: 'INVALID_QUERY', message: 'Enter a topic between 2 and 100 characters.', charged: false });
        return;
      }
      // Do not fabricate a result, call an unapproved source, or reserve a credit in preview mode.
      send(response, 503, {
        code: 'CONNECTORS_NOT_CONFIGURED',
        message: 'Live source connections are not configured in this preview. Your search was not run and no credit was used.',
        charged: false,
        connectors,
      });
    } catch (error) {
      send(response, error.status ?? 400, {
        code: error.status === 413 ? 'REQUEST_TOO_LARGE' : 'INVALID_BODY',
        message: error.message ?? 'The request could not be read.',
        charged: false,
      });
    }
    return;
  }

  send(response, 404, { code: 'NOT_FOUND' });
});

server.listen(PORT, HOST, () => {
  console.log(`Kreovio preview API listening on http://${HOST}:${PORT}`);
});

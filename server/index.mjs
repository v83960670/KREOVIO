import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] != null) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
import { createServer } from 'node:http';
import { accountSummary, assertCsrf, clearSessionCookie, createSession, hashIp, loginUser, readSession, registerUser, revokeSession, sessionCookie, verifyEmail } from './auth.mjs';
import { releaseSearch } from './credit-ledger.mjs';
import { SOURCE_CATALOG } from './config.mjs';
import { createPool, migrate, releaseExpiredReservations } from './db.mjs';
import { logEvent } from './log.mjs';
import { getPricing } from './pricing.mjs';
import { executeSearch, getOwnedReport, refreshTrackedTopic } from './search-service.mjs';
import { healthCheckSource } from './sources/adapters.mjs';

const caPath = '/usr/local/share/ca-certificates/e2b-ca.crt';
if (existsSync(caPath) && !process.env.NODE_EXTRA_CA_CERTS) process.env.NODE_EXTRA_CA_CERTS = caPath;

const PORT = Number(process.env.API_PORT ?? 8787);
const HOST = process.env.API_HOST ?? '0.0.0.0';
const MAX_BODY = 20_000;
const buckets = new Map();
const ipSalt = process.env.AUTH_SECRET || randomUUID();

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

function send(response, status, body, extra = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders(extra) });
  response.end(JSON.stringify(body));
}

function cookieSecure(request) {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  const host = request.headers['x-forwarded-host'] || request.headers.host || '';
  return request.headers['x-forwarded-proto'] === 'https' || String(host).endsWith('.e2b.app');
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large.'), { status: 413, code: 'REQUEST_TOO_LARGE' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400, code: 'INVALID_BODY' })); }
    });
    request.on('error', reject);
  });
}

function allow(key, limit, windowMs = 60_000) {
  const now = Date.now();
  const current = buckets.get(key) ?? { start: now, count: 0 };
  if (now - current.start >= windowMs) {
    current.start = now;
    current.count = 0;
  }
  current.count += 1;
  buckets.set(key, current);
  if (buckets.size > 5_000) {
    for (const [entry, value] of buckets) if (now - value.start > windowMs) buckets.delete(entry);
  }
  return current.count <= limit;
}

function clientIp(request) {
  return request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';
}

function safeError(error) {
  return {
    code: error.code || 'REQUEST_FAILED',
    message: error.status && error.status < 500 ? error.message : 'The request could not be completed.',
    charged: false,
  };
}

function tokensMatch(provided, expected) {
  const left = Buffer.from(String(provided ?? ''));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

let pool = null;
let persistence = { kind: 'unavailable', error: null };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) {
    send(response, 404, { code: 'NOT_FOUND' });
    return;
  }
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      send(response, 200, { ok: true, mode: 'analysis', persistence: persistence.kind, timestamp: new Date().toISOString() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      const connectors = await Promise.all(SOURCE_CATALOG.map(async (source) => {
        const health = await healthCheckSource(source.id);
        let stored = null;
        if (pool) {
          const row = await pool.query(`SELECT status, live_status, last_success_at, last_attempt_at, latest_signal_at, latency_ms, limitation FROM source_freshness WHERE source_id = $1`, [source.id]);
          stored = row.rows[0] ?? null;
        }
        return {
          id: source.id,
          name: source.name,
          status: stored?.status ?? health.status,
          liveStatus: stored?.live_status ?? (health.status === 'NOT_CONFIGURED' ? 'NOT CONFIGURED' : 'UNAVAILABLE'),
          note: stored?.limitation || health.note,
          lastSuccessAt: stored?.last_success_at ?? null,
          lastAttemptAt: stored?.last_attempt_at ?? null,
          latestSignalAt: stored?.latest_signal_at ?? null,
          latencyMs: stored?.latency_ms ?? null,
        };
      }));
      const configured = connectors.filter((connector) => connector.status !== 'NOT_CONFIGURED').length;
      send(response, 200, {
        mode: 'analysis',
        liveSearchEnabled: configured > 0 && Boolean(pool),
        persistence: persistence.kind,
        connectors,
        message: pool
          ? 'Searches use configured sources only. Missing credentials and failed sources are reported. Failed searches are not charged.'
          : 'Account persistence is unavailable. Searches cannot reserve a credit, so they will not run.',
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/pricing') {
      send(response, 200, getPricing(url.searchParams.get('currency') ?? 'INR'));
      return;
    }
    if (!pool && url.pathname.startsWith('/api/auth')) {
      send(response, 503, { code: 'PERSISTENCE_UNAVAILABLE', message: 'Account storage is unavailable. No credit was used.', charged: false });
      return;
    }
    const session = pool ? await readSession(pool, request.headers.cookie ?? '') : null;

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      if (!session) { send(response, 200, { authenticated: false }); return; }
      const summary = await accountSummary(pool, session.userId);
      send(response, 200, {
        authenticated: true,
        email: session.email,
        emailVerified: session.emailVerified,
        csrf: session.csrf,
        verificationDelivery: process.env.SMTP_URL ? 'smtp-not-wired' : 'local-mailbox',
        ...summary,
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      if (!allow(`auth:${clientIp(request)}`, 8)) { send(response, 429, { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait.', charged: false }); return; }
      const body = await parseBody(request);
      const created = await registerUser(pool, { email: body.email, password: body.password, requestId: randomUUID() });
      const signed = await createSession(pool, { userId: created.userId, userAgent: request.headers['user-agent'] });
      logEvent('user_registered', { userId: created.userId, delivery: created.delivery });
      send(response, 201, {
        authenticated: true,
        email: created.email,
        emailVerified: false,
        csrf: signed.csrf,
        delivery: created.delivery,
        verificationToken: created.delivery === 'local-mailbox' ? created.verificationToken : undefined,
        message: created.delivery === 'local-mailbox'
          ? 'Email delivery is not configured. Use the verification token from this response to verify the account. The free search is granted only after verification.'
          : 'Account created. Email delivery is not wired, so verification cannot be completed by email yet.',
      }, { 'Set-Cookie': sessionCookie(signed.token, { secure: cookieSecure(request) }) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/verify') {
      const body = await parseBody(request);
      const result = await verifyEmail(pool, { token: body.token, requestId: randomUUID() });
      logEvent('email_verified', { userId: result.userId, granted: result.granted });
      send(response, 200, { verified: true, ...result, message: 'Email verified. One free Trend Search was granted if this account had not already received it.' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!allow(`auth:${clientIp(request)}`, 8)) { send(response, 429, { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait.', charged: false }); return; }
      const body = await parseBody(request);
      const user = await loginUser(pool, body);
      const signed = await createSession(pool, { userId: user.id, userAgent: request.headers['user-agent'] });
      const summary = await accountSummary(pool, user.id);
      send(response, 200, { authenticated: true, email: user.email, emailVerified: user.emailVerified, csrf: signed.csrf, ...summary }, { 'Set-Cookie': sessionCookie(signed.token, { secure: cookieSecure(request) }) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      await revokeSession(pool, request.headers.cookie ?? '');
      send(response, 200, { authenticated: false }, { 'Set-Cookie': clearSessionCookie(cookieSecure(request)) });
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
      if (!session) { send(response, 401, { code: 'AUTH_REQUIRED', message: 'Sign in to open a saved report.', charged: false }); return; }
      const searchId = url.pathname.split('/')[3];
      const report = await getOwnedReport(pool, { userId: session.userId, searchId });
      if (!report) { send(response, 404, { code: 'NOT_FOUND', message: 'That report was not found.', charged: false }); return; }
      send(response, 200, report);
      return;
    }
    if (url.pathname === '/api/saved' && request.method === 'GET') {
      if (!session) { send(response, 401, { code: 'AUTH_REQUIRED', message: 'Sign in to view saved trends.', charged: false }); return; }
      const saved = await pool.query(
        `SELECT s.episode_id, s.saved_at, s.score_at_save, s.lifecycle_at_save, t.canonical_name
           FROM saved_trends s JOIN trend_episodes e ON e.id = s.episode_id JOIN normalized_topics t ON t.id = e.topic_id
          WHERE s.user_id = $1 ORDER BY s.saved_at DESC`,
        [session.userId],
      );
      send(response, 200, { saved: saved.rows, charged: false });
      return;
    }
    if (url.pathname === '/api/saved' && request.method === 'POST') {
      if (!session) { send(response, 401, { code: 'AUTH_REQUIRED', charged: false, message: 'Sign in to save a trend.' }); return; }
      assertCsrf(session, request.headers['x-csrf-token'], request.headers.origin, request.headers.host, request.headers['x-forwarded-host']);
      const body = await parseBody(request);
      if (!/^[0-9a-f-]{36}$/i.test(String(body.episodeId ?? ''))) { send(response, 400, { code: 'INVALID_EPISODE', message: 'A stored episode is required.', charged: false }); return; }
      await pool.query(
        `INSERT INTO saved_trends (user_id, episode_id, score_at_save, lifecycle_at_save) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, episode_id) DO UPDATE SET saved_at = now()`,
        [session.userId, body.episodeId, Number.isInteger(body.score) ? body.score : null, body.lifecycle ?? null],
      );
      send(response, 200, { saved: true, charged: false });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/sources') {
      const expected = process.env.ADMIN_TOKEN;
      if (!expected) { send(response, 503, { code: 'ADMIN_NOT_CONFIGURED', message: 'Set ADMIN_TOKEN on the server before using admin routes.' }); return; }
      const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      if (!tokensMatch(provided, expected)) { send(response, 401, { code: 'ADMIN_UNAUTHORIZED', message: 'Admin token rejected.' }); return; }
      const health = await pool.query(`SELECT source_id, status, live_status, last_success_at, last_attempt_at, latest_signal_at, latency_ms, requests, estimated_cost_usd, limitation FROM source_freshness ORDER BY source_id`);
      const costs = await pool.query(`SELECT provider, count(*)::int AS searches, COALESCE(sum(total_estimated_cost_minor), 0)::int AS cost_minor, COALESCE(avg(processing_ms), 0)::int AS avg_ms FROM cost_logs GROUP BY provider`);
      send(response, 200, { sources: health.rows, costs: costs.rows, settingsNote: 'KTS weights and thresholds live in admin_settings. Changing them does not rewrite source code.' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/search') {
      if (!allow(`search:${clientIp(request)}`, 8)) { send(response, 429, { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.', charged: false }); return; }
      if (!pool) { send(response, 503, { code: 'PERSISTENCE_UNAVAILABLE', message: 'Search persistence is unavailable. Nothing was charged.', charged: false }); return; }
      if (!session) { send(response, 401, { code: 'AUTH_REQUIRED', message: 'Sign in with a verified account to run a Trend Search. Nothing was charged.', charged: false }); return; }
      assertCsrf(session, request.headers['x-csrf-token'], request.headers.origin, request.headers.host, request.headers['x-forwarded-host']);
      if (!session.emailVerified) { send(response, 403, { code: 'VERIFICATION_REQUIRED', message: 'Verify your email before using the free search. Nothing was charged.', charged: false }); return; }
      const body = await parseBody(request);
      const input = {
        query: typeof body.query === 'string' ? body.query.trim() : '',
        country: typeof body.country === 'string' ? body.country : 'WORLDWIDE',
        language: typeof body.language === 'string' ? body.language : 'en',
        source: typeof body.source === 'string' ? body.source : 'all',
        timeWindow: typeof body.timeWindow === 'string' ? body.timeWindow : '24h',
      };
      const wantsStream = (request.headers.accept ?? '').includes('text/event-stream');
      const requestId = randomUUID();
      const idempotencyKey = typeof request.headers['idempotency-key'] === 'string' && request.headers['idempotency-key'].length >= 12
        ? request.headers['idempotency-key'].slice(0, 160)
        : `search:${session.userId}:${requestId}`;
      logEvent('search_requested', { requestId, userId: session.userId, query: input.query, country: input.country, language: input.language, source: input.source, window: input.timeWindow, ipHash: hashIp(clientIp(request), ipSalt) });
      if (!wantsStream) {
        const report = await executeSearch(pool, { userId: session.userId, input, requestId, idempotencyKey });
        send(response, report.charged ? 200 : 200, report);
        return;
      }
      response.writeHead(200, securityHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }));
      const emit = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        const report = await executeSearch(pool, { userId: session.userId, input, requestId, idempotencyKey, onEvent: emit });
        emit('report', report);
      } catch (error) {
        emit('search_failed', { ...safeError(error), charged: false });
      }
      response.end();
      return;
    }

    send(response, 404, { code: 'NOT_FOUND' });
  } catch (error) {
    if (!response.headersSent) send(response, error.status ?? 500, safeError(error));
    else response.end();
  }
});

const ready = (async () => {
  try {
    pool = await createPool();
    const migrated = await migrate(pool);
    persistence = { kind: pool.kind, error: null };
    logEvent('database_ready', { kind: pool.kind, migration: migrated.applied });
  } catch (error) {
    persistence = { kind: 'unavailable', error: error.code || 'DATABASE_UNAVAILABLE' };
    logEvent('database_unavailable', { code: error.code || error.name });
  }
  server.listen(PORT, HOST, () => {
    logEvent('api_listening', { host: HOST, port: PORT, persistence: persistence.kind });
  });
  setInterval(() => {
    if (!pool) return;
    releaseExpiredReservations(pool, releaseSearch).catch((error) => logEvent('reservation_sweep_failed', { code: error.code }));
  }, 60_000).unref();
  setInterval(() => {
    if (!pool) return;
    refreshTrackedTopic(pool).catch((error) => logEvent('background_refresh_failed', { code: error.code }));
  }, 10 * 60_000).unref();
})();

server.on('error', (error) => logEvent('api_error', { code: error.code }));
await ready;

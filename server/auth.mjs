import { deliverVerification } from './runtime.mjs';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { grantFirstFreeSearch } from './credit-ledger.mjs';

const scryptAsync = promisify(scrypt);
const SESSION_COOKIE = 'kreovio_session';
const SESSION_DAYS = 14;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function hashIp(ip, salt) {
  return sha256(`${salt}:${ip ?? 'unknown'}`).slice(0, 32);
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 32)).toString('hex');
  return { hash, salt, params: { n: 16384, r: 8, p: 1, keylen: 32 } };
}

export async function verifyPassword(password, hash, salt) {
  const actual = Buffer.from(hash, 'hex');
  const expected = await scryptAsync(password, salt, actual.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function sessionCookie(token, { secure = false, maxAge = SESSION_DAYS * 24 * 60 * 60 } = {}) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure = false) {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function registerUser(pool, { email, password, requestId }) {
  if (!validEmail(email)) throw fail('INVALID_EMAIL', 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    throw fail('WEAK_PASSWORD', 'Use a password of at least 10 characters.');
  }
  const normalized = email.trim().toLowerCase();
  const existing = await pool.query(`SELECT id, email_verified_at FROM users WHERE email = $1`, [normalized]);
  if (existing.rowCount) throw fail('EMAIL_IN_USE', 'An account with that email already exists.', 409);
  const userId = randomUUID();
  const credentials = await hashPassword(password);
  const token = randomBytes(32).toString('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, auth_subject, email, status) VALUES ($1, $2, $3, 'active')`,
      [userId, `local:${userId}`, normalized],
    );
    await client.query(
      `INSERT INTO profiles (user_id) VALUES ($1)`,
      [userId],
    );
    await client.query(
      `INSERT INTO user_credentials (user_id, password_hash, password_salt, password_params) VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, credentials.hash, credentials.salt, JSON.stringify(credentials.params)],
    );
    await client.query(
      `INSERT INTO user_preferences (user_id) VALUES ($1)`,
      [userId],
    );
    await client.query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '24 hours')`,
      [userId, sha256(token)],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original */ }
    throw error;
  } finally {
    client.release();
  }
  const delivery = await deliverVerification(normalized,token).catch(() => 'delivery-failed');
  return {
    userId,
    email: normalized,
    verificationToken: token,
    delivery,
    requestId,
  };
}

export async function verifyEmail(pool, { token, requestId }) {
  if (typeof token !== 'string' || token.length < 32) throw fail('INVALID_TOKEN', 'This verification link is not valid.');
  const found = await pool.query(
    `SELECT id, user_id, expires_at, used_at FROM email_verifications WHERE token_hash = $1`,
    [sha256(token)],
  );
  const row = found.rows[0];
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) throw fail('INVALID_TOKEN', 'This verification link is not valid or has expired.');
  await pool.query(`UPDATE email_verifications SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [row.id]);
  await pool.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`, [row.user_id]);
  const grant = await grantFirstFreeSearch(pool, { userId: row.user_id, requestId });
  return { userId: row.user_id, ...grant };
}

export async function loginUser(pool, { email, password }) {
  if (!validEmail(email) || typeof password !== 'string') throw fail('INVALID_LOGIN', 'Email or password is incorrect.', 401);
  const found = await pool.query(
    `SELECT u.id, u.email, u.email_verified_at, u.status, c.password_hash, c.password_salt
       FROM users u JOIN user_credentials c ON c.user_id = u.id
      WHERE u.email = $1`,
    [email.trim().toLowerCase()],
  );
  const user = found.rows[0];
  if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash, user.password_salt))) {
    throw fail('INVALID_LOGIN', 'Email or password is incorrect.', 401);
  }
  return { id: user.id, email: user.email, emailVerified: Boolean(user.email_verified_at) };
}

export async function createSession(pool, { userId, userAgent }) {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, csrf_secret, expires_at, user_agent_hash)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 day'), $5)`,
    [userId, sha256(token), csrf, SESSION_DAYS, userAgent ? sha256(userAgent).slice(0, 24) : null],
  );
  return { token, csrf };
}

export async function readSession(pool, cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const found = await pool.query(
    `SELECT s.user_id, s.csrf_secret, s.expires_at, u.email, u.email_verified_at, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  const row = found.rows[0];
  if (!row || row.status !== 'active') return null;
  return { userId: row.user_id, email: row.email, emailVerified: Boolean(row.email_verified_at), csrf: row.csrf_secret };
}

export async function revokeSession(pool, cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return;
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
}

export async function accountSummary(pool, userId) {
  const balance = await pool.query(
    `SELECT COALESCE(sum(credit_delta), 0)::int AS available FROM usage_ledger WHERE user_id = $1 AND status = 'succeeded'`,
    [userId],
  );
  const plan = await pool.query(
    `SELECT pl.id, pl.name, pl.is_unlimited
       FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
      WHERE s.user_id = $1 AND s.status = 'active' AND (s.period_ends_at IS NULL OR s.period_ends_at > now())
      ORDER BY s.created_at DESC LIMIT 1`,
    [userId],
  );
  return {
    creditsAvailable: balance.rows[0]?.available ?? 0,
    plan: plan.rows[0] ?? { id: 'free', name: 'Free', is_unlimited: false },
  };
}

export function assertCsrf(session, headerToken, origin, host, forwardedHost) {
  if (!session) throw fail('AUTH_REQUIRED', 'Sign in to run a Trend Search.', 401);
  if (!headerToken || headerToken !== session.csrf) throw fail('CSRF_FAILED', 'The request could not be verified. Refresh and try again.', 403);
  if (!origin) return;
  let originHost = '';
  try { originHost = new URL(origin).host; } catch { throw fail('CSRF_FAILED', 'The request origin was rejected.', 403); }
  const allowed = originHost === host
    || originHost === forwardedHost
    || originHost.startsWith('localhost:')
    || originHost.startsWith('127.0.0.1:')
    || originHost.endsWith('.e2b.app')
    || (process.env.APP_ORIGIN && origin === process.env.APP_ORIGIN);
  if (!allowed) throw fail('CSRF_FAILED', 'The request origin was rejected.', 403);
}

export async function resendVerification(pool,userId) {
  const user=await pool.query(`SELECT email,email_verified_at FROM users WHERE id=$1`,[userId]);
  if (!user.rows[0] || user.rows[0].email_verified_at) return {delivery:'not-needed'};
  const token=randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO email_verifications(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours')`,[userId,sha256(token)]);
  const delivery=await deliverVerification(user.rows[0].email,token).catch(()=>'delivery-failed');
  return {delivery,verificationToken:delivery==='local-mailbox' ? token : undefined};
}

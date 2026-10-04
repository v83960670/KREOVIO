const FALLBACK_UNLIMITED_CONCURRENCY = 2;
const RESERVATION_TTL_SECONDS = 5 * 60;

function assertUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ''))) {
    throw Object.assign(new Error(`${label} must be a UUID.`), { code: 'INVALID_INPUT' });
  }
}

function safeError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Grant the verified account's single free search. The unique key makes retries safe. */
export async function grantFirstFreeSearch(pool, { userId, requestId }) {
  assertUuid(userId, 'userId');
  assertUuid(requestId, 'requestId');
  return withTransaction(pool, async (client) => {
    const user = await client.query(
      `SELECT id FROM users WHERE id = $1 AND status = 'active' AND email_verified_at IS NOT NULL FOR UPDATE`,
      [userId],
    );
    if (!user.rowCount) throw safeError('VERIFIED_ACCOUNT_REQUIRED', 'A verified active account is required.');

    const result = await client.query(
      `INSERT INTO usage_ledger
         (user_id, plan_id, credits_reserved, credits_consumed, transaction_type, status, request_id, idempotency_key, credit_delta, metadata)
       VALUES ($1, 'free', 0, 0, 'grant', 'succeeded', $2, $3, 1, $4::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [userId, requestId, `free-once:${userId}`, JSON.stringify({ allowance: 'one-time-verified-user' })],
    );
    return { granted: result.rowCount === 1, alreadyGranted: result.rowCount === 0 };
  });
}

/** Grant Basic/Pro search packs only after the provider payment has been verified server-side. */
export async function grantPurchasedSearches(pool, { paymentId, requestId }) {
  assertUuid(paymentId, 'paymentId');
  assertUuid(requestId, 'requestId');
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT p.id AS payment_id, p.user_id, p.plan_id, p.provider, p.provider_payment_id,
              p.status, p.verified_at, pl.search_allowance, pl.is_unlimited
         FROM payments p
         JOIN plans pl ON pl.id = p.plan_id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [paymentId],
    );
    const payment = result.rows[0];
    if (!payment || payment.status !== 'succeeded' || !payment.verified_at) {
      throw safeError('PAYMENT_NOT_VERIFIED', 'A succeeded, server-verified payment is required.');
    }
    if (payment.is_unlimited || !Number.isInteger(payment.search_allowance) || payment.search_allowance <= 0) {
      throw safeError('PACK_NOT_CREDIT_BASED', 'This plan does not issue a finite search pack.');
    }

    const idempotencyKey = `payment:${payment.provider}:${payment.provider_payment_id}:search-pack`;
    const inserted = await client.query(
      `INSERT INTO usage_ledger
         (user_id, plan_id, credits_reserved, credits_consumed, transaction_type, status, request_id, idempotency_key, credit_delta, metadata)
       VALUES ($1, $2, 0, 0, 'grant', 'succeeded', $3, $4, $5, $6::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [payment.user_id, payment.plan_id, requestId, idempotencyKey, payment.search_allowance, JSON.stringify({ paymentId: payment.payment_id, provider: payment.provider })],
    );
    return { granted: inserted.rowCount === 1, alreadyGranted: inserted.rowCount === 0, credits: payment.search_allowance };
  });
}

/**
 * Atomically create a search and reserve its allowance before any costly source work.
 * The caller must authenticate the user and validate requested source/window coverage.
 * Uses pg Pool/Client semantics. The balance is the append-only sum of ledger deltas.
 */
export async function reserveSearch(pool, {
  userId,
  requestId,
  idempotencyKey,
  query,
  countryCode = 'WORLDWIDE',
  languageCode = 'en',
  sourceFilter = 'all',
  timeWindow = '24h',
  ttlSeconds = RESERVATION_TTL_SECONDS,
}) {
  assertUuid(userId, 'userId');
  assertUuid(requestId, 'requestId');
  if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 100) {
    throw safeError('INVALID_QUERY', 'Enter a topic between 2 and 100 characters.');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 12 || idempotencyKey.length > 160) {
    throw safeError('INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
  }
  if (!['6h', '24h', '3d', '7d', '30d', '90d'].includes(timeWindow)) {
    throw safeError('INVALID_TIME_WINDOW', 'The requested time window is not supported.');
  }
  if (typeof countryCode !== 'string' || (!/^([A-Za-z]{2}|WORLDWIDE)$/.test(countryCode))) {
    throw safeError('INVALID_COUNTRY', 'Choose a supported country or Worldwide.');
  }
  if (typeof languageCode !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(languageCode)) {
    throw safeError('INVALID_LANGUAGE', 'Choose a supported language.');
  }
  if (!['all', 'search', 'youtube', 'reddit', 'news', 'wikipedia', 'hackernews'].includes(sourceFilter)) {
    throw safeError('INVALID_SOURCE_FILTER', 'The requested source filter is not supported.');
  }

  return withTransaction(pool, async (client) => {
    // Serialize reservations per account. Row locks plus a transaction-scoped advisory lock
    // prevent parallel requests from spending the same last search credit.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
    const existing = await client.query(
      `SELECT r.id AS reservation_id, r.search_id, r.status, r.credits_reserved, r.credits_consumed, s.status AS search_status
         FROM usage_reservations r JOIN trend_searches s ON s.id = r.search_id
        WHERE r.idempotency_key = $1 FOR UPDATE OF r`,
      [idempotencyKey],
    );
    if (existing.rowCount) return { ...existing.rows[0], idempotentReplay: true };

    const userResult = await client.query(
      `SELECT id FROM users WHERE id = $1 AND status = 'active' AND email_verified_at IS NOT NULL FOR UPDATE`,
      [userId],
    );
    if (!userResult.rowCount) throw safeError('VERIFIED_ACCOUNT_REQUIRED', 'A verified active account is required.');

    const activeSubscription = await client.query(
      `SELECT pl.id, pl.search_allowance, pl.is_unlimited, pl.fair_use_rules
         FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE s.user_id = $1 AND s.status = 'active'
          AND (s.period_ends_at IS NULL OR s.period_ends_at > now())
        ORDER BY s.created_at DESC LIMIT 1 FOR SHARE OF s, pl`,
      [userId],
    );
    const planResult = activeSubscription.rowCount
      ? activeSubscription
      : await client.query(`SELECT id, search_allowance, is_unlimited, fair_use_rules FROM plans WHERE id = 'free' AND active = true FOR SHARE`);
    const plan = planResult.rows[0];
    if (!plan) throw safeError('PLAN_UNAVAILABLE', 'No active search plan is available for this account.');

    const reservedCredits = plan.is_unlimited ? 0 : 1;
    if (plan.is_unlimited) {
      const fairUse = typeof plan.fair_use_rules === 'string' ? JSON.parse(plan.fair_use_rules) : (plan.fair_use_rules ?? {});
      const maxConcurrent = Math.max(1, Math.min(20, Number(fairUse.max_concurrent ?? FALLBACK_UNLIMITED_CONCURRENCY)));
      const activeCount = await client.query(
        `SELECT count(*)::int AS count FROM usage_reservations
          WHERE user_id = $1 AND status = 'reserved' AND expires_at > now()`,
        [userId],
      );
      if (activeCount.rows[0].count >= maxConcurrent) {
        throw safeError('CONCURRENCY_LIMIT', 'Your account has reached its concurrent analysis limit. Try again when a search finishes.');
      }
    } else {
      const balance = await client.query(
        `SELECT COALESCE(sum(credit_delta), 0)::int AS available
           FROM usage_ledger WHERE user_id = $1 AND status = 'succeeded'`,
        [userId],
      );
      if (balance.rows[0].available < 1) throw safeError('NO_SEARCH_CREDITS', 'No Trend Searches remain on this account.');
    }

    const search = await client.query(
      `INSERT INTO trend_searches
         (user_id, request_id, query, country_code, language_code, source_filter, time_window, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
       RETURNING id`,
      [userId, requestId, query.trim(), countryCode, languageCode, sourceFilter, timeWindow],
    );
    const searchId = search.rows[0].id;
    const expiresIn = Math.max(30, Math.min(1800, Number(ttlSeconds) || RESERVATION_TTL_SECONDS));
    const reservation = await client.query(
      `INSERT INTO usage_reservations
         (user_id, search_id, plan_id, credits_reserved, credits_consumed, status, expires_at, request_id, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, 0, 'reserved', now() + ($5 * interval '1 second'), $6, $7, $8::jsonb)
       RETURNING id, search_id, status, credits_reserved, credits_consumed`,
      [userId, searchId, plan.id, reservedCredits, expiresIn, requestId, idempotencyKey, JSON.stringify({ plan: plan.id, unlimited: plan.is_unlimited })],
    );
    await client.query(
      `INSERT INTO usage_ledger
         (user_id, search_id, reservation_id, plan_id, credits_reserved, credits_consumed, transaction_type, status, request_id, idempotency_key, credit_delta, metadata)
       VALUES ($1, $2, $3, $4, $5, 0, 'reserve', 'succeeded', $6, $7, $8, $9::jsonb)`,
      [userId, searchId, reservation.rows[0].id, plan.id, reservedCredits, requestId, `reserve:${idempotencyKey}`, -reservedCredits, JSON.stringify({ unlimited: plan.is_unlimited })],
    );
    return { ...reservation.rows[0], planId: plan.id, idempotentReplay: false };
  });
}

/** Commit only after a complete successful analysis and result persistence. */
export async function commitSearch(pool, { reservationId, requestId }) {
  assertUuid(reservationId, 'reservationId');
  assertUuid(requestId, 'requestId');
  return withTransaction(pool, async (client) => {
    const found = await client.query(
      `SELECT r.*, s.status AS search_status FROM usage_reservations r
         JOIN trend_searches s ON s.id = r.search_id
        WHERE r.id = $1 FOR UPDATE OF r, s`,
      [reservationId],
    );
    const reservation = found.rows[0];
    if (!reservation) throw safeError('RESERVATION_NOT_FOUND', 'The search reservation was not found.');
    if (reservation.status === 'committed') return { committed: true, idempotentReplay: true, searchId: reservation.search_id };
    if (reservation.status !== 'reserved') throw safeError('RESERVATION_NOT_OPEN', 'This search reservation is no longer open.');
    if (reservation.expires_at && new Date(reservation.expires_at) < new Date()) throw safeError('RESERVATION_EXPIRED', 'This search reservation has expired.');

    await client.query(
      `UPDATE usage_reservations SET status = 'committed', credits_consumed = credits_reserved, finalized_at = now()
        WHERE id = $1`,
      [reservationId],
    );
    await client.query(
      `INSERT INTO usage_ledger
         (user_id, search_id, reservation_id, plan_id, credits_reserved, credits_consumed, transaction_type, status, request_id, idempotency_key, credit_delta, metadata)
       VALUES ($1, $2, $3, $4, $5, $5, 'consume', 'succeeded', $6, $7, 0, '{}'::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [reservation.user_id, reservation.search_id, reservationId, reservation.plan_id, reservation.credits_reserved, requestId, `consume:${reservation.idempotency_key}`],
    );
    await client.query(
      `UPDATE trend_searches SET status = 'succeeded', completed_at = now() WHERE id = $1`,
      [reservation.search_id],
    );
    return { committed: true, idempotentReplay: false, searchId: reservation.search_id };
  });
}

/** Release a held credit when collection, normalization or scoring fails. Safe to retry. */
export async function releaseSearch(pool, { reservationId, requestId, failureCode = 'ANALYSIS_FAILED', safeMessage = 'The analysis did not complete.' }) {
  assertUuid(reservationId, 'reservationId');
  assertUuid(requestId, 'requestId');
  return withTransaction(pool, async (client) => {
    const found = await client.query(
      `SELECT r.*, s.status AS search_status FROM usage_reservations r
         JOIN trend_searches s ON s.id = r.search_id
        WHERE r.id = $1 FOR UPDATE OF r, s`,
      [reservationId],
    );
    const reservation = found.rows[0];
    if (!reservation) throw safeError('RESERVATION_NOT_FOUND', 'The search reservation was not found.');
    if (reservation.status === 'released' || reservation.status === 'expired') {
      return { released: true, idempotentReplay: true, searchId: reservation.search_id };
    }
    if (reservation.status === 'committed') throw safeError('RESERVATION_ALREADY_COMMITTED', 'A completed search cannot be released.');
    if (reservation.status !== 'reserved') throw safeError('RESERVATION_NOT_OPEN', 'This search reservation is no longer open.');

    await client.query(
      `UPDATE usage_reservations SET status = 'released', credits_consumed = 0, finalized_at = now() WHERE id = $1`,
      [reservationId],
    );
    await client.query(
      `INSERT INTO usage_ledger
         (user_id, search_id, reservation_id, plan_id, credits_reserved, credits_consumed, transaction_type, status, request_id, idempotency_key, credit_delta, metadata)
       VALUES ($1, $2, $3, $4, $5, 0, 'release', 'succeeded', $6, $7, $5, $8::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [reservation.user_id, reservation.search_id, reservationId, reservation.plan_id, reservation.credits_reserved, requestId, `release:${reservation.idempotency_key}`, JSON.stringify({ failureCode })],
    );
    await client.query(
      `UPDATE trend_searches SET status = 'failed', failure_code = $2, failure_message_safe = $3, completed_at = now() WHERE id = $1`,
      [reservation.search_id, String(failureCode).slice(0, 80), String(safeMessage).slice(0, 240)],
    );
    return { released: true, idempotentReplay: false, searchId: reservation.search_id };
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { commitSearch, grantFirstFreeSearch, releaseSearch, reserveSearch } from './credit-ledger.mjs';
import { createPool, migrate } from './db.mjs';

async function verifiedUser(pool) {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, auth_subject, email, email_verified_at) VALUES ($1, $2, $3, now())`,
    [userId, `local:${userId}`, `${userId}@example.test`],
  );
  await grantFirstFreeSearch(pool, { userId, requestId: randomUUID() });
  return userId;
}

test('failed analysis releases the reserved credit and a completed analysis commits one', async () => {
  const pool = await createPool({ memory: true });
  await migrate(pool);
  const userId = await verifiedUser(pool);
  const failed = await reserveSearch(pool, {
    userId,
    requestId: randomUUID(),
    idempotencyKey: `idem-${randomUUID()}`,
    query: 'Artificial Intelligence',
    countryCode: 'IN',
    languageCode: 'en',
    sourceFilter: 'all',
    timeWindow: '24h',
  });
  await releaseSearch(pool, { reservationId: failed.id, requestId: randomUUID(), failureCode: 'INSUFFICIENT_EVIDENCE', safeMessage: 'Not enough evidence.' });
  const afterFailure = await pool.query(`SELECT COALESCE(sum(credit_delta), 0)::int AS available FROM usage_ledger WHERE user_id = $1 AND status = 'succeeded'`, [userId]);
  assert.equal(afterFailure.rows[0].available, 1);

  const succeeded = await reserveSearch(pool, {
    userId,
    requestId: randomUUID(),
    idempotencyKey: `idem-${randomUUID()}`,
    query: 'Artificial Intelligence',
    countryCode: 'IN',
    languageCode: 'en',
    sourceFilter: 'all',
    timeWindow: '24h',
  });
  await commitSearch(pool, { reservationId: succeeded.id, requestId: randomUUID() });
  const afterCommit = await pool.query(`SELECT COALESCE(sum(credit_delta), 0)::int AS available FROM usage_ledger WHERE user_id = $1 AND status = 'succeeded'`, [userId]);
  assert.equal(afterCommit.rows[0].available, 0);
  await pool.end();
});

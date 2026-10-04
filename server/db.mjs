import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSql = readFileSync(join(root, 'db/schema.sql'), 'utf8');
const migrationSql = readFileSync(join(root, 'db/migrations/002_auth_and_cache.sql'), 'utf8');

function normalize(result) {
  return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
}

export function wrapPglite(db) {
  let locked = Promise.resolve();
  return {
    kind: 'pglite',
    async connect() {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const previous = locked;
      locked = gate;
      await previous;
      return {
        async query(text, params) {
          return normalize(await db.query(text, params));
        },
        release() { release(); },
      };
    },
    async query(text, params) {
      const client = await this.connect();
      try { return await client.query(text, params); } finally { client.release(); }
    },
    async exec(text) { await db.exec(text); },
    async end() { await db.close(); },
  };
}

export async function createPool({ databaseUrl = process.env.DATABASE_URL, dataDir = process.env.PGLITE_DATA_DIR || '.data/pglite', memory = false } = {}) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 10_000 });
    return {
      kind: 'postgres',
      pool,
      async connect() { return pool.connect(); },
      query: (text, params) => pool.query(text, params),
      async exec(text) {
        const client = await pool.connect();
        try { await client.query(text); } finally { client.release(); }
      },
      async end() { await pool.end(); },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  if (!memory) mkdirSync(dataDir, { recursive: true });
  const db = new PGlite(memory ? { extensions: { pgcrypto, citext } } : { dataDir, extensions: { pgcrypto, citext } });
  await db.waitReady;
  return wrapPglite(db);
}

export async function migrate(pool) {
  const users = await pool.query(`SELECT to_regclass('public.users') AS name`);
  if (!users.rows[0]?.name) {
    if (typeof pool.exec === 'function') await pool.exec(schemaSql);
    else await pool.query(schemaSql);
    return { applied: 'schema.sql' };
  }
  const sessions = await pool.query(`SELECT to_regclass('public.sessions') AS name`);
  if (!sessions.rows[0]?.name) {
    if (typeof pool.exec === 'function') await pool.exec(migrationSql);
    else await pool.query(migrationSql);
    return { applied: '002_auth_and_cache.sql' };
  }
  return { applied: null };
}

export async function releaseExpiredReservations(pool, releaseSearch) {
  const expired = await pool.query(
    `SELECT id FROM usage_reservations WHERE status = 'reserved' AND expires_at <= now() LIMIT 20`,
  );
  let released = 0;
  for (const row of expired.rows) {
    try {
      await releaseSearch(pool, {
        reservationId: row.id,
        requestId: randomUUID(),
        failureCode: 'RESERVATION_EXPIRED',
        safeMessage: 'The analysis did not finish before the reservation expired. The credit was released.',
      });
      released += 1;
    } catch { /* Another worker may have finalized it. */ }
  }
  return released;
}

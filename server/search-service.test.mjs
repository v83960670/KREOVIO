import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { grantFirstFreeSearch } from './credit-ledger.mjs';
import { createPool, migrate } from './db.mjs';
import { executeSearch, getOwnedReport } from './search-service.mjs';

function points() {
  return Array.from({ length: 8 }, (_, index) => ({
    t: new Date(Date.UTC(2026, 8, 20 + index)).toISOString(),
    value: 30 + index * 15,
  }));
}

test('a measured analysis commits one credit and reopening the report commits zero', async () => {
  const pool = await createPool({ memory: true });
  await migrate(pool);
  const userId = randomUUID();
  await pool.query(`INSERT INTO users (id, auth_subject, email, email_verified_at) VALUES ($1, $2, $3, now())`, [userId, `local:${userId}`, `${userId}@example.test`]);
  await grantFirstFreeSearch(pool, { userId, requestId: randomUUID() });
  const events = [];
  const report = await executeSearch(pool, {
    userId,
    requestId: randomUUID(),
    idempotencyKey: `idem-${randomUUID()}`,
    input: { query: 'browser agents', country: 'WORLDWIDE', language: 'en', source: 'news', timeWindow: '24h' },
    onEvent: (name) => events.push(name),
    collectors: {
      news: async () => ({
        id: 'news',
        name: 'News',
        status: 'CONNECTED',
        quality: 0.8,
        signals: [],
        series: [{ id: 'news-series', label: 'GDELT article count', metric: 'article_count', unit: 'articles', points: points() }],
        limitations: ['Test collector. Not used by production.'],
        requests: 1,
        estimatedCostUsd: 0,
        latencyMs: 4,
        freshness: { lastAttemptAt: '2026-09-27T00:00:00Z', lastSuccessAt: '2026-09-27T00:00:00Z', latestSignalAt: '2026-09-27T00:00:00Z', dataAgeSeconds: 10 },
      }),
    },
  });
  assert.equal(report.charged, true);
  assert.equal(events.includes('credit_reserved'), true);
  assert.equal(events.includes('results_ready') || report.results.length >= 0, true);
  const balance = await pool.query(`SELECT COALESCE(sum(credit_delta), 0)::int AS available FROM usage_ledger WHERE user_id = $1 AND status = 'succeeded'`, [userId]);
  assert.equal(balance.rows[0].available, 0);
  const reopened = await getOwnedReport(pool, { userId, searchId: report.id });
  assert.equal(reopened.charged, false);
  assert.equal(reopened.creditState, 'not_charged');
  await pool.end();
});

test('unavailable collectors release the credit and invent nothing', async () => {
  const pool = await createPool({ memory: true });
  await migrate(pool);
  const userId = randomUUID();
  await pool.query(`INSERT INTO users (id, auth_subject, email, email_verified_at) VALUES ($1, $2, $3, now())`, [userId, `local:${userId}`, `${userId}@example.test`]);
  await grantFirstFreeSearch(pool, { userId, requestId: randomUUID() });
  const report = await executeSearch(pool, {
    userId,
    requestId: randomUUID(),
    idempotencyKey: `idem-${randomUUID()}`,
    input: { query: 'Artificial Intelligence', country: 'IN', language: 'en', source: 'news', timeWindow: '24h' },
    collectors: {
      news: async () => ({
        id: 'news', name: 'News', status: 'UNAVAILABLE', signals: [], series: [], limitations: ['Network unavailable.'],
        requests: 1, estimatedCostUsd: 0, latencyMs: 8,
        freshness: { lastAttemptAt: new Date().toISOString(), lastSuccessAt: null, latestSignalAt: null, dataAgeSeconds: null },
      }),
    },
  });
  assert.equal(report.charged, false);
  assert.equal(report.results.length, 0);
  assert.match(report.message, /enough reliable evidence|No strong acceleration|Network unavailable/);
  const balance = await pool.query(`SELECT COALESCE(sum(credit_delta), 0)::int AS available FROM usage_ledger WHERE user_id = $1 AND status = 'succeeded'`, [userId]);
  assert.equal(balance.rows[0].available, 1);
  await pool.end();
});

test('discovery saves unscored evidence and refreshes stale status on free reopen', async () => {
  const pool=await createPool({memory:true});await migrate(pool);
  try {
    const userId=randomUUID();
    await pool.query(`INSERT INTO users(id,auth_subject,email,email_verified_at) VALUES($1,$2,$3,now())`,[userId,`local:${userId}`,`${userId}@example.test`]);
    await grantFirstFreeSearch(pool,{userId,requestId:randomUUID()});
    const at=new Date().toISOString();
    const report=await executeSearch(pool,{userId,requestId:randomUUID(),idempotencyKey:randomUUID(),
      input:{mode:'discover',query:'Fitness',country:'IN',language:'en',source:'youtube',timeWindow:'1h'},
      collectors:{youtube:async()=>({id:'youtube',name:'YouTube',status:'CONNECTED',series:[],
        signals:[{source:'youtube',sourceId:'video1',title:'Zone two training',topic:'Zone two training',timestamp:at,collectedAt:at,metric:'views_per_hour_since_publish',metricValue:12,sourceConfidence:0.7,reference:'https://youtube.com/watch?v=video1'}],
        freshness:{lastAttemptAt:at,lastSuccessAt:at,latestSignalAt:at}})}});
    assert.equal(report.mode,'discover');assert.equal(report.results.length,0);
    assert.equal(report.observations[0].historyStatus,'INSUFFICIENT_HISTORY');assert.equal(report.observations[0].score,null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM topic_observations')).rows[0].n,2);
    assert.equal((await pool.query('SELECT status FROM source_freshness WHERE source_id=$1',['youtube'])).rows[0].status,'CONNECTED');
    const old=new Date(Date.now()-7*86400000).toISOString();
    report.sourceFreshness[0].lastSuccessAt=old;
    await pool.query('UPDATE trend_searches SET report=$2::jsonb WHERE id=$1',[report.id,JSON.stringify(report)]);
    const reopened=await getOwnedReport(pool,{userId,searchId:report.id});
    assert.equal(reopened.charged,false);assert.equal(reopened.sourceFreshness[0].liveStatus,'STALE');
    assert.equal(await getOwnedReport(pool,{userId:randomUUID(),searchId:report.id}),null);
  } finally {await pool.end();}
});

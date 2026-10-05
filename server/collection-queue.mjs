import { createHash, randomUUID } from 'node:crypto';
import { WINDOW_MS } from './config.mjs';
import { normalizeTopic } from './trend-engine.mjs';

export async function trackTopic(pool, input, reason = 'recent', priority = 30) {
  const id = createHash('sha256').update(JSON.stringify([normalizeTopic(input.query), input.country,input.language,input.source,input.timeWindow,input.mode ?? 'analyze'])).digest('hex');
  const activeDays = reason === 'saved' ? 36500 : Math.max(7,Math.ceil(5 * WINDOW_MS[input.timeWindow] / 86400000));
  await pool.query(`INSERT INTO tracked_topics(id,query,country,language,source,time_window,mode,priority,reason,active_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+($10*interval '1 day')) ON CONFLICT(id) DO UPDATE SET
    priority=GREATEST(tracked_topics.priority,EXCLUDED.priority), reason=EXCLUDED.reason,
    last_requested_at=now(), active_until=GREATEST(tracked_topics.active_until,EXCLUDED.active_until)`,
  [id,input.query,input.country,input.language,input.source,input.timeWindow,input.mode ?? 'analyze',priority,reason,activeDays]);
  return id;
}

// Queue contract: claim() -> leased job, finish(job,error). SQL claims support multiple workers.
export function createCollectionQueue(pool) {
  return {
    async claim() {
      const token = randomUUID();
      const found = await pool.query(`UPDATE tracked_topics SET lease_until=now()+interval '5 minutes',lease_token=$1
        WHERE id=(SELECT id FROM tracked_topics WHERE next_run_at<=now() AND active_until>now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY priority DESC,next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [token]);
      const row = found.rows[0];
      return row ? {id:row.id,token,input:{query:row.query,country:row.country,language:row.language,source:row.source,timeWindow:row.time_window,mode:row.mode}} : null;
    },
    async finish(job, error = null) {
      await pool.query(`UPDATE tracked_topics SET lease_until=NULL,lease_token=NULL,
        failures=CASE WHEN $3::text IS NULL THEN 0 ELSE failures+1 END,last_error=$3,
        next_run_at=now()+ LEAST(1440, CASE WHEN $3::text IS NULL THEN 60 ELSE 60 * power(2, LEAST(failures,4)) END) * interval '1 minute'
        WHERE id=$1 AND lease_token=$2`, [job.id,job.token,error]);
    },
  };
}

// Reserve a conservative maximum BEFORE network calls. Failures still cost quota.
const MAX_CALLS = {youtube:2,reddit:2,search:4,news:2,wikipedia:5,hackernews:1};
export async function reserveProviderBudget(pool, sourceId) {
  const limit = Number(process.env[`PROVIDER_DAILY_CALLS_${sourceId.toUpperCase()}`] ?? (sourceId === 'search' ? 40 : sourceId === 'youtube' ? 198 : 200));
  const calls = MAX_CALLS[sourceId] ?? 5;
  if (!Number.isFinite(limit) || limit < calls) return false;
  const row = await pool.query(`INSERT INTO provider_budgets(source_id,day,calls) VALUES($1,CURRENT_DATE,$2)
    ON CONFLICT(source_id,day) DO UPDATE SET calls=provider_budgets.calls+EXCLUDED.calls
    WHERE provider_budgets.calls+EXCLUDED.calls<=$3 RETURNING calls`, [sourceId,calls,limit]);
  return row.rowCount > 0;
}

import { createHash } from 'node:crypto';
import { clusterSignals, deduplicateSignals, normalizeTopic } from './trend-engine.mjs';
import { WINDOW_MS, FRESHNESS_THRESHOLDS } from './config.mjs';

export const clusterKey = (name, language = 'en') => `${language}:${normalizeTopic(name)}`;
export const scopeKey = (input) => createHash('sha256').update(JSON.stringify([
  normalizeTopic(input.query), input.country, input.language, input.timeWindow,
])).digest('hex');

export function matchesTopic(signal, name) {
  const title = ` ${normalizeTopic(signal.title ?? signal.topic)} `;
  return title.includes(` ${normalizeTopic(name)} `);
}

// Names always come from provider labels or literal spans of evidence, never generated prose.
export function discoverCandidates(sources, input) {
  const signals = deduplicateSignals(sources.flatMap((s) => s.signals ?? []));
  const candidates = new Map();
  const add = (name, evidence, method) => {
    name = String(name ?? '').trim();
    if (name.length < 3 || name.length > 100 || normalizeTopic(name) === normalizeTopic(input.query)) return;
    const key = clusterKey(name, input.language);
    const previous = candidates.get(key);
    candidates.set(key, { key, name, evidence: deduplicateSignals([...(previous?.evidence ?? []), ...evidence]), method });
  };
  for (const source of sources) for (const related of source.candidates ?? []) {
    add(related.name, [related.evidence], related.kind);
  }
  const stop = new Set('the and for with from this that your how why what new best into about more have has are was fitness'.split(' '));
  const phrases = new Map();
  for (const signal of signals) {
    const words = String(signal.title).match(/[\p{L}\p{N}]+/gu) ?? [];
    for (let n = 2; n <= 3; n++) for (let i = 0; i <= words.length - n; i++) {
      const part = words.slice(i, i + n);
      if (part.some((w) => stop.has(w.toLowerCase()) || w.length < 3)) continue;
      const name = part.join(' '), key = normalizeTopic(name);
      const item = phrases.get(key) ?? { name, evidence: [] };
      if (!item.evidence.includes(signal)) item.evidence.push(signal);
      phrases.set(key, item);
    }
  }
  for (const item of phrases.values()) if (item.evidence.length >= 2) add(item.name, item.evidence, 'repeated_evidence_phrase');
  for (const cluster of clusterSignals(signals, { query: input.query })) add(cluster.canonicalName, cluster.items, 'evidence_title_cluster');
  return [...candidates.values()].sort((a, b) => b.evidence.length - a.evidence.length || a.key.localeCompare(b.key)).slice(0, 20);
}

const median = (values) => {
  const xs = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a,b) => a-b);
  return xs.length ? (xs[Math.floor((xs.length - 1)/2)] + xs[Math.floor(xs.length/2)])/2 : null;
};

export async function storeObservations(pool, input, sources, candidates, now = Date.now()) {
  const scope = scopeKey(input), at = new Date(now).toISOString();
  const bucket = new Date(Math.floor(now / 900_000) * 900_000).toISOString();
  for (const source of sources) if (source.series?.length) {
    await pool.query(`INSERT INTO provider_series_batches(scope_key,source_id,collected_at,series)
      VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,[scope,source.id,at,JSON.stringify({series:source.series,geographicSeries:source.geographicSeries ?? []})]);
  }
  const topics = [{ key: clusterKey(input.query, input.language), name: input.query, parent: true }, ...candidates];
  for (const topic of topics) {
    await pool.query(`INSERT INTO topic_clusters (cluster_key,name,first_observed_at,last_observed_at)
      VALUES ($1,$2,$3,$3) ON CONFLICT(cluster_key) DO UPDATE SET last_observed_at=EXCLUDED.last_observed_at`, [topic.key,topic.name,at]);
    for (const source of sources) {
      // Failed/partial requests are missing observations, not zero-count buckets.
      if (source.status !== 'CONNECTED' || !source.freshness?.lastSuccessAt) continue;
      const raw = (source.signals ?? []).filter((s) => topic.parent || matchesTopic(s, topic.name));
      const evidence = deduplicateSignals(raw);
      if (!evidence.length) continue; // conservative: absence in a capped sample is not zero population activity
      const metrics = {
        sampled_records: evidence.length,
        unique_publishers: new Set(evidence.map((s) => s.publisherId).filter(Boolean)).size,
        unique_communities: new Set(evidence.map((s) => s.metadata?.community).filter(Boolean)).size,
        median_views: median(evidence.map((s) => s.metadata?.views)),
        median_score: median(evidence.filter((s) => s.metric === 'score' || s.metric === 'points').map((s) => s.metricValue)),
        median_comments: median(evidence.map((s) => s.metadata?.comments)),
        median_views_per_hour_since_publish: median(evidence.filter((s) => s.metric === 'views_per_hour_since_publish').map((s) => s.metricValue)),
        sample_window: input.timeWindow,
        duplicate_count: raw.length-evidence.length,
      };
      await pool.query(`INSERT INTO topic_observations(scope_key,cluster_key,source_id,bucket_at,collected_at,metrics,evidence)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
        ON CONFLICT(scope_key,cluster_key,source_id,bucket_at) DO UPDATE
        SET collected_at=EXCLUDED.collected_at,metrics=EXCLUDED.metrics,evidence=EXCLUDED.evidence`,
      [scope,topic.key,source.id,bucket,at,JSON.stringify(metrics),JSON.stringify(evidence)]);
    }
  }
}

export async function historySeries(pool, input, name, sourceId, now = Date.now()) {
  if (!['youtube','reddit','news','hackernews'].includes(sourceId)) return [];
  const width = WINDOW_MS[input.timeWindow];
  const rows = await pool.query(`SELECT collected_at,metrics FROM topic_observations
    WHERE scope_key=$1 AND cluster_key=$2 AND source_id=$3 AND collected_at >= $4
    ORDER BY collected_at`, [scopeKey(input),clusterKey(name,input.language),sourceId,new Date(now-width*12).toISOString()]);
  const buckets = new Map();
  for (const row of rows.rows) {
    const t = Math.floor(Date.parse(row.collected_at)/width)*width;
    // Last sampled rolling-window count per bucket, never sum overlapping samples.
    buckets.set(t, { t:new Date(t).toISOString(), value:row.metrics.sampled_records });
  }
  return buckets.size ? [{ id:`stored:${sourceId}:${clusterKey(name,input.language)}`, article:name,
    label:`${name}: sampled ${input.timeWindow} record count`, metric:'sampled_record_count', unit:'sampled records',
    stored:true, bucketMs:width, points:[...buckets.values()], geographic:false,
    provenance:{ method:'last_sample_per_bucket', scope:scopeKey(input), window:input.timeWindow, missing:'not imputed' } }] : [];
}

export async function enrichHistory(pool, input, sources, candidates, now = Date.now()) {
  const names = input.mode === 'discover' ? candidates.map((c) => c.name) : [input.query];
  return Promise.all(sources.map(async (source) => {
    const history = [];
    for (const name of names) {
      const broad = await historySeries(pool,input,name,source.id,now);
      if (input.mode !== 'discover') {history.push(...broad);continue;}
      const targetedInput = {...input,query:name,mode:'analyze'};
      const targeted = await historySeries(pool,targetedInput,name,source.id,now);
      // Select one sampling scope. Never splice broad-category counts and targeted-query counts.
      const chosen = (targeted[0]?.points.length ?? 0) > (broad[0]?.points.length ?? 0) ? targeted : broad;
      history.push(...chosen);
      const batches = await pool.query(`SELECT series,collected_at FROM provider_series_batches
        WHERE scope_key=$1 AND source_id=$2 AND collected_at >= $3 ORDER BY collected_at DESC LIMIT 1`,
      [scopeKey(targetedInput),source.id,new Date(now-(FRESHNESS_THRESHOLDS[source.id]?.recentSec ?? 21600)*1000).toISOString()]);
      const batch=batches.rows[0];
      for (const series of batch?.series?.series ?? []) {
        if (series.article && normalizeTopic(series.article) !== normalizeTopic(name)) continue;
        history.push({...series,article:name,collectedAt:batch.collected_at,
          provenance:{method:'targeted_provider_response',scope:scopeKey(targetedInput),collectedAt:batch.collected_at}});
      }
    }
    return {...source, series:[...(source.series ?? []),...history]};
  }));
}

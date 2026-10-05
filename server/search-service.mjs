import { publicSource } from './source-health.mjs';
import { discoverCandidates, enrichHistory, storeObservations } from './discovery.mjs';
import { trackTopic, createCollectionQueue, reserveProviderBudget } from './collection-queue.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { buildAnalysis } from './analyze.mjs';
import { SCORE_VERSION, SOURCE_CATALOG, selectedSourceIds } from './config.mjs';
import { commitSearch, releaseSearch, reserveSearch } from './credit-ledger.mjs';
import { logEvent } from './log.mjs';
import { ADAPTERS, sourceConfigHash, healthCheckSource } from './sources/adapters.mjs';
import { classifySourceFreshness } from './trend-engine.mjs';
import { FRESHNESS_THRESHOLDS } from './config.mjs';

function cacheKeyFor(input) {
  return createHash('sha256').update(JSON.stringify({
    mode: input.mode ?? 'analyze',
    query: input.query.trim().toLocaleLowerCase('en'),
    country: input.country,
    language: input.language,
    source: input.source,
    timeWindow: input.timeWindow,
    version: SCORE_VERSION,
  })).digest('hex');
}

function refreshCachedSources(sources = []) {
  return sources.map((source) => publicSource({ ...source, freshness: source, latencyMs: source.latencyMs, limitations: source.limitations ?? [source.note].filter(Boolean) }));
}

async function readCache(pool, key) {
  const found = await pool.query(
    `SELECT report, fresh_until FROM intelligence_cache WHERE cache_key = $1 AND fresh_until > now()`,
    [key],
  );
  return found.rows[0] ?? null;
}

async function writeCache(pool, key, report) {
  await pool.query(
    `INSERT INTO intelligence_cache (cache_key, algorithm_version, report, fresh_until)
     VALUES ($1, $2, $3::jsonb, now() + interval '15 minutes')
     ON CONFLICT (cache_key) DO UPDATE SET report = EXCLUDED.report, fresh_until = EXCLUDED.fresh_until, created_at = now()`,
    [key, SCORE_VERSION, JSON.stringify(report)],
  );
}

async function rememberSource(pool, source) {
  const row = publicSource(source);
  await pool.query(
    `INSERT INTO source_freshness (source_id, status, live_status, last_attempt_at, last_success_at, latest_signal_at, latency_ms, requests, estimated_cost_usd, limitation, config_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (source_id) DO UPDATE SET
       config_hash = EXCLUDED.config_hash,
       status = EXCLUDED.status,
       live_status = EXCLUDED.live_status,
       last_attempt_at = EXCLUDED.last_attempt_at,
       last_success_at = COALESCE(EXCLUDED.last_success_at, source_freshness.last_success_at),
       latest_signal_at = COALESCE(EXCLUDED.latest_signal_at, source_freshness.latest_signal_at),
       latency_ms = EXCLUDED.latency_ms,
       requests = source_freshness.requests + EXCLUDED.requests,
       estimated_cost_usd = source_freshness.estimated_cost_usd + EXCLUDED.estimated_cost_usd,
       limitation = EXCLUDED.limitation,
       updated_at = now()`,
    [row.id, row.status, row.liveStatus, row.lastAttemptAt, row.lastSuccessAt, row.latestSignalAt, row.latencyMs, row.requests, row.estimatedCostUsd, row.note, sourceConfigHash(source.id)],
  );
  await pool.query(
    `INSERT INTO source_health (source_id, state, latency_ms, success_count, failure_count, freshness_lag_seconds, safe_error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.id,
      row.status === 'CONNECTED' ? 'healthy' : row.status === 'NOT_CONFIGURED' ? 'disabled' : row.status === 'RATE_LIMITED' ? 'quota_limited' : row.status === 'DEGRADED' ? 'degraded' : 'unavailable',
      row.latencyMs,
      row.status === 'CONNECTED' ? 1 : 0,
      row.status === 'CONNECTED' || row.status === 'NOT_CONFIGURED' ? 0 : 1,
      row.dataAgeSeconds,
      source.errorCode ?? null,
    ],
  );
}

async function persistSignals(client, sourceResults) {
  for (const source of sourceResults) {
    for (const signal of (source.signals ?? []).slice(0, 80)) {
      if (!signal.timestamp) continue;
      await client.query(
        `INSERT INTO raw_signals
           (source_id, external_id, title, topic_hint, observed_at, collected_at, country_code, language_code, platform, metric_name, metric_value, metric_unit, source_confidence, publisher_id, reference_url, dedupe_key, raw_payload)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
         ON CONFLICT (source_id, external_id) DO NOTHING`,
        [
          source.id,
          signal.sourceId || null,
          signal.title ?? signal.topic ?? null,
          signal.topic ?? null,
          signal.timestamp,
          signal.collectedAt ?? null,
          signal.country,
          signal.language,
          signal.platform,
          signal.metric,
          signal.metricValue,
          signal.metricUnit ?? null,
          signal.sourceConfidence,
          signal.publisherId,
          signal.reference,
          signal.reference ? createHash('sha256').update(String(signal.reference)).digest('hex') : null,
          JSON.stringify({ ...signal.metadata, provider: signal.metadata?.provider ?? source.id }),
        ],
      );
    }
  }
}

async function persistResults(pool, { searchId, report, sourceResults }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await persistSignals(client, sourceResults);
    for (const result of report.results) {
      const topic = await client.query(
        `INSERT INTO normalized_topics (canonical_name, normalized_key, language_code, clustering_method, clustering_version)
         VALUES ($1, $2, $3, 'lexical-jaccard', '1.0.0')
         ON CONFLICT (normalized_key) DO UPDATE SET updated_at = now(), canonical_name = EXCLUDED.canonical_name
         RETURNING id`,
        [result.name, result.trendId.replace(/^topic:/, ''), report.language],
      );
      const topicId = topic.rows[0].id;
      const firstDetected = result.firstDetectedAt ?? result.latestAt ?? report.analysisCompletedAt;
      const episode = await client.query(
        `INSERT INTO trend_episodes (topic_id, country_code, language_code, episode_number, first_detected_at, acceleration_started_at, last_observed_at, current_lifecycle)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7)
         ON CONFLICT (topic_id, country_code, language_code, episode_number)
         DO UPDATE SET last_observed_at = EXCLUDED.last_observed_at, current_lifecycle = EXCLUDED.current_lifecycle, acceleration_started_at = COALESCE(trend_episodes.acceleration_started_at, EXCLUDED.acceleration_started_at), updated_at = now()
         RETURNING id`,
        [topicId, report.country, report.language, firstDetected, result.episodeStart, result.latestAt ?? report.analysisCompletedAt, String(result.lifecycle).toLowerCase()],
      );
      const episodeId = episode.rows[0].id;
      result.episodeId = episodeId;
      const primarySource = result.sources?.[0] ?? 'news';
      for (const point of result.curve ?? []) {
        await client.query(
          `INSERT INTO trend_snapshots (episode_id, source_id, observed_at, country_code, language_code, relative_interest, observation_count, coverage)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT (episode_id, source_id, observed_at, country_code, language_code) DO NOTHING`,
          [episodeId, primarySource, point.t, report.country, report.language, point.metric === 'relative_interest' ? point.value : null, point.metric === 'relative_interest' ? null : point.value, JSON.stringify({ metric: point.metric })],
        );
      }
      const score = await client.query(
        `INSERT INTO trend_scores
           (episode_id, score_version, trend_score, confidence_score, velocity, acceleration, freshness, saturation_opportunity, geographic_strength, cross_source_confirmation, evidence_coverage, lifecycle, early_signal, features, thresholds_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, '1.0.0')
         RETURNING id`,
        [
          episodeId, SCORE_VERSION, result.score, result.confidence, result.velocity, result.acceleration, result.freshnessScore,
          result.saturation, result.geography, result.provenance?.crossSource?.value ?? null, result.scoreCoverage,
          String(result.lifecycle).toLowerCase(), result.earlySignal, JSON.stringify(result.provenance ?? {}),
        ],
      );
      await client.query(
        `INSERT INTO search_results (search_id, episode_id, rank, score_id, score_at_search, confidence_at_search, lifecycle_at_search, explanation, result_metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (search_id, episode_id) DO NOTHING`,
        [searchId, episodeId, result.rank, score.rows[0].id, result.score, result.confidence, result.lifecycle, result.explanation?.text ?? null, JSON.stringify({ trendId: result.trendId })],
      );
    }
    await client.query(
      `UPDATE trend_searches SET source_coverage = $2::jsonb, report = $3::jsonb, started_at = COALESCE(started_at, $4::timestamptz) WHERE id = $1`,
      [searchId, JSON.stringify({ sources: report.sourceFreshness.map((source) => source.id) }), JSON.stringify(report), report.analysisStartedAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original */ }
    throw error;
  } finally {
    client.release();
  }
}

function assembleReport({ searchId, input, analysis, sources, startedAt, cache }) {
  const completedAt = new Date().toISOString();
  const latest = sources.map((source) => source.latestSignalAt).filter(Boolean).sort().at(-1) ?? null;
  const ages = sources.map((source) => source.dataAgeSeconds).filter((value) => Number.isFinite(value));
  return {
    id: searchId,
    query: input.query,
    mode: input.mode ?? 'analyze',
    country: input.country,
    language: input.language,
    sources: input.source,
    timeWindow: input.timeWindow,
    charged: true,
    creditState: 'committed',
    analysisStartedAt: startedAt,
    analysisCompletedAt: completedAt,
    lastUpdatedAt: completedAt,
    latestSignalAt: latest,
    sourceFreshness: sources,
    dataFreshness: {
      minSeconds: ages.length ? Math.min(...ages) : null,
      maxSeconds: ages.length ? Math.max(...ages) : null,
    },
    algorithmVersion: SCORE_VERSION,
    cache,
    message: analysis.message,
    code: analysis.code,
    results: analysis.results,
    observations: analysis.observations,
    topicAssessment: analysis.topicAssessment,
    stats: analysis.stats,
    warnings: sources.filter((source) => source.status !== 'CONNECTED').map((source) => `${source.name} is ${source.status.replaceAll('_', ' ').toLowerCase()}.`),
  };
}

export async function executeSearch(pool, { userId, input, requestId, idempotencyKey, onEvent = () => {}, collectors = ADAPTERS }) {
  input = { ...input, mode: input.mode ?? 'analyze' };
  if (!['analyze','discover'].includes(input.mode)) throw Object.assign(new Error('Choose analyze or discover.'), {status:400,code:'INVALID_MODE'});
  const startedAt = new Date().toISOString();
  onEvent('search_started', { requestId, at: startedAt });
  onEvent('entitlement_checked', { userId });
  const reservation = await reserveSearch(pool, {
    userId,
    requestId,
    idempotencyKey,
    query: input.query,
    countryCode: input.country,
    languageCode: input.language,
    sourceFilter: input.source,
    timeWindow: input.timeWindow,
  });
  onEvent('credit_reserved', { searchId: reservation.search_id, replay: reservation.idempotentReplay });
  if (reservation.idempotentReplay && reservation.status === 'committed') {
    const existing = await pool.query(`SELECT report FROM trend_searches WHERE id = $1`, [reservation.search_id]);
    if (existing.rows[0]?.report) return { ...existing.rows[0].report, sourceFreshness:refreshCachedSources(existing.rows[0].report.sourceFreshness), charged: false, creditState: 'not_charged', idempotentReplay: true };
  }
  if (reservation.idempotentReplay) throw Object.assign(new Error('This search request was already submitted. Use a new request key to retry.'), {status:409,code:'SEARCH_ALREADY_SUBMITTED',charged:false});
  const key = cacheKeyFor(input);
  try {
    await trackTopic(pool, input);
    const cached = await readCache(pool, key);
    onEvent('cache_checked', { hit: Boolean(cached) });
    let sources;
    let analysis;
    let collected = [];
    let cacheState = 'miss';
    if (cached?.report) {
      sources = refreshCachedSources(cached.report.sourceFreshness ?? []);
      const stale = sources.some((source) => source.liveStatus === 'STALE' || source.liveStatus === 'UNAVAILABLE');
      if (!stale) {
        analysis = {
          ok: true,
          code: cached.report.code,
          message: cached.report.message,
          results: cached.report.results,
          observations: cached.report.observations,
          topicAssessment: cached.report.topicAssessment,
          stats: cached.report.stats,
        };
        cacheState = 'hit';
      }
    }
    if (!analysis) {
      onEvent('collecting_sources', { sources: selectedSourceIds(input.source) });
      collected = await Promise.all(selectedSourceIds(input.source).map(async (sourceId) => {
        const catalog = SOURCE_CATALOG.find((source) => source.id === sourceId);
        try {
          if (collectors === ADAPTERS && (await healthCheckSource(sourceId)).status !== 'NOT_CONFIGURED' && !await reserveProviderBudget(pool, sourceId)) return budgetLimited(sourceId);
          const result = await collectors[sourceId](input);
          result.quality = catalog?.weight ?? 0.5;
          onEvent('source_completed', { id: sourceId, status: result.status, signals: result.signals?.length ?? 0, latencyMs: result.latencyMs ?? 0 });
          return result;
        } catch (error) {
          onEvent('source_completed', { id: sourceId, status: 'UNAVAILABLE', signals: 0 });
          return {
            id: sourceId,
            name: catalog?.name ?? sourceId,
            status: 'UNAVAILABLE',
            signals: [],
            series: [],
            limitations: ['The connector failed before returning evidence. No records were invented.'],
            errorCode: error.code || 'CONNECTOR_ERROR',
            requests: 0,
            estimatedCostUsd: 0,
            latencyMs: 0,
            quality: catalog?.weight ?? 0.5,
            freshness: { source: sourceId, status: 'UNAVAILABLE', liveStatus: 'UNAVAILABLE', lastAttemptAt: new Date().toISOString(), lastSuccessAt: null, latestSignalAt: null, dataAgeSeconds: null },
          };
        }
      }));
      for (const source of collected) {
        try { await rememberSource(pool, source); } catch (error) { logEvent('source_health_write_failed', { source: source.id, code: error.code }); }
      }
      sources = collected.map((source) => publicSource(source));
      onEvent('normalizing', {});
      onEvent('deduplicating', {});
      onEvent('clustering', {});
      onEvent('comparing_history', {});
      onEvent('calculating_momentum', {});
      onEvent('scoring', {});
      const candidates = discoverCandidates(collected, input);
      // Keep evidence even when no candidate yet qualifies for a scored report.
      await persistSignals(pool, collected);
      await storeObservations(pool, input, collected, candidates);
      for (const candidate of candidates) await trackTopic(pool, {...input,query:candidate.name,mode:'analyze'}, 'discovered', 10);
      const enriched = await enrichHistory(pool,input,collected,candidates);
      analysis = buildAnalysis({ ...input, candidates, sourceResults: enriched });
      for (const result of analysis.results) if (result.lifecycle === 'accelerating') await trackTopic(pool,{...input,query:result.name,mode:'analyze'},'accelerating',70);
      onEvent('verifying', { qualified: analysis.stats?.qualified ?? 0 });
    }
    if (!analysis.ok) {
      await releaseSearch(pool, {
        reservationId: reservation.id ?? reservation.reservation_id,
        requestId,
        failureCode: analysis.code,
        safeMessage: analysis.message,
      });
      onEvent('credit_released', { reason: analysis.code });
      return {
        id: reservation.search_id,
        charged: false,
        creditState: 'released',
        code: analysis.code,
        message: analysis.message,
        results: [],
        observations: [],
        topicAssessment: null,
        sourceFreshness: sources,
        analysisStartedAt: startedAt,
        analysisCompletedAt: new Date().toISOString(),
        warnings: sources.filter((source) => source.status !== 'CONNECTED').map((source) => `${source.name}: ${source.limitations?.[0] ?? source.note ?? source.status}`),
        stats: analysis.stats,
      };
    }
    const report = assembleReport({
      searchId: reservation.search_id,
      input,
      analysis,
      sources,
      startedAt,
      cache: cacheState,
    });
    await persistResults(pool, { searchId: reservation.search_id, report, sourceResults: collected });
    if (cacheState === 'miss') await writeCache(pool, key, report);
    const reservationId = reservation.id ?? reservation.reservation_id;
    await commitSearch(pool, { reservationId, requestId });
    try {
      const cost = sources.reduce((sum, source) => sum + (source.estimatedCostUsd ?? 0), 0);
      await pool.query(
        `INSERT INTO cost_logs (search_id, request_id, provider, api_request_count, api_cost_minor, currency, cache_hit, processing_ms, total_estimated_cost_minor, metadata)
         VALUES ($1, $2, 'mixed', $3, $4, 'USD', $5, $6, $4, $7::jsonb)`,
        [reservation.search_id, requestId, sources.reduce((sum, source) => sum + (source.requests ?? 0), 0), Math.round(cost * 100), cacheState === 'hit', Date.now() - new Date(startedAt).getTime(), JSON.stringify({ sources: sources.map((source) => ({ id: source.id, requests: source.requests, usd: source.estimatedCostUsd })) })],
      );
    } catch (error) {
      logEvent('cost_log_failed', { searchId: reservation.search_id, code: error.code });
    }
    onEvent('results_ready', { searchId: reservation.search_id, qualified: report.results.length });
    logEvent('search_completed', { searchId: reservation.search_id, userId, query: input.query, cache: cacheState, qualified: report.results.length, charged: true });
    return report;
  } catch (error) {
    const reservationId = reservation.id ?? reservation.reservation_id;
    try {
      await releaseSearch(pool, {
        reservationId,
        requestId,
        failureCode: error.code || 'ANALYSIS_FAILED',
        safeMessage: 'The analysis did not complete. Your search was not charged.',
      });
    } catch (releaseError) {
      logEvent('credit_release_failed', { searchId: reservation.search_id, code: releaseError.code });
    }
    onEvent('credit_released', { reason: error.code || 'ANALYSIS_FAILED' });
    logEvent('search_failed', { searchId: reservation.search_id, userId, code: error.code || 'ANALYSIS_FAILED' });
    throw Object.assign(new Error('The analysis did not complete. Your search was not charged.'), { code: error.code || 'ANALYSIS_FAILED', status: error.status || 500, charged: false });
  }
}

function budgetLimited(sourceId) {
  return {id:sourceId,name:sourceId,status:'RATE_LIMITED',signals:[],series:[],
    limitations:['Local daily provider budget reached.'],freshness:{lastAttemptAt:new Date().toISOString()},requests:0};
}

export async function refreshTrackedTopic(pool, {queue=createCollectionQueue(pool), collectors=ADAPTERS} = {}) {
  const job = await queue.claim();
  if (!job) return {refreshed:false};
  try {
    const input = job.input;
    const collected = [];
    for (const id of selectedSourceIds(input.source)) {
      let source;
      if ((collectors !== ADAPTERS || (await healthCheckSource(id)).status !== 'NOT_CONFIGURED') && !await reserveProviderBudget(pool,id)) source=budgetLimited(id);
      else {
        try {source=await collectors[id](input);} catch {source={id,name:id,status:'UNAVAILABLE',signals:[],series:[],freshness:{lastAttemptAt:new Date().toISOString()}};}
      }
      await rememberSource(pool,source);
      collected.push(source);
    }
    const candidates=discoverCandidates(collected,input);
    await persistSignals(pool,collected);
    await storeObservations(pool,input,collected,candidates);
    for (const candidate of candidates) if (input.mode === 'discover') await trackTopic(pool,{...input,query:candidate.name,mode:'analyze'},'discovered',10);
    const enriched=await enrichHistory(pool,input,collected,candidates);
    const analysis=buildAnalysis({...input,candidates,sourceResults:enriched});
    if (analysis.ok) {
      const report=assembleReport({searchId:null,input,analysis,sources:collected.map((s)=>publicSource(s)),startedAt:new Date().toISOString(),cache:'refresh'});
      await writeCache(pool,cacheKeyFor(input),report);
      for (const result of analysis.results) if (result.lifecycle === 'accelerating') await trackTopic(pool,{...input,query:result.name,mode:'analyze'},'accelerating',70);
    }
    await queue.finish(job,analysis.ok ? null : 'INSUFFICIENT_EVIDENCE');
    return {refreshed:analysis.ok,qualified:analysis.results.length};
  } catch(error) {await queue.finish(job,error.code || 'COLLECTION_FAILED'); throw error;}
}

export async function getOwnedReport(pool, { userId, searchId }) {
  const found = await pool.query(
    `SELECT report, status FROM trend_searches WHERE id = $1 AND user_id = $2`,
    [searchId, userId],
  );
  if (!found.rowCount || !found.rows[0].report) return null;
  return { ...found.rows[0].report, sourceFreshness: refreshCachedSources(found.rows[0].report.sourceFreshness), charged: false, creditState: 'not_charged', reopened: true };
}

export { publicSource };

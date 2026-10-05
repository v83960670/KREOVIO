import { FRESHNESS_THRESHOLDS } from './config.mjs';
import { classifySourceFreshness } from './trend-engine.mjs';

export function publicSource(source, now = Date.now()) {
  const f = source.freshness ?? source;
  const latest = f.latestSignalAt ?? f.latest_signal_at ?? null;
  const success = f.lastSuccessAt ?? f.last_success_at ?? null;
  const attempt = f.lastAttemptAt ?? f.last_attempt_at ?? null;
  const ageOf = (value) => value && Number.isFinite(Date.parse(value)) ? Math.max(0, (now - Date.parse(value)) / 1000) : null;
  const age = ageOf(latest);
  const collectionAge = ageOf(success);
  const effectiveAge = age == null || collectionAge == null ? null : Math.max(age, collectionAge);
  const status = source.status === 'CONNECTED' && !success ? 'UNKNOWN' : source.status;
  return {
    id: source.id, name: source.name, status,
    liveStatus: classifySourceFreshness({ ageSeconds: effectiveAge, connectorStatus: status, thresholds: FRESHNESS_THRESHOLDS[source.id] }),
    lastAttemptAt: attempt, lastSuccessAt: success, latestSignalAt: latest,
    dataAgeSeconds: age == null ? null : Math.round(age),
    latencyMs: source.latencyMs ?? source.latency_ms ?? null,
    note: source.limitations?.[0] ?? source.limitation ?? source.note ?? '',
    limitations: source.limitations ?? [source.limitation ?? source.note].filter(Boolean),
    geographicEvidence: source.geographicSeries ?? source.geographicEvidence ?? [],
    provider: source.provider ?? null, requests: source.requests ?? 0, estimatedCostUsd: source.estimatedCostUsd ?? 0,
  };
}

export function healthSnapshot(catalog, configured, stored) {
  // Removing credentials immediately disables a previously successful connector.
  const changed = configured.configHash && stored?.config_hash !== configured.configHash;
  const status = configured.status === 'NOT_CONFIGURED' ? configured.status : changed ? 'UNKNOWN' : stored?.status ?? configured.status;
  return publicSource({ ...catalog, ...(stored ?? {}), status, note: stored?.limitation || configured.note });
}

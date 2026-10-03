export const SCORE_VERSION = 'KTS-1.0';

export const DEFAULT_WEIGHTS = Object.freeze({
  velocity: 30,
  crossSource: 20,
  acceleration: 15,
  freshness: 15,
  saturation: 10,
  geography: 10,
});

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Normalize a topic label for alias matching. This is intentionally lexical, not semantic. */
export function normalizeTopic(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Normalize an adapter event without manufacturing absent metrics or timestamps. */
export function standardizeSignal(raw = {}) {
  const source = typeof raw.source === 'string' ? raw.source.trim().toLowerCase() : '';
  const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
  const timestamp = raw.timestamp == null ? null : new Date(raw.timestamp);
  if (!source || !topic || !timestamp || !Number.isFinite(timestamp.getTime())) return null;
  let reference = null;
  if (typeof raw.reference === 'string' && raw.reference.trim()) {
    try {
      const url = new URL(raw.reference);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
        for (const key of [...url.searchParams.keys()]) {
          if (/^(utm_|fbclid|gclid|api_key|key|token|access_token|auth)/i.test(key)) url.searchParams.delete(key);
        }
        reference = url.toString();
      }
    } catch { /* Invalid references are omitted rather than echoed. */ }
  }
  return {
    source,
    topic,
    timestamp: timestamp.toISOString(),
    metric: typeof raw.metric === 'string' ? raw.metric : null,
    metricValue: isNumber(raw.metricValue) ? raw.metricValue : null,
    country: typeof raw.country === 'string' ? raw.country.toUpperCase() : null,
    language: typeof raw.language === 'string' ? raw.language.toLowerCase() : null,
    platform: typeof raw.platform === 'string' ? raw.platform : null,
    sourceConfidence: isNumber(raw.sourceConfidence) ? clamp(raw.sourceConfidence) : null,
    reference,
    metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? raw.metadata : {},
  };
}

function wordSet(value) {
  return new Set(normalizeTopic(value).split(' ').filter((word) => word.length > 1));
}

function jaccard(left, right) {
  const a = wordSet(left);
  const b = wordSet(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function canonicalReference(reference = '') {
  try {
    const url = new URL(reference);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source)/i.test(key)) url.searchParams.delete(key);
    }
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}${url.search}`;
  } catch {
    return String(reference).trim().toLowerCase();
  }
}

/**
 * Collapse copied/near-identical items into one event while retaining source IDs.
 * `independentSourceIds` should be publisher/owner IDs where adapters can provide them,
 * not merely domains, so mirrors do not masquerade as independent confirmation.
 */
export function deduplicateSignals(signals, { titleSimilarity = 0.82 } = {}) {
  const unique = [];
  const byReference = new Map();

  for (const raw of signals ?? []) {
    const title = String(raw.title ?? raw.topic ?? '').trim();
    if (!title) continue;
    const signal = {
      ...raw,
      title,
      reference: String(raw.reference ?? ''),
      sourceIds: new Set(raw.sourceIds ?? [raw.source].filter(Boolean)),
      independentSourceIds: new Set(raw.independentSourceIds ?? (raw.publisherId ? [raw.publisherId] : [])),
      duplicateReferences: [],
      duplicateCount: 0,
    };
    const referenceKey = canonicalReference(signal.reference);
    let match = referenceKey ? byReference.get(referenceKey) : undefined;
    if (!match) {
      for (let index = unique.length - 1; index >= Math.max(0, unique.length - 200); index -= 1) {
        const candidate = unique[index];
        if (candidate.country && signal.country && candidate.country !== signal.country) continue;
        if (candidate.timestamp && signal.timestamp) {
          const timeGap = Math.abs(new Date(candidate.timestamp) - new Date(signal.timestamp));
          if (Number.isFinite(timeGap) && timeGap > 3 * 24 * 60 * 60 * 1000) continue;
        }
        if (jaccard(candidate.title, signal.title) >= titleSimilarity) {
          match = candidate;
          break;
        }
      }
    }
    if (match) {
      for (const source of signal.sourceIds) match.sourceIds.add(source);
      for (const publisher of signal.independentSourceIds) match.independentSourceIds.add(publisher);
      if (signal.reference && signal.reference !== match.reference) match.duplicateReferences.push(signal.reference);
      match.duplicateCount += 1;
      if (referenceKey) byReference.set(referenceKey, match);
    } else {
      unique.push(signal);
      if (referenceKey) byReference.set(referenceKey, signal);
    }
  }

  return unique.map((signal) => ({
    ...signal,
    sourceIds: [...signal.sourceIds],
    independentSourceIds: [...signal.independentSourceIds],
  }));
}

/**
 * Robust, log-scaled velocity. A percentage jump from a tiny count is suppressed by
 * the absolute minimum and volume term. `categoryBaseline` can stabilize a sparse
 * topic's baseline, but it must be computed from observed comparable topics.
 */
export function calculateVelocity({
  current,
  baseline,
  categoryBaseline,
  minimumCurrent = 10,
  minimumBaseline = 3,
  targetLift = 5,
} = {}) {
  if (!isNumber(current) || !isNumber(baseline) || current < minimumCurrent || baseline < minimumBaseline) {
    return null;
  }
  const robustBaseline = Math.max(baseline, isNumber(categoryBaseline) ? categoryBaseline : 0);
  if (robustBaseline < minimumBaseline) return null;

  const logLift = Math.max(0, Math.log((current + 1) / (robustBaseline + 1)));
  const growth = clamp(logLift / Math.log(targetLift + 1));
  const volume = clamp(Math.log1p(current / minimumCurrent) / Math.log(7));
  return Number((growth * volume).toFixed(4));
}

export function calculateAcceleration(currentVelocity, previousVelocity) {
  if (!isNumber(currentVelocity) || !isNumber(previousVelocity)) return null;
  return Number(clamp(0.5 + (currentVelocity - previousVelocity) * 2.5).toFixed(4));
}

export function calculateFreshness(hoursSinceAcceleration) {
  if (!isNumber(hoursSinceAcceleration) || hoursSinceAcceleration < 0) return null;
  if (hoursSinceAcceleration <= 6) return 1;
  if (hoursSinceAcceleration <= 24) return 0.88;
  if (hoursSinceAcceleration <= 72) return 0.68;
  if (hoursSinceAcceleration <= 168) return 0.42;
  if (hoursSinceAcceleration <= 720) return 0.18;
  return 0.05;
}

/** Decay compares the current normalized velocity with its prior and observed peak. */
export function calculateMomentumDecay({ currentVelocity, previousVelocity, peakVelocity, hoursSinceUpdate } = {}) {
  if (!isNumber(currentVelocity) || !isNumber(peakVelocity) || peakVelocity <= 0) return null;
  const retreatFromPeak = clamp(1 - currentVelocity / peakVelocity);
  const fallingNow = isNumber(previousVelocity) ? clamp((previousVelocity - currentVelocity) / Math.max(previousVelocity, 0.1)) : 0;
  const stale = isNumber(hoursSinceUpdate) ? clamp((hoursSinceUpdate - 6) / 72) : 0;
  return Number(clamp(retreatFromPeak * 0.58 + fallingNow * 0.27 + stale * 0.15).toFixed(4));
}

/** Estimate room relative to comparable coverage; requires measurable attention and coverage. */
export function calculateSaturationOpportunity({ currentInterest, currentCoverage, categoryMedianCoverage, minimumInterest = 10, targetCrowdingRatio = 3 } = {}) {
  if (!isNumber(currentInterest) || currentInterest < minimumInterest || !isNumber(currentCoverage) || currentCoverage < 1 || !isNumber(categoryMedianCoverage) || categoryMedianCoverage <= 0) return null;
  const demandStrength = clamp(Math.log1p(currentInterest / minimumInterest) / Math.log1p(10));
  const coverageRatio = currentCoverage / categoryMedianCoverage;
  const crowding = clamp(Math.log1p(coverageRatio) / Math.log1p(Math.max(1.1, targetCrowdingRatio)));
  return Number((demandStrength * (1 - crowding)).toFixed(4));
}

/** Geography is scored only from region observations returned by a source. */
export function calculateGeographicStrength(regions = [], selectedCountry = 'WORLDWIDE') {
  const valid = regions.filter((region) => region && typeof region.country === 'string' && isNumber(region.strength) && isNumber(region.sampleSize) && region.sampleSize > 0);
  if (selectedCountry !== 'WORLDWIDE') {
    const match = valid.find((region) => region.country.toUpperCase() === selectedCountry.toUpperCase());
    return match ? Number(clamp(match.strength).toFixed(4)) : null;
  }
  if (!valid.length) return null;
  const totalSample = valid.reduce((sum, region) => sum + region.sampleSize, 0);
  const weightedStrength = valid.reduce((sum, region) => sum + clamp(region.strength) * region.sampleSize, 0) / totalSample;
  const breadth = 1 - Math.exp(-new Set(valid.map((region) => region.country)).size / 2.5);
  return Number(clamp(weightedStrength * breadth).toFixed(4));
}

export function calculateCrossSourceConfirmation(sources = []) {
  const independent = new Set(sources.filter((source) => source?.independent !== false).map((source) => source?.id).filter(Boolean));
  if (!independent.size) return null;
  const quality = sources
    .filter((source) => independent.has(source.id))
    .map((source) => isNumber(source.quality) ? clamp(source.quality) : 0.5);
  const meanQuality = quality.reduce((sum, value) => sum + value, 0) / Math.max(quality.length, 1);
  const breadth = 1 - Math.exp(-independent.size / 1.65);
  return Number(clamp(breadth * meanQuality).toFixed(4));
}

/** A score is withheld when less than 60% of its configured dimensions are observed. */
export function calculateTrendScore(features = {}, weights = DEFAULT_WEIGHTS) {
  const configuredWeight = Object.values(weights).reduce((sum, weight) => sum + (isNumber(weight) && weight > 0 ? weight : 0), 0);
  if (!configuredWeight) return { score: null, coverage: 0, status: 'invalid_weights', version: SCORE_VERSION };

  let observedWeight = 0;
  let weightedTotal = 0;
  for (const [dimension, weight] of Object.entries(weights)) {
    const value = features[dimension];
    if (!isNumber(value) || !isNumber(weight) || weight <= 0) continue;
    observedWeight += weight;
    weightedTotal += clamp(value) * weight;
  }
  const coverage = observedWeight / configuredWeight;
  if (coverage < 0.6) {
    return { score: null, coverage: Number(coverage.toFixed(2)), status: 'insufficient_evidence', version: SCORE_VERSION };
  }
  return {
    score: Math.round((weightedTotal / observedWeight) * 100),
    coverage: Number(coverage.toFixed(2)),
    status: 'scored',
    version: SCORE_VERSION,
  };
}

/** Confidence is an evidence-quality estimate, never a restatement of the trend score. */
export function calculateConfidence({
  sourceQuality,
  independentSources,
  historicalHours,
  signalAgreement,
  sampleSize,
  dataCompleteness,
  conflicts = 0,
} = {}) {
  const observedSources = isNumber(independentSources) ? clamp(independentSources / 4) : null;
  const history = isNumber(historicalHours) ? clamp(Math.log1p(historicalHours) / Math.log1p(24 * 90)) : null;
  const sample = isNumber(sampleSize) ? clamp(Math.log1p(sampleSize) / Math.log1p(100)) : null;
  const parts = [
    [sourceQuality, 0.25],
    [observedSources, 0.2],
    [history, 0.15],
    [signalAgreement, 0.15],
    [sample, 0.15],
    [dataCompleteness, 0.1],
  ].filter(([value]) => isNumber(value));
  if (!parts.length) return { confidence: null, label: 'unavailable' };
  const availableWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
  const weighted = parts.reduce((sum, [value, weight]) => sum + clamp(value) * weight, 0) / availableWeight;
  // Missing evidence should lower the headline confidence rather than being silently renormalized away.
  const completenessPenalty = availableWeight;
  const conflictPenalty = Math.min(0.35, Math.max(0, conflicts) * 0.04);
  const confidence = Math.round(clamp(weighted * completenessPenalty - conflictPenalty) * 100);
  return {
    confidence,
    label: confidence >= 80 ? 'high' : confidence >= 60 ? 'moderate' : 'low',
  };
}

export function determineLifecycle({
  velocity,
  previousVelocity,
  acceleration,
  hoursSinceUpdate,
  ratioToPeak,
  expired = false,
} = {}) {
  if (expired || (isNumber(hoursSinceUpdate) && hoursSinceUpdate > 24 * 90)) return 'expired';
  if (!isNumber(velocity)) return 'emerging';
  const prior = isNumber(previousVelocity) ? previousVelocity : velocity;
  const peakRatio = isNumber(ratioToPeak) ? ratioToPeak : null;
  const velocityChange = velocity - prior;
  if (isNumber(hoursSinceUpdate) && hoursSinceUpdate > 72 && velocity < 0.22) return 'cooling';
  if (peakRatio !== null && peakRatio < 0.35 && velocity < prior) return 'cooling';
  if (peakRatio !== null && peakRatio >= 0.82 && Math.abs(velocityChange) < 0.08 && velocity > 0.55) return 'peaking';
  if (isNumber(acceleration) && acceleration >= 0.67 && velocity >= 0.35) return 'accelerating';
  if (Math.abs(velocityChange) < 0.05 && velocity >= 0.25 && velocity < 0.82) return 'stable';
  if (velocity >= 0.35) return 'rising';
  return 'emerging';
}

export function isEarlySignal({
  hoursSinceDetection,
  acceleration,
  confidence,
  saturation,
  independentSources,
  sampleSize,
  score,
} = {}) {
  return isNumber(hoursSinceDetection)
    && hoursSinceDetection <= 72
    && isNumber(acceleration) && acceleration >= 0.67
    && isNumber(confidence) && confidence >= 70
    && isNumber(saturation) && saturation <= 0.4
    && isNumber(independentSources) && independentSources >= 2
    && isNumber(sampleSize) && sampleSize >= 10
    && isNumber(score) && score >= 55;
}

export function getSupportedWindows(historicalDays = 0) {
  const windows = [
    { id: '6h', label: 'Past 6 hours', minDays: 0.25 },
    { id: '24h', label: 'Past 24 hours', minDays: 1 },
    { id: '3d', label: 'Past 3 days', minDays: 3 },
    { id: '7d', label: 'Past 7 days', minDays: 7 },
    { id: '30d', label: 'Past 30 days', minDays: 30 },
    { id: '90d', label: 'Past 90 days', minDays: 90 },
  ];
  return windows.filter((window) => historicalDays >= window.minDays);
}

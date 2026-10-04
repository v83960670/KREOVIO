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

export const DEFAULT_EARLY_SIGNAL = Object.freeze({
  maxHours: 72,
  minAcceleration: 0.67,
  minConfidence: 70,
  maxSaturation: 0.4,
  minIndependentSources: 2,
  minSampleSize: 10,
  minScore: 55,
});

const STOPWORDS = new Set('a an the of and or to in for on with from by at as is are was were be this that it its into about over after before vs via than then not no nor but if so such their they them you your our we can may will just more most other also than per via'.split(' '));
const GENERIC_TOPIC_TOKENS = new Set(['ai', 'artificial', 'intelligence', 'model', 'models', 'tech', 'technology', 'news', 'india', 'indian', 'update', 'updates', 'report', 'reports', 'said', 'says', 'internet', 'online', 'digital', 'data']);

function stemToken(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function distinctiveTokens(text = '', query = '') {
  const queryTokens = new Set(normalizeTopic(query).split(' ').map(stemToken));
  return [...new Set(normalizeTopic(text).split(' ')
    .map(stemToken)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !queryTokens.has(word) && !GENERIC_TOPIC_TOKENS.has(word)))];
}

function jaccardSets(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

/**
 * Conservative lexical clustering. Shared generic tokens such as "ai" are removed
 * before comparison so "AI agents" and "AI regulation" stay separate.
 */
export function clusterSignals(signals = [], { query = '', similarity = 0.5 } = {}) {
  const clusters = [];
  for (const signal of signals) {
    const title = String(signal.title ?? signal.topic ?? '').trim();
    if (!title) continue;
    const tokens = new Set(distinctiveTokens(title, query));
    let best = null;
    let bestScore = 0;
    if (tokens.size) {
      for (const cluster of clusters) {
        const score = jaccardSets(tokens, cluster.tokens);
        const shared = [...tokens].filter((token) => cluster.tokens.has(token));
        const related = shared.length >= 2 || (shared.length >= 1 && score >= similarity);
        if (related && score > bestScore) {
          best = cluster;
          bestScore = score;
        }
      }
    }
    if (best) {
      best.items.push(signal);
      best.titles.push(title);
      for (const token of tokens) best.tokens.add(token);
      best.score = Math.max(best.score, bestScore);
    } else {
      clusters.push({ tokens, items: [signal], titles: [title], score: 1 });
    }
  }
  return clusters.map((cluster, index) => {
    const canonical = cluster.titles.slice().sort((a, b) => a.length - b.length)[0];
    return {
      id: `cluster-${index + 1}`,
      canonicalName: canonical,
      aliases: [...new Set(cluster.titles.filter((title) => normalizeTopic(title) !== normalizeTopic(canonical)))],
      items: cluster.items,
      similarity: Number(cluster.score.toFixed(4)),
    };
  });
}

/** Count independent confirmations after duplicate collapse. Mirrors do not each count. */
export function independentConfirmations(signals = []) {
  const deduped = deduplicateSignals(signals);
  const groups = new Set();
  for (const signal of deduped) {
    const publishers = signal.independentSourceIds?.length ? signal.independentSourceIds : [];
    if (publishers.length <= 1) {
      groups.add(`story:${normalizeTopic(signal.title)}:${publishers[0] ?? signal.source ?? 'unknown'}`);
    } else {
      // Syndicated copies share one story. They confirm the story once per source family, not once per mirror.
      groups.add(`story:${normalizeTopic(signal.title)}:${signal.source ?? 'unknown'}`);
    }
  }
  return { stories: deduped.length, independentCount: groups.size, duplicatesRemoved: signals.length - deduped.length };
}

/**
 * Acceleration from a series of growth increments.
 * +4, +12, +35 accelerates. +20, +20, +20 grows without acceleration.
 * Returns null when fewer than three increments exist or the scale is too small to trust.
 * 0.5 means flat acceleration. Above 0.5 means the rate of growth is increasing.
 */
export function calculateAccelerationFromIncrements(increments, { minimumScale = 10 } = {}) {
  if (!Array.isArray(increments) || increments.length < 3 || increments.some((value) => !isNumber(value))) return null;
  const scale = Math.max(...increments.map((value) => Math.abs(value)));
  if (scale < minimumScale) return null;
  const changes = [];
  for (let index = 1; index < increments.length; index += 1) changes.push(increments[index] - increments[index - 1]);
  const meanChange = changes.reduce((sum, value) => sum + value, 0) / changes.length;
  return Number(clamp(0.5 + (meanChange / scale) * 0.9).toFixed(4));
}

/** Acceleration from absolute observations. One or two snapshots are not enough. */
export function calculateSeriesAcceleration(series = [], options = {}) {
  const points = (series ?? []).map((point) => typeof point === 'number' ? point : point?.value).filter(isNumber);
  if (points.length < 4) return null;
  const increments = [];
  for (let index = 1; index < points.length; index += 1) increments.push(points[index] - points[index - 1]);
  return calculateAccelerationFromIncrements(increments, options);
}

export function episodeFreshnessLabel(hoursSinceEpisode) {
  if (!isNumber(hoursSinceEpisode) || hoursSinceEpisode < 0) return 'UNAVAILABLE';
  if (hoursSinceEpisode <= 1) return 'JUST DETECTED';
  if (hoursSinceEpisode <= 6) return '<6 HOURS';
  if (hoursSinceEpisode <= 24) return '6–24 HOURS';
  if (hoursSinceEpisode <= 72) return '1–3 DAYS';
  if (hoursSinceEpisode <= 168) return '3–7 DAYS';
  return 'ESTABLISHED';
}

export function saturationLabel(value) {
  if (!isNumber(value)) return 'INSUFFICIENT EVIDENCE';
  if (value >= 0.75) return 'LOW';
  if (value >= 0.5) return 'MEDIUM';
  if (value >= 0.25) return 'HIGH';
  return 'VERY HIGH';
}

export function classifySourceFreshness({ ageSeconds, connectorStatus, thresholds }) {
  if (connectorStatus === 'NOT_CONFIGURED') return 'NOT CONFIGURED';
  if (connectorStatus === 'AUTHENTICATION_ERROR') return 'UNAVAILABLE';
  if (!isNumber(ageSeconds)) {
    if (connectorStatus === 'RATE_LIMITED' || connectorStatus === 'DEGRADED') return 'DEGRADED';
    return 'UNAVAILABLE';
  }
  const limits = thresholds ?? { liveSec: 15 * 60, nearLiveSec: 60 * 60, recentSec: 6 * 60 * 60, staleSec: 24 * 60 * 60 };
  let label = 'STALE';
  if (ageSeconds <= limits.liveSec) label = 'LIVE';
  else if (ageSeconds <= limits.nearLiveSec) label = 'NEAR LIVE';
  else if (ageSeconds <= limits.recentSec) label = 'RECENT';
  else label = 'STALE';
  if (connectorStatus === 'DEGRADED' || connectorStatus === 'RATE_LIMITED' || connectorStatus === 'UNAVAILABLE') {
    return label === 'LIVE' || label === 'NEAR LIVE' ? 'DEGRADED' : label;
  }
  return label;
}

export function scoreWithProvenance(features = {}, weights = DEFAULT_WEIGHTS) {
  const result = calculateTrendScore(features, weights);
  const observedWeight = Object.entries(weights).reduce((sum, [dimension, weight]) => (
    isNumber(features[dimension]) && isNumber(weight) && weight > 0 ? sum + weight : sum
  ), 0);
  const dimensions = {};
  for (const [dimension, weight] of Object.entries(weights)) {
    const value = features[dimension];
    const observed = isNumber(value) && isNumber(weight) && weight > 0;
    dimensions[dimension] = {
      value: observed ? Number(clamp(value).toFixed(4)) : null,
      weight,
      status: observed ? 'observed' : 'unavailable',
      contribution: observed && result.score != null && observedWeight > 0
        ? Number(((clamp(value) * weight / observedWeight) * 100).toFixed(2))
        : null,
    };
  }
  return { ...result, dimensions };
}

export function isEarlySignal(input = {}, thresholds = DEFAULT_EARLY_SIGNAL) {
  const rules = { ...DEFAULT_EARLY_SIGNAL, ...thresholds };
  return isNumber(input.hoursSinceDetection)
    && input.hoursSinceDetection <= rules.maxHours
    && isNumber(input.acceleration) && input.acceleration >= rules.minAcceleration
    && isNumber(input.confidence) && input.confidence >= rules.minConfidence
    && isNumber(input.saturation) && input.saturation <= rules.maxSaturation
    && isNumber(input.independentSources) && input.independentSources >= rules.minIndependentSources
    && isNumber(input.sampleSize) && input.sampleSize >= rules.minSampleSize
    && isNumber(input.score) && input.score >= rules.minScore;
}

const NUMBER_PATTERN = /(?<![A-Za-z0-9])\d[\d,]*(?:\.\d+)?%?/g;

export function numbersInText(text = '') {
  return [...String(text).matchAll(NUMBER_PATTERN)].map((match) => match[0]);
}

/** Reject an explanation sentence that introduces a number absent from the evidence allowlist. */
export function groundExplanation(text, allowedNumbers = []) {
  const allowed = new Set();
  for (const value of allowedNumbers) {
    if (!isNumber(value) && typeof value !== 'string') continue;
    const raw = String(value);
    allowed.add(raw);
    allowed.add(raw.replace(/\.0$/, ''));
    if (isNumber(Number(value))) {
      const rounded = String(Math.round(Number(value)));
      allowed.add(rounded);
      allowed.add(`${rounded}%`);
    }
  }
  const sentences = String(text ?? '').split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = [];
  const removed = [];
  for (const sentence of sentences) {
    const unsupported = numbersInText(sentence).filter((token) => !allowed.has(token) && !allowed.has(token.replace(/,/g, '')));
    if (unsupported.length) removed.push({ sentence, unsupported });
    else kept.push(sentence);
  }
  return { text: kept.join(' ').trim(), removed };
}

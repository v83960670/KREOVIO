import { ISO_COUNTRY, SCORE_VERSION, WINDOW_MS } from './config.mjs';
import {
  DEFAULT_EARLY_SIGNAL,
  DEFAULT_WEIGHTS,
  calculateConfidence,
  calculateCrossSourceConfirmation,
  calculateFreshness,
  calculateGeographicStrength,
  calculateMomentumDecay,
  calculateSaturationOpportunity,
  calculateSeriesAcceleration,
  calculateVelocity,
  clusterSignals,
  deduplicateSignals,
  determineLifecycle,
  episodeFreshnessLabel,
  groundExplanation,
  independentConfirmations,
  isEarlySignal,
  normalizeTopic,
  saturationLabel,
  scoreWithProvenance,
} from './trend-engine.mjs';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function median(values) {
  const sorted = values.filter(isNumber).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, digits = 2) {
  if (!isNumber(value)) return null;
  return Number(value.toFixed(digits));
}

function parseTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function granularityMs(points) {
  if (points.length < 2) return null;
  const gaps = [];
  for (let index = 1; index < points.length; index += 1) gaps.push(points[index].t - points[index - 1].t);
  return median(gaps.filter((gap) => gap > 0));
}

function windowTotals(points, windowMs, now) {
  if (!points.length) return [];
  const first = points[0].t;
  const totals = [];
  for (let cursor = first; cursor + windowMs <= now + 1_000; cursor += windowMs) {
    const slice = points.filter((point) => point.t >= cursor && point.t < cursor + windowMs);
    if (!slice.length) continue;
    totals.push({
      t: cursor + windowMs,
      value: slice.reduce((sum, point) => sum + point.value, 0),
      samples: slice.length,
    });
  }
  return totals;
}

function direction(current, baseline) {
  if (!isNumber(current) || !isNumber(baseline) || baseline <= 0) return null;
  const ratio = current / baseline;
  if (ratio >= 1.15) return 'up';
  if (ratio <= 0.85) return 'down';
  return 'flat';
}

function assessSeries(series, { windowMs, now }) {
  const points = (series.points ?? [])
    .map((point) => ({ t: parseTime(point.t), value: point.value, rank: point.rank }))
    .filter((point) => point.t != null && isNumber(point.value))
    .sort((a, b) => a.t - b.t);
  const grain = granularityMs(points);
  const tooCoarse = isNumber(grain) && grain > windowMs * 1.5;
  const totals = tooCoarse ? [] : windowTotals(points, windowMs, now);
  const history = totals.slice(0, -2);
  const baseline = history.length >= 2 ? median(history.map((point) => point.value)) : null;
  const current = totals.at(-1) ?? null;
  const previous = totals.at(-2) ?? null;
  const velocity = current && isNumber(baseline)
    ? calculateVelocity({ current: current.value, baseline })
    : null;
  const previousVelocity = previous && isNumber(baseline)
    ? calculateVelocity({ current: previous.value, baseline })
    : null;
  const acceleration = totals.length >= 4
    ? calculateSeriesAcceleration(totals.map((point) => point.value))
    : null;
  let episodeStart = null;
  let episodeStatus = 'insufficient_history';
  if (isNumber(baseline) && totals.length >= 4) {
    const threshold = Math.max(baseline * 1.35, baseline + Math.max(5, baseline * 0.2));
    const rising = totals.find((point) => point.value >= threshold);
    if (!rising) episodeStatus = 'no_new_episode';
    else if (rising.t === totals[0].t) episodeStatus = 'elevated_without_observed_onset';
    else {
      episodeStart = new Date(rising.t).toISOString();
      episodeStatus = 'episode_detected';
    }
  }
  const latest = points.at(-1) ?? null;
  const peak = totals.length ? Math.max(...totals.map((point) => point.value)) : null;
  return {
    sourceId: series.sourceId,
    label: series.label,
    metric: series.metric,
    unit: series.unit,
    country: series.country ?? null,
    geographic: Boolean(series.geographic),
    geographicMethod: series.geographicMethod ?? null,
    article: series.article ?? null,
    points,
    totals,
    grain,
    tooCoarse,
    baseline: round(baseline),
    current: current ? round(current.value) : null,
    previous: previous ? round(previous.value) : null,
    velocity,
    previousVelocity,
    acceleration,
    episodeStart,
    episodeStatus,
    latestAt: latest ? new Date(latest.t).toISOString() : null,
    peak,
    observedFraction: current ? current.samples / Math.max(1, Math.round(windowMs / (grain || windowMs))) : null,
    direction: direction(current?.value, baseline),
  };
}

function evidenceFromSeries(series, sourceName) {
  const latest = series.points.at(-1);
  if (!latest) return [];
  return [{
    source: sourceName,
    title: series.label,
    publisher: sourceName,
    metric: series.metric,
    value: round(latest.value),
    unit: series.unit,
    timestamp: new Date(latest.t).toISOString(),
    collectedAt: null,
    reference: null,
    note: series.tooCoarse ? 'Series is coarser than the selected window, so it was not used for velocity.' : 'Observed series point. Gaps were not filled with zeroes.',
  }];
}

function buildExplanation(item) {
  const allowed = [];
  const sentences = [];
  const add = (sentence, numbers = []) => {
    sentences.push(sentence);
    allowed.push(...numbers.filter((value) => value != null));
  };
  add(`${item.name} was measured from ${item.sources.join(', ') || 'available sources'}.`, [item.sources.length]);
  if (item.current != null && item.baseline != null) {
    add(`The latest window total was ${item.current} ${item.unit}, against a historical baseline of ${item.baseline} ${item.unit}.`, [item.current, item.baseline]);
  } else {
    add('A historical baseline was not available, so growth was not converted into a percentage.', []);
  }
  if (item.velocity == null) add('Growth velocity is unavailable because the baseline, volume threshold, or window resolution was not met.', []);
  else add(`Growth velocity scored ${item.velocity} on a 0 to 1 scale after minimum-volume protection.`, [item.velocity]);
  if (item.acceleration == null) add('Acceleration is unavailable because there are not enough historical observations.', []);
  else add(`Acceleration scored ${item.acceleration} on a 0 to 1 scale, where 0.5 means the rate of growth is flat.`, [item.acceleration]);
  if (item.independentSources != null) add(`${item.independentSources} independent source family confirmed measurable movement.`, [item.independentSources]);
  if (item.duplicateCount) add(`${item.duplicateCount} duplicate or syndicated records were collapsed and did not increase confirmation.`, [item.duplicateCount]);
  if (!item.geographicAvailable) add('Geographic strength is unavailable for this result.', []);
  if (item.saturationState === 'INSUFFICIENT EVIDENCE') add('Saturation is insufficient evidence. No competition percentage was estimated.', []);
  add('This is not a prediction of future virality.', []);
  return groundExplanation(sentences.join(' '), allowed);
}

function qualifies(item) {
  if (!item.measurable) return false;
  if (['cooling', 'expired', 'stable'].includes(item.lifecycle)) return false;
  if (item.velocity == null && item.acceleration == null) return false;
  if ((item.samplePoints ?? 0) < 4) return false;
  if (item.velocity != null && item.velocity >= 0.28) return true;
  return item.acceleration != null && item.acceleration >= 0.67 && item.velocity != null && item.velocity >= 0.2;
}

export function buildAnalysis({
  query,
  country = 'WORLDWIDE',
  language = 'en',
  timeWindow = '24h',
  sourceResults = [],
  weights = DEFAULT_WEIGHTS,
  earlyThresholds = DEFAULT_EARLY_SIGNAL,
  now = Date.now(),
}) {
  const windowMs = WINDOW_MS[timeWindow] ?? WINDOW_MS['24h'];
  const active = sourceResults.filter((source) => source.signals?.length || source.series?.length);
  const failedSources = sourceResults.filter((source) => !source.signals?.length && !source.series?.length);
  if (!active.length) {
    return {
      ok: false,
      code: 'INSUFFICIENT_EVIDENCE',
      message: "We couldn't collect enough reliable evidence to analyze this topic.",
      results: [],
      observations: [],
      topicAssessment: null,
      stats: { signalsCollected: 0, duplicatesRemoved: 0, clusters: 0, qualified: 0 },
    };
  }

  const rawSignals = active.flatMap((source) => (source.signals ?? []).map((signal) => ({
    ...signal,
    source: signal.source || source.id,
    title: signal.title || signal.topic,
    publisherId: signal.publisherId || signal.authorOrPublisher || null,
  })));
  const confirmation = independentConfirmations(rawSignals);
  const deduped = deduplicateSignals(rawSignals);
  const clusters = clusterSignals(deduped, { query });
  const observations = clusters
    .filter((cluster) => cluster.items.length >= 2)
    .slice(0, 12)
    .map((cluster) => ({
      name: cluster.canonicalName,
      aliases: cluster.aliases,
      evidenceCount: cluster.items.length,
      publishers: [...new Set(cluster.items.flatMap((item) => item.independentSourceIds ?? []).concat(cluster.items.map((item) => item.publisherId).filter(Boolean)))],
      score: null,
      scoreStatus: 'insufficient_evidence',
      reason: 'Acceleration unavailable — this cluster has no historical series of its own, so it was not ranked as a trend.',
      evidence: cluster.items.slice(0, 5).map((item) => ({
        source: item.source,
        title: item.title,
        publisher: item.publisherId ?? item.authorOrPublisher ?? null,
        metric: item.metric,
        value: item.metricValue ?? null,
        unit: item.metricUnit ?? null,
        timestamp: item.timestamp,
        collectedAt: item.collectedAt ?? null,
        reference: item.reference ?? null,
      })),
    }));

  const seriesBundles = active.flatMap((source) => (source.series ?? []).map((series) => ({
    ...assessSeries(series, { windowMs, now }),
    sourceId: source.id,
    sourceName: source.name,
    quality: source.quality ?? 0.6,
  }))).filter((series) => series.metric !== 'wikipedia_rank');

  const geographic = [];
  for (const source of active) {
    for (const series of source.geographicSeries ?? []) {
      const point = series.points?.[0];
      if (!series.country || !isNumber(point?.rank) || !isNumber(point?.value)) continue;
      const strength = Number((1 - Math.log1p(point.rank - 1) / Math.log1p(1000)).toFixed(4));
      geographic.push({ country: series.country, strength, sampleSize: point.value, method: series.geographicMethod, rank: point.rank });
    }
  }
  const geographicValue = calculateGeographicStrength(geographic, country);
  const geographicAvailable = geographicValue != null;

  const groups = new Map();
  for (const series of seriesBundles) {
    const key = series.article ? normalizeTopic(series.article) : `query:${series.sourceId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(series);
  }
  if (seriesBundles.some((series) => !series.article)) {
    const parent = seriesBundles.filter((series) => !series.article || normalizeTopic(series.article) === normalizeTopic(query));
    groups.set(`query:${normalizeTopic(query)}`, parent);
  }

  const candidates = [];
  for (const [key, bundle] of groups) {
    const usable = bundle.filter((series) => !series.tooCoarse && (series.velocity != null || series.acceleration != null || series.points.length >= 4));
    if (!usable.length) continue;
    const primary = usable.slice().sort((a, b) => (b.points.length - a.points.length))[0];
    const sources = [...new Set(usable.map((series) => series.sourceId))];
    const sourceObjects = sources.map((id) => {
      const match = active.find((source) => source.id === id);
      return { id, independent: true, quality: match?.quality ?? primary.quality ?? 0.6 };
    });
    const crossSource = calculateCrossSourceConfirmation(sourceObjects);
    const directions = usable.map((series) => series.direction).filter(Boolean);
    const conflicts = directions.includes('up') && directions.includes('down') ? 1 : 0;
    const hoursSinceEpisode = primary.episodeStart ? (now - new Date(primary.episodeStart).getTime()) / 3_600_000 : null;
    const freshness = calculateFreshness(hoursSinceEpisode);
    const hoursSinceUpdate = primary.latestAt ? (now - new Date(primary.latestAt).getTime()) / 3_600_000 : null;
    const ratioToPeak = primary.peak && primary.current ? primary.current / primary.peak : null;
    const features = {
      velocity: primary.velocity,
      acceleration: primary.acceleration,
      freshness,
      crossSource,
      saturation: null,
      geography: key.startsWith('query:') ? geographicValue : null,
    };
    const saturation = null;
    const scored = scoreWithProvenance(features, weights);
    const historicalHours = primary.points.length >= 2 ? (primary.points.at(-1).t - primary.points[0].t) / 3_600_000 : null;
    const sampleSize = primary.points.length + deduped.filter((signal) => sources.includes(signal.source)).length;
    const confidence = calculateConfidence({
      sourceQuality: sourceObjects.reduce((sum, source) => sum + source.quality, 0) / sourceObjects.length,
      independentSources: sources.length,
      historicalHours,
      signalAgreement: conflicts ? 0.35 : directions.length ? 0.8 : null,
      sampleSize,
      dataCompleteness: (active.length / Math.max(sourceResults.length, 1)) * (Object.values(features).filter(isNumber).length / 6),
      conflicts,
    });
    const lifecycle = determineLifecycle({
      velocity: primary.velocity,
      previousVelocity: primary.previousVelocity,
      acceleration: primary.acceleration,
      hoursSinceUpdate,
      ratioToPeak,
    });
    const peakVelocity = primary.peak != null && isNumber(primary.baseline)
      ? calculateVelocity({ current: primary.peak, baseline: primary.baseline })
      : primary.velocity;
    const decay = calculateMomentumDecay({
      currentVelocity: primary.velocity,
      previousVelocity: primary.previousVelocity,
      peakVelocity,
      hoursSinceUpdate,
    });
    const early = isEarlySignal({
      hoursSinceDetection: hoursSinceEpisode,
      acceleration: primary.acceleration,
      confidence: confidence.confidence,
      saturation,
      independentSources: sources.length,
      sampleSize,
      score: scored.score,
    }, earlyThresholds);
    const name = primary.article || query;
    const related = clusters
      .map((cluster) => cluster.canonicalName)
      .filter((label) => normalizeTopic(label) !== normalizeTopic(name))
      .slice(0, 5);
    const item = {
      trendId: `topic:${normalizeTopic(name)}`,
      episodeId: primary.episodeStart ? `episode:${normalizeTopic(name)}:${primary.episodeStart}` : null,
      name,
      aliases: related.slice(0, 3),
      queryTopic: key.startsWith('query:') || normalizeTopic(name) === normalizeTopic(query),
      sources,
      sourceNames: sources.map((id) => active.find((source) => source.id === id)?.name ?? id),
      unit: primary.unit,
      metric: primary.metric,
      current: primary.current,
      baseline: primary.baseline,
      previous: primary.previous,
      velocity: primary.velocity,
      previousVelocity: primary.previousVelocity,
      acceleration: primary.acceleration,
      accelerationStatus: primary.acceleration == null ? 'unavailable' : 'available',
      freshness: episodeFreshnessLabel(hoursSinceEpisode),
      freshnessScore: freshness,
      hoursSinceEpisode,
      episodeStart: primary.episodeStart,
      episodeStatus: primary.episodeStatus,
      saturation: saturation,
      saturationState: saturationLabel(saturation),
      geography: geographicValue,
      geographicAvailable: key.startsWith('query:') ? geographicAvailable : false,
      regions: key.startsWith('query:') ? geographic.map((region) => ({
        country: region.country,
        label: ISO_COUNTRY[region.country] ?? region.country,
        strength: region.strength,
        sampleSize: region.sampleSize,
        rank: region.rank,
        method: region.method,
      })) : [],
      independentSources: sources.length,
      samplePoints: primary.points.length,
      sampleSize,
      duplicateCount: confirmation.duplicatesRemoved,
      score: scored.score,
      scoreStatus: scored.status,
      scoreCoverage: scored.coverage,
      scoreVersion: SCORE_VERSION,
      provenance: scored.dimensions,
      confidence: confidence.confidence,
      confidenceLabel: confidence.label,
      lifecycle,
      earlySignal: early,
      earlySignalReason: early ? 'Thresholds for age, acceleration, confidence, sources, sample size, saturation, and score were met.' : 'Early Signal was not applied. At least one required threshold was not met, or required evidence was unavailable.',
      decay,
      ratioToPeak: round(ratioToPeak, 4),
      latestAt: primary.latestAt,
      firstDetectedAt: primary.episodeStart,
      curve: primary.totals.slice(-30).map((point) => ({ t: new Date(point.t).toISOString(), value: round(point.value), metric: primary.metric })),
      evidence: [
        ...usable.flatMap((series) => evidenceFromSeries(series, series.sourceName)),
        ...deduped.filter((signal) => sources.includes(signal.source)).slice(0, 8).map((signal) => ({
          source: signal.source,
          title: signal.title,
          publisher: signal.publisherId ?? signal.authorOrPublisher ?? null,
          metric: signal.metric,
          value: signal.metricValue ?? null,
          unit: signal.metricUnit ?? null,
          timestamp: signal.timestamp,
          collectedAt: signal.collectedAt ?? null,
          reference: signal.reference ?? null,
        })),
      ],
      limitations: [
        primary.tooCoarse ? 'The source granularity is coarser than the selected window.' : null,
        primary.metric === 'wikipedia_pageviews' ? 'Pageviews are Wikipedia attention, not search volume.' : null,
        primary.metric === 'relative_interest' ? 'Relative interest was not converted into search volume.' : null,
        primary.metric === 'article_count' ? 'Article counts are from the provider sample after duplicate collapse.' : null,
        country !== 'WORLDWIDE' && !geographicAvailable ? 'Geographic strength unavailable.' : null,
      ].filter(Boolean),
      related,
      measurable: primary.velocity != null || primary.acceleration != null,
      calculatedAt: new Date(now).toISOString(),
    };
    item.explanation = buildExplanation(item);
    item.why = item.explanation.text.split(/(?<=[.!?])\s+/).filter(Boolean);
    candidates.push(item);
  }

  const unique = [];
  for (const item of candidates) {
    const existing = unique.find((candidate) => candidate.trendId === item.trendId);
    if (!existing) unique.push(item);
    else if (item.sources.length > existing.sources.length) unique.splice(unique.indexOf(existing), 1, item);
  }
  const topicAssessment = unique.find((item) => item.queryTopic) ?? null;
  const results = unique
    .filter(qualifies)
    .sort((a, b) => (b.earlySignal - a.earlySignal) || ((b.score ?? -1) - (a.score ?? -1)) || ((b.confidence ?? -1) - (a.confidence ?? -1)) || ((b.velocity ?? -1) - (a.velocity ?? -1)))
    .slice(0, 20)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  const unavailableNotes = failedSources.map((source) => `${source.name}: ${source.status.replaceAll('_', ' ').toLowerCase()}${source.limitations?.[0] ? ` — ${source.limitations[0]}` : ''}`);
  let message = null;
  if (!results.length) message = 'No strong acceleration detected yet.';
  if (unavailableNotes.length) {
    const extra = unavailableNotes.join(' ');
    message = message ? `${message} ${extra}` : extra;
  }
  return {
    ok: true,
    code: results.length ? 'READY' : 'NO_ACCELERATION',
    message,
    results,
    observations,
    topicAssessment: topicAssessment && !results.some((item) => item.trendId === topicAssessment.trendId) ? topicAssessment : null,
    stats: {
      signalsCollected: rawSignals.length,
      duplicatesRemoved: confirmation.duplicatesRemoved,
      clusters: clusters.length,
      qualified: results.length,
    },
    weights,
    earlyThresholds,
  };
}

export { calculateSaturationOpportunity };

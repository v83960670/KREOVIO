import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WEIGHTS,
  calculateAcceleration,
  calculateAccelerationFromIncrements,
  calculateConfidence,
  calculateFreshness,
  calculateGeographicStrength,
  calculateMomentumDecay,
  calculateSaturationOpportunity,
  calculateSeriesAcceleration,
  calculateTrendScore,
  calculateVelocity,
  classifySourceFreshness,
  clusterSignals,
  deduplicateSignals,
  determineLifecycle,
  getSupportedWindows,
  groundExplanation,
  independentConfirmations,
  isEarlySignal,
  normalizeTopic,
  standardizeSignal,
} from './trend-engine.mjs';

test('normalizes topic aliases without collapsing distinct words', () => {
  assert.equal(normalizeTopic('  AI—Browser Agents! '), 'ai browser agents');
  assert.equal(normalizeTopic('Café / Moda'), 'cafe moda');
  assert.notEqual(normalizeTopic('agentic commerce'), normalizeTopic('AI commerce'));
});

test('standardized signals preserve observed fields and do not invent missing metrics', () => {
  assert.equal(standardizeSignal({ source: 'News' }), null);
  const signal = standardizeSignal({
    source: 'News', topic: 'AI assistants', timestamp: '2026-01-01T12:00:00Z',
    reference: 'https://example.test/story?utm_source=feed&api_key=secret&id=4',
    metricValue: 'not a number', country: 'in', metadata: ['not-an-object'],
  });
  assert.equal(signal.source, 'news');
  assert.equal(signal.metricValue, null);
  assert.equal(signal.country, 'IN');
  assert.equal(signal.reference, 'https://example.test/story?id=4');
  assert.deepEqual(signal.metadata, {});
});

test('deduplicates mirror headlines while retaining independent evidence references', () => {
  const merged = deduplicateSignals([
    { title: 'New AI browser agents are changing web search', source: 'news', publisherId: 'publisher-a', reference: 'https://news.example/story?utm_source=feed', timestamp: '2026-01-01T10:00:00Z' },
    { title: 'New AI browser agents are changing web search', source: 'news', publisherId: 'publisher-b', reference: 'https://mirror.example/story', timestamp: '2026-01-01T11:00:00Z' },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].independentSourceIds.sort(), ['publisher-a', 'publisher-b']);
  assert.equal(merged[0].duplicateCount, 1);
});

test('velocity rejects tiny-volume percentage spikes and scales measurable growth', () => {
  assert.equal(calculateVelocity({ current: 4, baseline: 1 }), null);
  assert.ok(calculateVelocity({ current: 300, baseline: 100 }) > calculateVelocity({ current: 100, baseline: 100 }));
  assert.ok(calculateVelocity({ current: 300, baseline: 100 }) <= 1);
});

test('decay, saturation opportunity and geography use only measurable inputs', () => {
  assert.equal(calculateMomentumDecay({ currentVelocity: 0.2, peakVelocity: 0 }), null);
  const cooling = calculateMomentumDecay({ currentVelocity: 0.2, previousVelocity: 0.6, peakVelocity: 0.8, hoursSinceUpdate: 90 });
  const fresh = calculateMomentumDecay({ currentVelocity: 0.75, previousVelocity: 0.7, peakVelocity: 0.8, hoursSinceUpdate: 1 });
  assert.ok(cooling > fresh);
  assert.equal(calculateSaturationOpportunity({ currentInterest: 2, currentCoverage: 1, categoryMedianCoverage: 4 }), null);
  const room = calculateSaturationOpportunity({ currentInterest: 100, currentCoverage: 3, categoryMedianCoverage: 20 });
  const crowded = calculateSaturationOpportunity({ currentInterest: 100, currentCoverage: 100, categoryMedianCoverage: 20 });
  assert.ok(room > crowded);
  assert.equal(calculateGeographicStrength([], 'IN'), null);
  assert.equal(calculateGeographicStrength([{ country: 'IN', strength: 0.8, sampleSize: 10 }], 'IN'), 0.8);
  assert.ok(calculateGeographicStrength([
    { country: 'IN', strength: 0.8, sampleSize: 10 },
    { country: 'US', strength: 0.6, sampleSize: 10 },
    { country: 'GB', strength: 0.7, sampleSize: 10 },
    { country: 'CA', strength: 0.7, sampleSize: 10 },
  ]) > 0.5);
});

test('trend score withholds a headline number when too many dimensions are missing', () => {
  const insufficient = calculateTrendScore({ velocity: 0.9, crossSource: 0.8 });
  assert.equal(insufficient.score, null);
  assert.equal(insufficient.status, 'insufficient_evidence');
  const complete = calculateTrendScore({ velocity: 0.9, crossSource: 0.8, acceleration: 0.8, freshness: 0.9, saturation: 0.7, geography: 0.6 });
  assert.equal(complete.version, 'KTS-1.0');
  assert.ok(complete.score > 0 && complete.score <= 100);
  assert.equal(complete.coverage, 1);
});

test('confidence remains distinct and falls when evidence is sparse or conflicting', () => {
  const strong = calculateConfidence({ sourceQuality: 0.9, independentSources: 4, historicalHours: 24 * 90, signalAgreement: 0.9, sampleSize: 100, dataCompleteness: 1 });
  const weak = calculateConfidence({ sourceQuality: 0.5, independentSources: 1, historicalHours: 3, signalAgreement: 0.5, sampleSize: 3, dataCompleteness: 0.5, conflicts: 3 });
  assert.ok(strong.confidence > weak.confidence);
  assert.equal(strong.label, 'high');
  assert.equal(weak.label, 'low');
});

test('freshness, lifecycle, early-signal thresholds and history-supported windows are bounded', () => {
  assert.equal(calculateFreshness(2), 1);
  assert.ok(calculateFreshness(100) < calculateFreshness(12));
  assert.equal(determineLifecycle({ velocity: 0.8, previousVelocity: 0.4, acceleration: 0.8 }), 'accelerating');
  assert.equal(determineLifecycle({ velocity: 0.55, previousVelocity: 0.53 }), 'stable');
  assert.equal(determineLifecycle({ velocity: 0.7, previousVelocity: 0.69, ratioToPeak: 0.9 }), 'peaking');
  assert.equal(determineLifecycle({ velocity: 0.15, previousVelocity: 0.5, hoursSinceUpdate: 120 }), 'cooling');
  assert.equal(determineLifecycle({ expired: true }), 'expired');
  assert.equal(isEarlySignal({ hoursSinceDetection: 12, acceleration: 0.8, confidence: 85, saturation: 0.2, independentSources: 3, sampleSize: 20, score: 72 }), true);
  assert.equal(isEarlySignal({ hoursSinceDetection: 12, acceleration: 0.8, confidence: 50, saturation: 0.2, independentSources: 3, sampleSize: 20, score: 72 }), false);
  assert.deepEqual(getSupportedWindows(7).map(({ id }) => id), ['6h', '24h', '3d', '7d']);
  assert.equal(Object.values(DEFAULT_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 100);
});

test('1 to 4 does not become extreme growth velocity', () => {
  assert.equal(calculateVelocity({ current: 4, baseline: 1 }), null);
});

test('rising increments accelerate more than a flat growth series', () => {
  const accelerating = calculateAccelerationFromIncrements([4, 12, 35]);
  const flat = calculateAccelerationFromIncrements([20, 20, 20]);
  assert.ok(accelerating > flat);
  assert.ok(accelerating > 0.5);
  assert.equal(flat, 0.5);
  assert.ok(calculateSeriesAcceleration([10, 14, 26, 61]) > calculateSeriesAcceleration([10, 30, 50, 70]));
  assert.equal(calculateAccelerationFromIncrements([4, 12]), null);
});

test('one hundred syndicated copies are one confirmation, not one hundred', () => {
  const copies = Array.from({ length: 100 }, (_, index) => ({
    title: 'Shared syndicated headline about a market move',
    source: 'news',
    publisherId: `mirror-${index}`,
    reference: `https://mirror${index}.example/story`,
    timestamp: '2026-10-04T00:00:00Z',
  }));
  const result = independentConfirmations(copies);
  assert.equal(result.stories, 1);
  assert.equal(result.independentCount, 1);
  assert.equal(result.duplicatesRemoved, 99);
});

test('topic clustering does not merge AI agents with AI regulation', () => {
  const clusters = clusterSignals([
    { title: 'AI browser agents are spreading' },
    { title: 'Autonomous browser agents arrive' },
    { title: 'AI regulation proposal advances' },
  ], { query: 'artificial intelligence' });
  const names = clusters.map((cluster) => cluster.canonicalName.toLowerCase());
  assert.equal(clusters.length, 2);
  assert.ok(names.some((name) => name.includes('agent')));
  assert.ok(names.some((name) => name.includes('regulation')));
});

test('explanations cannot introduce unsupported numbers', () => {
  const grounded = groundExplanation('Coverage rose by 82 percent. The baseline was 10.', [10]);
  assert.equal(grounded.text, 'The baseline was 10.');
  assert.equal(grounded.removed.length, 1);
});

test('freshness thresholds are per source, not universal', () => {
  const recentNews = classifySourceFreshness({ ageSeconds: 30 * 60, connectorStatus: 'CONNECTED', thresholds: { liveSec: 20 * 60, nearLiveSec: 2 * 60 * 60, recentSec: 12 * 60 * 60, staleSec: 36 * 60 * 60 } });
  const sameAgeWiki = classifySourceFreshness({ ageSeconds: 30 * 60, connectorStatus: 'CONNECTED', thresholds: { liveSec: 26 * 60 * 60, nearLiveSec: 40 * 60 * 60, recentSec: 72 * 60 * 60, staleSec: 8 * 24 * 60 * 60 } });
  assert.equal(recentNews, 'NEAR LIVE');
  assert.equal(sameAgeWiki, 'LIVE');
  assert.equal(classifySourceFreshness({ ageSeconds: null, connectorStatus: 'NOT_CONFIGURED' }), 'NOT CONFIGURED');
});

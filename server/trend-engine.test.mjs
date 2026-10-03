import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WEIGHTS,
  calculateAcceleration,
  calculateConfidence,
  calculateFreshness,
  calculateGeographicStrength,
  calculateMomentumDecay,
  calculateSaturationOpportunity,
  calculateTrendScore,
  calculateVelocity,
  deduplicateSignals,
  determineLifecycle,
  getSupportedWindows,
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysis } from './analyze.mjs';

function seriesSource(id, points, extra = {}) {
  return {
    id,
    name: id,
    status: 'CONNECTED',
    quality: 0.8,
    signals: [],
    series: [{
      id: `${id}-series`,
      label: `${id} article count`,
      metric: 'article_count',
      unit: 'articles',
      country: extra.country ?? null,
      geographic: false,
      points,
    }],
    limitations: [],
    ...extra,
  };
}

test('one unavailable source lowers confidence without discarding the search', () => {
  const points = [];
  for (let day = 0; day < 8; day += 1) {
    points.push({ t: new Date(Date.UTC(2026, 8, 20 + day)).toISOString(), value: 40 + day * 12 });
  }
  const full = buildAnalysis({
    query: 'browser agents',
    country: 'WORLDWIDE',
    language: 'en',
    timeWindow: '24h',
    now: Date.parse('2026-09-28T00:00:00Z'),
    sourceResults: [
      seriesSource('news', points),
      seriesSource('wikipedia', points.map((point) => ({ ...point, value: point.value * 3 }))),
      { id: 'reddit', name: 'Reddit', status: 'CONNECTED', signals: [], series: [], limitations: [] },
    ],
  });
  const missing = buildAnalysis({
    query: 'browser agents',
    country: 'WORLDWIDE',
    language: 'en',
    timeWindow: '24h',
    now: Date.parse('2026-09-28T00:00:00Z'),
    sourceResults: [
      seriesSource('news', points),
      { id: 'reddit', name: 'Reddit', status: 'UNAVAILABLE', signals: [], series: [], limitations: ['Reddit did not respond.'] },
      { id: 'wikipedia', name: 'Wikipedia attention', status: 'UNAVAILABLE', signals: [], series: [], limitations: ['Wikipedia did not respond.'] },
    ],
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.results.some((result) => result.name === 'Reddit'), false);
  assert.ok(missing.message.includes('Reddit'));
  if (full.results[0] && missing.results[0]) assert.ok(missing.results[0].confidence <= full.results[0].confidence);
  assert.equal(JSON.stringify(missing).includes('Math.random'), false);
});

test('all sources unavailable returns no fabricated trends and is not a successful analysis', () => {
  const analysis = buildAnalysis({
    query: 'Artificial Intelligence',
    country: 'IN',
    language: 'en',
    timeWindow: '24h',
    sourceResults: [
      { id: 'news', name: 'News', status: 'UNAVAILABLE', signals: [], series: [], limitations: ['Network unavailable.'] },
      { id: 'youtube', name: 'YouTube', status: 'NOT_CONFIGURED', signals: [], series: [], limitations: ['Key missing.'] },
      { id: 'reddit', name: 'Reddit', status: 'NOT_CONFIGURED', signals: [], series: [], limitations: ['OAuth missing.'] },
      { id: 'search', name: 'Search interest', status: 'NOT_CONFIGURED', signals: [], series: [], limitations: ['Provider missing.'] },
    ],
  });
  assert.equal(analysis.ok, false);
  assert.equal(analysis.results.length, 0);
  assert.equal(analysis.code, 'INSUFFICIENT_EVIDENCE');
  assert.match(analysis.message, /enough reliable evidence/);
  assert.equal(JSON.stringify(analysis).includes('91'), false);
});

test('global measurements are not relabeled as India strength', () => {
  const points = [20, 22, 21, 24, 40, 70, 110].map((value, index) => ({
    t: new Date(Date.UTC(2026, 8, 20 + index)).toISOString(),
    value,
  }));
  const analysis = buildAnalysis({
    query: 'browser agents',
    country: 'IN',
    language: 'en',
    timeWindow: '24h',
    now: Date.parse('2026-09-27T00:00:00Z'),
    sourceResults: [seriesSource('news', points, { country: null })],
  });
  const assessment = analysis.topicAssessment ?? analysis.results[0];
  assert.equal(assessment.geographicAvailable, false);
  assert.ok(assessment.limitations.some((line) => /Geographic strength unavailable/.test(line)));
});

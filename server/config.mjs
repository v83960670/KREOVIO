export const SCORE_VERSION = 'KTS-1.0';

export const WINDOW_MS = Object.freeze({
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});

export const GDELT_TIMESPAN = Object.freeze({
  '6h': '6h',
  '24h': '24h',
  '3d': '72h',
  '7d': '7d',
  '30d': '1m',
  '90d': '3m',
});

/** Timeline span used for baseline. Longer than the user window when the provider allows it. */
export const GDELT_HISTORY_SPAN = Object.freeze({
  '6h': '7d',
  '24h': '14d',
  '3d': '1m',
  '7d': '1m',
  '30d': '3m',
  '90d': '3m',
});

export const FRESHNESS_THRESHOLDS = Object.freeze({
  search: { liveSec: 15 * 60, nearLiveSec: 60 * 60, recentSec: 6 * 60 * 60, staleSec: 24 * 60 * 60 },
  youtube: { liveSec: 15 * 60, nearLiveSec: 60 * 60, recentSec: 6 * 60 * 60, staleSec: 24 * 60 * 60 },
  reddit: { liveSec: 15 * 60, nearLiveSec: 60 * 60, recentSec: 6 * 60 * 60, staleSec: 24 * 60 * 60 },
  news: { liveSec: 20 * 60, nearLiveSec: 2 * 60 * 60, recentSec: 12 * 60 * 60, staleSec: 36 * 60 * 60 },
  wikipedia: { liveSec: 26 * 60 * 60, nearLiveSec: 40 * 60 * 60, recentSec: 72 * 60 * 60, staleSec: 8 * 24 * 60 * 60 },
  hackernews: { liveSec: 15 * 60, nearLiveSec: 2 * 60 * 60, recentSec: 12 * 60 * 60, staleSec: 36 * 60 * 60 },
});

export const SOURCE_CATALOG = Object.freeze([
  { id: 'search', name: 'Search interest', independentGroup: 'search', weight: 0.8 },
  { id: 'youtube', name: 'YouTube', independentGroup: 'youtube', weight: 0.75 },
  { id: 'reddit', name: 'Reddit', independentGroup: 'reddit', weight: 0.65 },
  { id: 'news', name: 'News', independentGroup: 'news', weight: 0.8 },
  { id: 'wikipedia', name: 'Wikipedia attention', independentGroup: 'wikipedia', weight: 0.55 },
  { id: 'hackernews', name: 'Hacker News', independentGroup: 'hackernews', weight: 0.4 },
]);

export const ISO_COUNTRY = Object.freeze({
  IN: 'India', US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia',
  DE: 'Germany', FR: 'France', BR: 'Brazil', JP: 'Japan', KR: 'South Korea', ID: 'Indonesia',
});

/** GDELT sourcecountry operator uses FIPS-style codes, which differ from ISO for some countries. */
export const GDELT_COUNTRY = Object.freeze({
  IN: 'IN', US: 'US', GB: 'UK', CA: 'CA', AU: 'AS', DE: 'GM', FR: 'FR', BR: 'BR', JP: 'JA', KR: 'KS', ID: 'ID',
});

export const LANGUAGE_NAME = Object.freeze({
  en: 'english', hi: 'hindi', bn: 'bengali', es: 'spanish', pt: 'portuguese', fr: 'french', de: 'german', ja: 'japanese', ko: 'korean',
});

export const WIKI_PROJECT = Object.freeze({
  en: 'en.wikipedia', hi: 'hi.wikipedia', bn: 'bn.wikipedia', es: 'es.wikipedia', pt: 'pt.wikipedia',
  fr: 'fr.wikipedia', de: 'de.wikipedia', ja: 'ja.wikipedia', ko: 'ko.wikipedia',
});

export function envFlag(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function selectedSourceIds(sourceFilter = 'all') {
  if (!sourceFilter || sourceFilter === 'all') return SOURCE_CATALOG.map((source) => source.id);
  return SOURCE_CATALOG.some((source) => source.id === sourceFilter) ? [sourceFilter] : [];
}

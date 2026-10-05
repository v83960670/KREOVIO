import { createHash } from 'node:crypto';
import {
  FRESHNESS_THRESHOLDS,
  GDELT_COUNTRY,
  GDELT_HISTORY_SPAN,
  GDELT_TIMESPAN,
  ISO_COUNTRY,
  LANGUAGE_NAME,
  WIKI_PROJECT,
  WINDOW_MS,
  envFlag,
} from '../config.mjs';
import { classifySourceFreshness } from '../trend-engine.mjs';
import { parseJson, requestText, withGdeltSpacing } from './client.mjs';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function freshness(sourceId, status, latestSignalAt, collectedAt) {
  const latest = latestSignalAt ? new Date(latestSignalAt).getTime() : null;
  const ageSeconds = latest ? Math.max(0, Math.round((Date.now() - latest) / 1000)) : null;
  return {
    source: sourceId,
    status,
    liveStatus: classifySourceFreshness({ ageSeconds, connectorStatus: status, thresholds: FRESHNESS_THRESHOLDS[sourceId] }),
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: status === 'CONNECTED' || (status === 'DEGRADED' && latestSignalAt) ? collectedAt : null,
    latestSignalAt: latestSignalAt ?? null,
    dataAgeSeconds: ageSeconds,
    thresholds: FRESHNESS_THRESHOLDS[sourceId],
  };
}

function notConfigured(sourceId, name, note) {
  const collectedAt = new Date().toISOString();
  return {
    id: sourceId,
    name,
    status: 'NOT_CONFIGURED',
    signals: [],
    series: [],
    limitations: [note],
    requests: 0,
    estimatedCostUsd: 0,
    latencyMs: 0,
    freshness: { ...freshness(sourceId, 'NOT_CONFIGURED', null, collectedAt), lastSuccessAt: null, liveStatus: 'NOT CONFIGURED' },
  };
}

function failed(sourceId, name, status, code, note, latencyMs = 0) {
  const collectedAt = new Date().toISOString();
  return {
    id: sourceId,
    name,
    status,
    signals: [],
    series: [],
    limitations: [note],
    errorCode: code,
    requests: 0,
    estimatedCostUsd: 0,
    latencyMs,
    freshness: { ...freshness(sourceId, status, null, collectedAt), lastSuccessAt: null },
  };
}

export function gdeltDate(value) {
  const match = String(value ?? '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

export function wikiDate(value) {
  const match = String(value ?? '').match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00Z`;
}

function languageCodeFromName(value) {
  const name = String(value ?? '').toLowerCase();
  return Object.entries(LANGUAGE_NAME).find(([, label]) => label === name)?.[0] ?? null;
}

export function buildGdeltQuery({ query, country, language }) {
  const phrase = `"${String(query).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
  const parts = [phrase];
  if (country && country !== 'WORLDWIDE') {
    const code = GDELT_COUNTRY[country];
    if (!code) return { query: null, limitation: `GDELT has no configured country operator for ${country}.` };
    parts.push(`sourcecountry:${code}`);
  }
  if (language && LANGUAGE_NAME[language]) parts.push(`sourcelang:${LANGUAGE_NAME[language]}`);
  return { query: parts.join(' '), limitation: null };
}

function gdeltRateLimited(text) {
  return /please limit requests|rate limit/i.test(text ?? '');
}

export async function collectNews({ query, country = 'WORLDWIDE', language = 'en', timeWindow = '24h' }) {
  const name = 'News';
  const built = buildGdeltQuery({ query, country, language });
  if (!built.query) return failed('news', name, 'UNAVAILABLE', 'GEOGRAPHY_UNSUPPORTED', built.limitation);
  const collectedAt = new Date().toISOString();
  const listSpan = GDELT_TIMESPAN[timeWindow] ?? '24h';
  const historySpan = GDELT_HISTORY_SPAN[timeWindow] ?? '7d';
  const encoded = encodeURIComponent(built.query);
  const listUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encoded}&mode=ArtList&maxrecords=75&format=json&timespan=${listSpan}&sort=datedesc`;
  const timelineUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encoded}&mode=timelinevolraw&format=json&timespan=${historySpan}`;
  const started = Date.now();
  const listResponse = await withGdeltSpacing(() => requestText(listUrl, { timeoutMs: 18_000 }));
  const timelineResponse = listResponse.status === 'RATE_LIMITED' || listResponse.code === 'NETWORK_UNAVAILABLE' || gdeltRateLimited(listResponse.text)
    ? listResponse
    : await withGdeltSpacing(() => requestText(timelineUrl, { timeoutMs: 18_000 }));
  const latencyMs = Date.now() - started;
  if (!listResponse.ok && !timelineResponse.ok) {
    const status = listResponse.status === 'RATE_LIMITED' || gdeltRateLimited(listResponse.text) ? 'RATE_LIMITED' : listResponse.status;
    const note = status === 'RATE_LIMITED'
      ? 'GDELT asked Kreovio to slow down. No substitute news records were created.'
      : 'The GDELT news dataset could not be reached. No substitute records were created.';
    return { ...failed('news', name, status, listResponse.code || 'GDELT_UNAVAILABLE', note, latencyMs), requests: 2 };
  }
  const limitations = [
    'News coverage comes from the GDELT DOC 2.0 public dataset, a monitored sample of online news, not every article on the internet.',
    'sourcecountry filters publisher country. It is not proof of audience location.',
    'Relative GDELT volume is an article-count series. It is not search volume.',
  ];
  if (built.limitation) limitations.push(built.limitation);
  const signals = [];
  let latest = null;
  if (listResponse.ok && !gdeltRateLimited(listResponse.text)) {
    const parsed = parseJson(listResponse.text);
    const articles = parsed.json?.articles;
    if (!Array.isArray(articles)) {
      limitations.push(parsed.error === 'NOT_JSON' ? 'GDELT article list was not JSON, so those records were ignored.' : 'GDELT returned no article list for this query.');
    } else {
      for (const article of articles) {
        const timestamp = gdeltDate(article.seendate);
        const title = typeof article.title === 'string' ? article.title.trim() : '';
        if (!timestamp || !title) continue;
        const articleCountry = typeof article.sourcecountry === 'string' ? article.sourcecountry.toUpperCase() : null;
        if (country !== 'WORLDWIDE' && articleCountry && articleCountry !== country && articleCountry !== GDELT_COUNTRY[country]) continue;
        const articleLanguage = languageCodeFromName(article.language);
        if (articleLanguage && articleLanguage !== language) continue;
        const domain = typeof article.domain === 'string' ? article.domain.toLowerCase() : null;
        signals.push({
          source: 'news',
          sourceId: article.url ? createHash('sha256').update(article.url).digest('hex').slice(0, 24) : null,
          topic: title,
          title,
          description: null,
          reference: article.url ?? null,
          timestamp,
          collectedAt,
          metric: 'article',
          metricValue: 1,
          metricUnit: 'article',
          country: country === 'WORLDWIDE' ? null : country,
          language: articleLanguage ?? language,
          platform: 'gdelt',
          authorOrPublisher: domain,
          publisherId: domain,
          engagement: null,
          sourceConfidence: 0.72,
          metadata: { provider: 'gdelt-doc-2.0', sourceCountry: article.sourcecountry ?? null, languageName: article.language ?? null },
        });
        if (!latest || timestamp > latest) latest = timestamp;
      }
    }
  } else if (gdeltRateLimited(listResponse.text) || listResponse.status === 'RATE_LIMITED') {
    limitations.push('The article list was rate limited. Timeline data was used only if that separate request succeeded.');
  }
  const series = [];
  if (timelineResponse.ok && !gdeltRateLimited(timelineResponse.text)) {
    const parsed = parseJson(timelineResponse.text);
    const points = parsed.json?.timeline?.[0]?.data;
    if (Array.isArray(points)) {
      const normalized = [];
      for (const point of points) {
        const timestamp = gdeltDate(point.date);
        if (!timestamp || !isNumber(point.value)) continue;
        normalized.push({ t: timestamp, value: point.value });
        if (!latest || timestamp > latest) latest = timestamp;
      }
      if (normalized.length) {
        series.push({
          id: 'gdelt-article-count',
          label: 'GDELT article count',
          metric: 'article_count',
          unit: 'articles',
          country: country === 'WORLDWIDE' ? null : country,
          geographic: country !== 'WORLDWIDE',
          geographicMethod: country === 'WORLDWIDE' ? null : 'publisher_country_filter',
          points: normalized,
        });
      }
    } else {
      limitations.push('GDELT did not return an article-count timeline, so news velocity cannot be calculated from this response.');
    }
  }
  const status = signals.length && series.length && listResponse.ok && timelineResponse.ok ? 'CONNECTED' : (signals.length || series.length ? 'DEGRADED' : listResponse.status === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'DEGRADED');
  return {
    id: 'news',
    name,
    status,
    signals,
    series,
    limitations,
    requests: 2,
    estimatedCostUsd: 0,
    latencyMs,
    provider: 'GDELT DOC 2.0',
    freshness: freshness('news', status, latest, collectedAt),
  };
}

async function wikiSearch(project, query) {
  const url = `https://${project.split('.')[0]}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&utf8=1`;
  return requestText(url, { timeoutMs: 12_000 });
}

export async function collectWikipedia({ query, country = 'WORLDWIDE', language = 'en', timeWindow = '24h' }) {
  const name = 'Wikipedia attention';
  const project = WIKI_PROJECT[language];
  if (!project) return failed('wikipedia', name, 'UNAVAILABLE', 'LANGUAGE_UNSUPPORTED', `No Wikipedia project is configured for ${language}.`);
  const collectedAt = new Date().toISOString();
  const search = await wikiSearch(project, query);
  if (!search.ok) {
    return failed('wikipedia', name, search.status, search.code, 'Wikipedia search could not be reached. Pageviews were not invented.', search.latencyMs);
  }
  const parsed = parseJson(search.text);
  const hits = parsed.json?.query?.search;
  if (!Array.isArray(hits) || !hits.length) {
    return {
      id: 'wikipedia',
      name,
      status: 'CONNECTED',
      signals: [],
      series: [],
      limitations: ['Wikipedia search returned no article for this topic. No pageview series was invented.'],
      requests: 1,
      estimatedCostUsd: 0,
      latencyMs: search.latencyMs,
      freshness: { ...freshness('wikipedia', 'CONNECTED', null, collectedAt), lastSuccessAt: collectedAt, latestSignalAt: null, dataAgeSeconds: null, liveStatus: 'UNAVAILABLE' },
    };
  }
  const titles = hits.slice(0, 3).map((hit) => hit.title).filter((title) => typeof title === 'string');
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
  const stamp = (date) => date.toISOString().slice(0, 10).replace(/-/g, '');
  const series = [];
  const signals = [];
  let latest = null;
  let requests = 1;
  let latencyMs = search.latencyMs;
  let partial = false;
  for (const title of titles) {
    const encoded = encodeURIComponent(title.replace(/ /g, '_'));
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}/all-access/user/${encoded}/daily/${stamp(start)}/${stamp(end)}`;
    const response = await requestText(url, { timeoutMs: 12_000 });
    requests += 1;
    latencyMs += response.latencyMs;
    if (!response.ok) {partial=true;continue;}
    const body = parseJson(response.text);
    const items = body.json?.items;
    if (!Array.isArray(items)) {partial=true;continue;}
    const points = [];
    for (const item of items) {
      const timestamp = wikiDate(item.timestamp);
      if (!timestamp || !isNumber(item.views)) continue;
      points.push({ t: timestamp, value: item.views });
      if (!latest || timestamp > latest) latest = timestamp;
    }
    if (!points.length) continue;
    series.push({
      id: `wiki:${title}`,
      label: `${title} pageviews`,
      metric: 'wikipedia_pageviews',
      unit: 'pageviews',
      country: null,
      geographic: false,
      article: title,
      points,
    });
    const last = points[points.length - 1];
    signals.push({
      source: 'wikipedia',
      sourceId: `${project}:${title}`,
      topic: title,
      title,
      description: 'Wikipedia article pageviews. This is attention on Wikipedia, not search volume.',
      reference: `https://${project.split('.')[0]}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      timestamp: last.t,
      collectedAt,
      metric: 'wikipedia_pageviews',
      metricValue: last.value,
      metricUnit: 'pageviews',
      country: null,
      language,
      platform: project,
      authorOrPublisher: 'Wikimedia',
      publisherId: 'wikimedia',
      engagement: last.value,
      sourceConfidence: 0.8,
      metadata: { provider: 'wikimedia-pageviews', granularity: 'daily', window: timeWindow },
    });
  }
  let geographicNote = 'Wikipedia pageviews collected here are not broken down by reader country. Geographic strength is not taken from this source.';
  if (country !== 'WORLDWIDE') {
    const day = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top-per-country/${country}/all-access/${day.getUTCFullYear()}/${String(day.getUTCMonth() + 1).padStart(2, '0')}/${String(day.getUTCDate()).padStart(2, '0')}`;
    const top = await requestText(url, { timeoutMs: 12_000 });
    requests += 1;
    latencyMs += top.latencyMs;
    if (top.ok) {
      const body = parseJson(top.text);
      const articles = body.json?.items?.[0]?.articles;
      if (Array.isArray(articles)) {
        const wanted = new Set(titles.map((title) => title.replace(/ /g, '_').toLowerCase()));
        const match = articles.find((article) => wanted.has(String(article.article ?? '').toLowerCase()));
        if (match && isNumber(match.views_ceil) && isNumber(match.rank)) {
          geographicNote = `${titles[0]} appeared at rank ${match.rank} in the published ${ISO_COUNTRY[country] ?? country} Wikipedia top list. Counts are privacy ceilings, not exact views.`;
          series.push({
            id: `wiki-geo:${country}`,
            label: `${ISO_COUNTRY[country] ?? country} top-list rank`,
            metric: 'wikipedia_rank',
            unit: 'rank',
            country,
            geographic: true,
            geographicMethod: 'top_per_country_ceiling',
            points: [{ t: wikiDate(`${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}`), value: match.views_ceil, rank: match.rank }],
          });
        } else {
          geographicNote = `None of the matched Wikipedia articles were in the latest published ${ISO_COUNTRY[country] ?? country} top pageview list. Absence is not scored as zero geographic strength.`;
        }
      }
    } else {
      partial = true;
      geographicNote = `The ${ISO_COUNTRY[country] ?? country} Wikipedia top list could not be loaded. Geographic strength was not inferred.`;
    }
  }
  const status = series.length && !partial ? 'CONNECTED' : 'DEGRADED';
  return {
    id: 'wikipedia',
    name,
    status,
    signals,
    series: series.filter((item) => item.metric === 'wikipedia_pageviews'),
    geographicSeries: series.filter((item) => item.geographic),
    limitations: [
      'Wikipedia pageviews measure article attention. They are not search volume and must not be labeled as searches.',
      'Daily pageviews are published after the UTC day ends, so this source is near-daily, not second-by-second.',
      geographicNote,
      `Language edition: ${project}. A language edition is not a country.`,
    ],
    requests,
    estimatedCostUsd: 0,
    latencyMs,
    provider: 'Wikimedia Pageviews',
    freshness: freshness('wikipedia', status, latest, collectedAt),
  };
}

export async function collectHackerNews({ query, country = 'WORLDWIDE', language = 'en', timeWindow = '24h' }) {
  const name = 'Hacker News';
  if (language !== 'en') {
    return {
      ...notConfigured('hackernews', name, 'Hacker News is predominantly English. It was not queried for this language, and no translated records were invented.'),
      status: 'UNAVAILABLE',
      freshness: { ...freshness('hackernews', 'UNAVAILABLE', null, new Date().toISOString()), lastSuccessAt: null, liveStatus: 'UNAVAILABLE' },
    };
  }
  const since = Math.floor((Date.now() - (WINDOW_MS[timeWindow] ?? WINDOW_MS['24h'])) / 1000);
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=40&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`;
  const response = await requestText(url, { timeoutMs: 12_000 });
  if (!response.ok) return failed('hackernews', name, response.status, response.code, 'Hacker News could not be reached. No discussion records were invented.', response.latencyMs);
  const parsed = parseJson(response.text);
  const hits = parsed.json?.hits;
  const collectedAt = new Date().toISOString();
  if (!Array.isArray(hits)) {
    return failed('hackernews', name, 'DEGRADED', 'BAD_RESPONSE', 'Hacker News returned an unreadable response.', response.latencyMs);
  }
  const signals = [];
  let latest = null;
  for (const hit of hits) {
    if (!hit?.created_at || !hit.title) continue;
    const timestamp = new Date(hit.created_at).toISOString();
    signals.push({
      source: 'hackernews',
      sourceId: String(hit.objectID ?? ''),
      topic: hit.title,
      title: hit.title,
      description: null,
      reference: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      timestamp,
      collectedAt,
      metric: 'points',
      metricValue: isNumber(hit.points) ? hit.points : null,
      metricUnit: 'points',
      country: null,
      language: 'en',
      platform: 'hackernews',
      authorOrPublisher: hit.author ?? null,
      publisherId: hit.author ? `hn:${hit.author}` : null,
      engagement: isNumber(hit.points) ? hit.points + (isNumber(hit.num_comments) ? hit.num_comments : 0) : null,
      sourceConfidence: 0.45,
      metadata: { provider: 'hn-algolia', comments: isNumber(hit.num_comments) ? hit.num_comments : null, countryRequested: country },
    });
    if (!latest || timestamp > latest) latest = timestamp;
  }
  return {
    id: 'hackernews',
    name,
    status: 'CONNECTED',
    signals,
    series: [],
    limitations: [
      'Hacker News is one technology-discussion community. It is not Reddit and it is not representative of the internet.',
      'Hacker News has no reliable country filter. Its records are not used as geographic evidence.',
    ],
    requests: 1,
    estimatedCostUsd: 0,
    latencyMs: response.latencyMs,
    provider: 'HN Algolia',
    freshness: freshness('hackernews', 'CONNECTED', latest, collectedAt),
  };
}

export async function collectYouTube({ query, country = 'WORLDWIDE', language = 'en', timeWindow = '24h' }) {
  const key = envFlag('YOUTUBE_API_KEY');
  if (!key) return notConfigured('youtube', 'YouTube', 'YouTube Data API key is not configured. No YouTube metrics were estimated.');
  const publishedAfter = new Date(Date.now() - (WINDOW_MS[timeWindow] ?? WINDOW_MS['24h'])).toISOString();
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', q: query, maxResults: '15', order: 'date', publishedAfter, key, relevanceLanguage: language,
  });
  if (country !== 'WORLDWIDE') params.set('regionCode', country);
  const search = await requestText(`https://www.googleapis.com/youtube/v3/search?${params}`, { timeoutMs: 12_000 });
  if (!search.ok) {
    const note = search.status === 'AUTHENTICATION_ERROR'
      ? 'YouTube rejected the API key. No sample videos were substituted.'
      : 'YouTube search failed. No video metrics were invented.';
    return failed('youtube', 'YouTube', search.status, search.code, note, search.latencyMs);
  }
  const parsed = parseJson(search.text);
  if (!Array.isArray(parsed.json?.items)) return failed('youtube', 'YouTube', 'DEGRADED', 'BAD_RESPONSE', 'YouTube returned an invalid search response.', search.latencyMs);
  const ids = parsed.json.items.map((item) => item.id?.videoId).filter(Boolean);
  if (!ids.length) {
    return {
      id: 'youtube', name: 'YouTube', status: 'CONNECTED', signals: [], series: [], requests: 1, estimatedCostUsd: 0, latencyMs: search.latencyMs,
      limitations: ['YouTube returned no videos for this query in the selected window. regionCode biases results; it does not prove viewer geography.'],
      freshness: freshness('youtube', 'CONNECTED', null, new Date().toISOString()),
    };
  }
  const statsParams = new URLSearchParams({ part: 'snippet,statistics', id: ids.join(','), key });
  const stats = await requestText(`https://www.googleapis.com/youtube/v3/videos?${statsParams}`, { timeoutMs: 12_000 });
  if (!stats.ok) return failed('youtube', 'YouTube', ['AUTHENTICATION_ERROR', 'RATE_LIMITED'].includes(stats.status) ? stats.status : 'DEGRADED', stats.code, 'YouTube statistics could not be loaded. Partial video counts were not invented.', search.latencyMs + stats.latencyMs);
  const body = parseJson(stats.text);
  if (!Array.isArray(body.json?.items)) return failed('youtube', 'YouTube', 'DEGRADED', 'BAD_RESPONSE', 'YouTube returned invalid statistics.', stats.latencyMs);
  const collectedAt = new Date().toISOString();
  const signals = [];
  let latest = null;
  for (const video of body.json?.items ?? []) {
    const published = video.snippet?.publishedAt;
    if (!published || !video.snippet?.title) continue;
    const views = Number(video.statistics?.viewCount);
    const hours = Math.max(0.25, (Date.now() - new Date(published).getTime()) / 3_600_000);
    signals.push({
      source: 'youtube',
      sourceId: video.id,
      topic: video.snippet.title,
      title: video.snippet.title,
      description: video.snippet.channelTitle ?? null,
      reference: `https://www.youtube.com/watch?v=${video.id}`,
      timestamp: new Date(published).toISOString(),
      collectedAt,
      metric: 'views_per_hour_since_publish',
      metricValue: Number.isFinite(views) ? Number((views / hours).toFixed(2)) : null,
      metricUnit: 'views_per_hour_since_publish',
      country: null,
      language,
      platform: 'youtube',
      authorOrPublisher: video.snippet.channelTitle ?? null,
      publisherId: video.snippet.channelId ?? null,
      engagement: Number.isFinite(views) ? views : null,
      sourceConfidence: 0.7,
      metadata: {
        provider: 'youtube-data-api-v3',
        views: Number.isFinite(views) ? views : null,
        likes: video.statistics?.likeCount ?? null,
        comments: video.statistics?.commentCount ?? null,
        limitation: 'viewCount is cumulative since publish, not views inside the selected window. The API sample is not every YouTube video.',
      },
    });
    if (!latest || published > latest) latest = new Date(published).toISOString();
  }
  return {
    id: 'youtube',
    name: 'YouTube',
    status: 'CONNECTED',
    signals,
    series: [],
    limitations: [
      'YouTube results are an API sample ordered by date, not the full catalog.',
      'regionCode biases ranking. It is not evidence of where viewers are.',
      'views per hour uses cumulative viewCount divided by age. It is not in-window view velocity.',
    ],
    requests: 2,
    estimatedCostUsd: 0,
    quotaUnits: 101,
    latencyMs: search.latencyMs + stats.latencyMs,
    provider: 'YouTube Data API v3',
    freshness: freshness('youtube', 'CONNECTED', latest, collectedAt),
  };
}

export async function collectReddit({ query, country = 'WORLDWIDE', language = 'en', timeWindow = '24h' }) {
  const id = envFlag('REDDIT_CLIENT_ID');
  const secret = envFlag('REDDIT_CLIENT_SECRET');
  if (!id || !secret) return notConfigured('reddit', 'Reddit', 'Reddit OAuth client credentials are not configured. Public pages were not scraped.');
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const tokenResponse = await requestText('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    auth: `Basic ${basic}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!tokenResponse.ok) return failed('reddit', 'Reddit', tokenResponse.status, tokenResponse.code, 'Reddit authentication failed. No posts were invented.', tokenResponse.latencyMs);
  const token = parseJson(tokenResponse.text).json?.access_token;
  if (!token) return failed('reddit', 'Reddit', 'AUTHENTICATION_ERROR', 'NO_TOKEN', 'Reddit did not return an access token.', tokenResponse.latencyMs);
  const windowMap = { '1h': 'hour', '6h': 'day', '24h': 'day', '3d': 'week', '7d': 'week', '30d': 'month', '90d': 'year' };
  const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(query)}&sort=new&t=${windowMap[timeWindow] ?? 'day'}&limit=40&type=link&restrict_sr=false`;
  const response = await requestText(url, { auth: `Bearer ${token}`, headers: { 'User-Agent': 'kreovio/0.2' } });
  if (!response.ok) return failed('reddit', 'Reddit', response.status, response.code, 'Reddit search failed. No posts were invented.', tokenResponse.latencyMs + response.latencyMs);
  const children = parseJson(response.text).json?.data?.children;
  if (!Array.isArray(children)) return failed('reddit', 'Reddit', 'DEGRADED', 'BAD_RESPONSE', 'Reddit returned invalid posts.', response.latencyMs);
  const collectedAt = new Date().toISOString();
  const cutoff = Date.now() - (WINDOW_MS[timeWindow] ?? WINDOW_MS['24h']);
  const signals = [];
  let latest = null;
  for (const child of children) {
    const post = child?.data;
    if (!post?.created_utc || !post.title) continue;
    const timestamp = new Date(post.created_utc * 1000).toISOString();
    if (new Date(timestamp).getTime() < cutoff) continue;
    signals.push({
      source: 'reddit',
      sourceId: post.id,
      topic: post.title,
      title: post.title,
      description: post.subreddit_name_prefixed ?? null,
      reference: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
      timestamp,
      collectedAt,
      metric: 'score',
      metricValue: isNumber(post.score) ? post.score : null,
      metricUnit: 'score',
      country: null,
      language: null,
      platform: 'reddit',
      authorOrPublisher: post.subreddit_name_prefixed ?? null,
      publisherId: post.author ? `reddit:${post.author}` : null,
      engagement: isNumber(post.num_comments) ? post.num_comments : null,
      sourceConfidence: 0.55,
      metadata: { provider: 'reddit-oauth', community: post.subreddit_name_prefixed ?? null, comments: post.num_comments ?? null, countryRequested: country, languageRequested: language },
    });
    if (!latest || timestamp > latest) latest = timestamp;
  }
  return {
    id: 'reddit',
    name: 'Reddit',
    status: 'CONNECTED',
    signals,
    series: [],
    limitations: [
      'Reddit search is a permitted OAuth sample, not the whole site and not the whole internet.',
      'Reddit does not provide a reliable country or language filter here, so these posts are not geographic evidence.',
    ],
    requests: 2,
    estimatedCostUsd: 0,
    latencyMs: tokenResponse.latencyMs + response.latencyMs,
    provider: 'Reddit API',
    freshness: freshness('reddit', 'CONNECTED', latest, collectedAt),
  };
}

async function collectSerpApiInterest({ query, country = 'WORLDWIDE', language = 'en', timeWindow = '24h', mode = 'analyze' }) {
  const key = envFlag('SERPAPI_API_KEY');
  if (!key) return notConfigured('search', 'Search interest', 'No licensed search-trend provider key is configured. Relative interest was not estimated.');
  const date = { '1h': 'now 1-d', '6h': 'now 1-d', '24h': 'now 7-d', '3d': 'now 7-d', '7d': 'today 1-m', '30d': 'today 3-m', '90d': 'today 12-m' }[timeWindow] ?? 'now 7-d';
  const params = new URLSearchParams({ engine: 'google_trends', q: query, data_type: 'TIMESERIES', date, api_key: key });
  if (country !== 'WORLDWIDE') params.set('geo', country);
  if (language) params.set('hl', language);
  const response = await requestText(`https://serpapi.com/search.json?${params}`, { timeoutMs: 15_000 });
  if (!response.ok) return failed('search', 'Search interest', response.status, response.code, 'The search-trend provider failed. Relative interest was not invented.', response.latencyMs);
  const body = parseJson(response.text).json;
  const timeline = body?.interest_over_time?.timeline_data;
  const collectedAt = new Date().toISOString();
  if (!Array.isArray(timeline)) {
    return failed('search', 'Search interest', 'DEGRADED', 'BAD_RESPONSE', 'The provider did not return a relative-interest timeline.', response.latencyMs);
  }
  const points = [];
  for (const point of timeline) {
    const raw = point.timestamp ? new Date(Number(point.timestamp) * 1000).toISOString() : null;
    const value = point.values?.[0]?.extracted_value;
    if (!raw || !isNumber(value)) continue;
    points.push({ t: raw, value });
  }
  const latest = points.length ? points[points.length - 1].t : null;
  const candidates = [], geographicSeries = [];
  let requests = 1, latencyMs = response.latencyMs, partial = false;
  if (mode === 'discover') {
    for (const type of ['RELATED_QUERIES','RELATED_TOPICS','GEO_MAP_0']) {
      params.set('data_type',type);
      const related = await requestText(`https://serpapi.com/search.json?${params}`, {timeoutMs:15000});
      requests++; latencyMs += related.latencyMs;
      const data = parseJson(related.text).json;
      if (!related.ok || !data || data.error) {partial=true; continue;}
      if (type === 'GEO_MAP_0') {
        const regions = data.interest_by_region;
        if (!Array.isArray(regions)) {partial=true; continue;}
        for (const region of regions) {
          const value=region.extracted_value ?? region.values?.[0]?.extracted_value;
          if (isNumber(value)) geographicSeries.push({country:region.geo ?? null,label:region.location,metric:'relative_interest',unit:'relative_index',points:[{t:collectedAt,value}],geographicMethod:'provider_relative_interest'});
        }
        continue;
      }
      const root = type === 'RELATED_QUERIES' ? data.related_queries : data.related_topics;
      if (!root || (!Array.isArray(root.top) && !Array.isArray(root.rising))) {partial=true;continue;}
      for (const kind of ['top','rising']) for (const item of root[kind] ?? []) {
        const name=item.query ?? item.topic?.title;
        if (typeof name !== 'string') continue;
        candidates.push({name,kind:`${type.toLowerCase()}_${kind}`,evidence:{source:'search',title:name,topic:name,
          sourceId:`serpapi:${type}:${name}`,timestamp:collectedAt,collectedAt,reference:item.link ?? null,
          metric:'provider_related_interest',metricValue:isNumber(item.extracted_value) ? item.extracted_value : null,
          metricUnit:'relative_index_or_growth',publisherId:'serpapi',metadata:{kind,provider:'serpapi-google-trends',displayValue:item.value ?? null}}});
      }
    }
  }
  const status = points.length && !partial ? 'CONNECTED' : 'DEGRADED';
  return {
    candidates, geographicSeries,
    id: 'search',
    name: 'Search interest',
    status,
    signals: points.slice(-1).map((point) => ({
      source: 'search',
      sourceId: `serpapi:${query}:${point.t}`,
      topic: query,
      title: query,
      reference: null,
      timestamp: point.t,
      collectedAt,
      metric: 'relative_interest',
      metricValue: point.value,
      metricUnit: 'relative_index',
      country: country === 'WORLDWIDE' ? null : country,
      language,
      platform: 'google-trends',
      authorOrPublisher: 'search-trend-provider',
      publisherId: 'serpapi',
      sourceConfidence: 0.75,
      metadata: { provider: 'serpapi-google-trends', note: 'Relative interest index. Not absolute search volume.' },
    })),
    series: points.length ? [{
      id: 'search-relative-interest',
      label: 'Relative search interest',
      metric: 'relative_interest',
      unit: 'relative_index',
      country: country === 'WORLDWIDE' ? null : country,
      geographic: country !== 'WORLDWIDE',
      geographicMethod: country === 'WORLDWIDE' ? null : 'provider_geo',
      points,
    }] : [],
    limitations: [
      'Relative interest is an index, usually 0–100. It is not monthly search volume and is never converted into a search count.',
      'SerpAPI is a third-party provider, not Google’s official Trends API. Provider sampling and indexing delays apply.',
      ...(partial ? ['Some related-interest or geography requests failed; partial evidence only.'] : []),
    ],
    requests,
    estimatedCostUsd: requests * Number(process.env.SERPAPI_COST_PER_CALL_USD ?? 0.01),
    latencyMs,
    provider: 'SerpAPI Google Trends',
    freshness: freshness('search', status, latest, collectedAt),
  };
}

// Provider registry is the extension point for official Google Trends access when granted.
export const SEARCH_PROVIDERS = Object.freeze({serpapi: collectSerpApiInterest});
export async function collectSearchInterest(input) {
  const provider = process.env.SEARCH_INTEREST_PROVIDER || 'serpapi';
  if (!SEARCH_PROVIDERS[provider]) return notConfigured('search','Search interest','REQUIRES_PROVIDER_APPROVAL: official Google Trends access/adapter is not available.');
  return SEARCH_PROVIDERS[provider](input);
}

export const ADAPTERS = Object.freeze({
  search: collectSearchInterest,
  youtube: collectYouTube,
  reddit: collectReddit,
  news: collectNews,
  wikipedia: collectWikipedia,
  hackernews: collectHackerNews,
});

export function sourceConfigHash(sourceId) {
  const keys = {youtube:['YOUTUBE_API_KEY'],reddit:['REDDIT_CLIENT_ID','REDDIT_CLIENT_SECRET'],search:['SERPAPI_API_KEY','SEARCH_INTEREST_PROVIDER']};
  return createHash('sha256').update(JSON.stringify((keys[sourceId] ?? []).map((key)=>envFlag(key)))).digest('hex');
}
export async function healthCheckSource(sourceId) {
  if (sourceId === 'search' && process.env.SEARCH_INTEREST_PROVIDER && process.env.SEARCH_INTEREST_PROVIDER !== 'serpapi') return {id:sourceId,status:'NOT_CONFIGURED',note:'REQUIRES_PROVIDER_APPROVAL: official Google Trends is not available.'};
  const required = { youtube: ['YOUTUBE_API_KEY'], reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'], search: ['SERPAPI_API_KEY'] };
  if (required[sourceId]?.some((key) => !envFlag(key))) return { id: sourceId, status: 'NOT_CONFIGURED', note: 'REQUIRES_CREDENTIALS' };
  if (!ADAPTERS[sourceId]) return { id: sourceId, status: 'UNAVAILABLE', note: 'Unknown source.' };
  return { id: sourceId, status: 'UNKNOWN', configHash: sourceConfigHash(sourceId), note: 'No successful provider collection has been verified.' };
}

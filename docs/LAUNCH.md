# KREOVIO launch preparation

## Audit of PR #2 before these changes

Audited head: `2459db42d5c4ba37b3b71b867da502258bc6ad93`, branch `arena/01a105f3-kreovio`.
The branch already had collectors, KTS-1.0, PGlite/pg, account verification, reservation/commit/release, stored reports and cache. Gaps verified in code:

- `healthCheckSource` labeled credential presence CONNECTED; `/api/status` reused stored freshness labels without aging them.
- Discovery observations were transient title clusters without cluster history. Source confirmation considered only ready-made series.
- Background refresh selected one latest successful search, without a queue or budgets.
- Search interest fetched only TIMESERIES. Email delivery was not wired; rate limiting was in memory; PR CI was absent.

## Behavior and evidence boundaries

One product, two modes: `discover` extracts candidates within a category, while `analyze` evaluates a topic. The request shape is:

```json
{"mode":"discover","query":"Fitness","country":"IN","language":"en","timeWindow":"7d","source":"all"}
```

Provider related queries/topics and rising labels are preserved as evidence. Other candidates are literal repeated 2–3-word phrases or representative evidence titles, capped at 20. Clustering is conservative lexical matching, not semantic entity resolution. Names are evidence-derived, not invented. Related-provider growth labels alone never determine acceleration, confidence, Early Signal or Trend Score.

`topic_clusters` persists candidates, including those without ranked results. `topic_observations` stores collection-time metrics and normalized raw evidence per source, topic, geography, language, query scope and window. `raw_signals` preserves original provider metadata; `provider_series_batches` stores native timelines and geography without merging differently normalized relative-interest responses.

For YouTube/Reddit/News/HN, stored history uses the last sampled rolling-window record count in each complete requested-window bucket. Repeated collections in a bucket replace that bucket; overlapping samples are never summed. Metrics also include unique publishers/communities, median views, score, comments and views/hour since publication. These are **capped API sample measurements**, not total platform publication rates, exact search volume, or measured recent view growth. Unsuccessful or empty sampled collections do not become zero observations. Gaps break the scoring sequence. Discovery can use separately collected candidate-specific history, selecting one count sampling scope rather than splicing broad and targeted counts; recent native provider responses retain their own scope and collection provenance. Four contiguous complete windows and KTS volume thresholds are needed; 90-day scoring can require at least 360 days of collection. All seven windows (1h, 6h, 24h, 3d, 7d, 30d, 90d) use the same architecture; coarse provider series cannot support short windows.

New candidates remain observed/INSUFFICIENT_HISTORY with null acceleration and score. Valid evidence-only analyses still cost one credit under the existing complete-analysis policy; collection failure releases the credit. Opening an owned report and replaying a committed request spend zero additional credits. Cross-source evidence counts source families, not record/publisher counts; syndicated/copy records collapse before confirmation. A confirming source need not supply its own timeline. This confirms topic evidence, not independently measured acceleration in every family.

KTS-1.0 remains deterministic with provenance and the original weights. Missing features remain null. Scores require velocity and acceleration as well as existing feature-coverage rules. Saturation is still missing, so Early Signal generally remains withheld. Historical calibration is required before making predictive product claims.

## Source health

`/api/status`, new reports and reopened reports expose status, lastAttemptAt, lastSuccessAt, latestSignalAt, dataAgeSeconds, latencyMs and liveStatus. LIVE requires a successful source request plus known recent signal and collection timestamps. Credentials alone yield UNKNOWN; absent credentials yield NOT_CONFIGURED. Rotating credentials invalidates earlier health evidence. Failed authentication, provider quotas, partial failures and transport failures remain distinct. Freshness ages at read time, including cached and reopened reports.

| Connector | Code path / provider | User action | Verification here |
|---|---|---|---|
| YouTube | collectYouTube, official Data API v3 | Enable API; restricted server-side YOUTUBE_API_KEY and quota | REQUIRES_CREDENTIALS; not live verified |
| Reddit | collectReddit, OAuth + search | REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET; obtain applicable commercial/API permission | REQUIRES_CREDENTIALS and REQUIRES_PROVIDER_APPROVAL |
| Search | collectSearchInterest → SEARCH_PROVIDERS.serpapi | SERPAPI_API_KEY and paid/licensed quota as needed | REQUIRES_CREDENTIALS; not live verified |
| News | collectNews, GDELT DOC | Egress to api.gdeltproject.org; observe request spacing | Implemented, not live verified |
| Wikipedia | collectWikipedia, Wikimedia pageviews | Egress to selected language Wikipedia and wikimedia.org | Implemented, not live verified |
| HN | collectHackerNews, hn.algolia.com | Egress; English-only technology community | Implemented, not live verified |

SerpAPI is a third-party provider, **not Google's official Trends API**. It supports TIMESERIES, RELATED_QUERIES, RELATED_TOPICS and GEO_MAP_0. Top/rising entries preserve raw values (including Breakout); geographic interest stays relative. Official Google Trends is an extension point only: obtain access and implement a tested adapter before adding it to SEARCH_PROVIDERS. No official access is assumed. News publisher country and YouTube region bias do not establish audience location; Wikipedia pageviews are not searches.

## Queue, quotas and costs

`createCollectionQueue(pool)` exposes `claim()` and `finish(job,error)`. SQL leases use SKIP LOCKED and an ownership token; restart recovery is automatic after five minutes. Priority: saved 90, accelerating 70, recently searched 30, discovered 10. Saved topics stay tracked; other topics expire after at least seven days or five selected windows. Retries back off to 16 hours. Each pass claims one job; default success cadence is hourly. Budget exhaustion can create missing buckets, deliberately withholding scores.

Foreground and background collections share atomic daily call reservations. Default caps: Search 40, YouTube 198, other sources 200. Search reserves up to four calls per collection (default at most 10 collections/day, estimated $0.40 at $0.01/call). YouTube reserves two calls and allows at most 99 collections/day, approximately 9,999 API units at 101 units/collection. Failed requests consume reserved budget. Limits are conservative, not provider billing guarantees. Set `PROVIDER_DAILY_CALLS_<SOURCE>` to tune. Google quota reset and UTC budget boundaries can differ; reserve headroom. Distributed GDELT spacing is not implemented: start with **one collection worker** and monitor provider throttling. Foreground collection bursts still need production load testing.

PGlite: use only one API process, with `BACKGROUND_COLLECTION=true` to enable its embedded loop. Do not run a separate PGlite worker. PostgreSQL: API replicas and `npm run worker` share database leases, budgets, 15-minute cache and request throttles. This queue can be replaced by a durable external queue behind the same interface. Deploy the worker under a supervisor with restart, health checks and graceful shutdown. Production-scale fairness, scheduler throughput, provider-specific retention policies and load tests remain work.

## Deployment steps (no merge or deployment performed)

1. Review the existing PR branch. Do not merge merely to deploy a private preview.

```sh
git fetch origin arena/01a105f3-kreovio
git switch arena/01a105f3-kreovio
npm ci
npm test
npm run build
```

2. Provision managed PostgreSQL with TLS, backups/PITR, monitoring and a tested restore. Inject DATABASE_URL through the host secret manager (use the provider's TLS verification settings). The schema/migrations run transactionally on startup with a PostgreSQL advisory lock. Grant only required schema/data permissions; snapshot the database before first migration.
3. Provision an HTTPS host for the Vite `dist/` files and Node API. Route `/api/*` to the API on the same origin. Set the host's environment through its secret UI, not committed files:

```dotenv
NODE_ENV=production
DATABASE_URL=<managed-postgres-URL-with-TLS>
AUTH_SECRET=<at-least-32-random-characters>
APP_ORIGIN=https://<your-domain>
COOKIE_SECURE=true
EMAIL_API_KEY=<Resend-server-key>
EMAIL_FROM=Kreovio <verified-sender@your-domain>
BACKGROUND_COLLECTION=false
SEARCH_INTEREST_PROVIDER=serpapi
```

Generate AUTH_SECRET locally with `openssl rand -hex 32`, then paste it into the hosting secret manager. Configure DNS/sending-domain verification (SPF/DKIM and DMARC) in Resend. The API sends verification codes via `api.resend.com`; no secret/code is exposed in production responses. `/api/auth/resend-verification` provides rate-limited retry after delivery failure. Actual inbox delivery is unverified until you test it. The API refuses production startup without database, HTTPS, secure cookies and email settings.

4. Add provider credentials from the table only after obtaining permissions. Permit outbound HTTPS to the provider hosts, including www.googleapis.com, www.reddit.com, oauth.reddit.com and serpapi.com. Never put credentials in VITE_* variables. If using TRUST_PROXY=true, the ingress must replace untrusted forwarding headers.
5. Start API with `npm run start:api`; run `npm run worker` as a separate supervised process with DATABASE_URL and provider secrets. Do not enable both the embedded loop and a separate worker unintentionally. Set strict provider budgets before enabling collection.
6. Keep the beta private. Verify registration → inbox code → grant exactly one free credit → discover/analyze → evidence/report → reopen without another credit → failed collector without charge. Inspect `/api/status`: UNKNOWN is unverified, not live. Use real successful provider responses to verify connectivity; mocked tests do not count.
7. Configure GitHub branch protection to require the `test-and-build` Actions job. The workflow runs npm ci, npm test and npm run build on PRs with read-only repository permissions. No repository secrets are required by tests.

The shared PostgreSQL cache and limiter need indexes, monitoring and cleanup under expected load. Schedule deletion of expired intelligence_cache, old request_limits/provider_budgets and provider evidence according to contractual retention requirements. Do not impose a short global history TTL if 90-day comparisons are required. Add an external shared cache only when measurements justify it; never cache authenticated responses at a public CDN.

## Remaining launch blockers

No production resources or external connectors were verified in this implementation session. Provider keys/approvals, managed PostgreSQL, email sender verification, HTTPS ingress, supervised workers, monitoring, backups and restore testing must be supplied by the owner. Aged historical data cannot be manufactured. Lexical clustering, capped samples, quota scheduling, provider retention compliance and KTS calibration need measured beta evaluation. Paid checkout remains separate later work. This is a testable development/private-beta foundation, not a production-live claim.

## Verification for this revision

- Full suite: `npm test -- --test-isolation=none` — 37 passed, 0 failed, 0 skipped. Includes all requested health, history, cross-source, syndication, stale-report and credit cases; all seven history windows; and graduation using background targeted history.
- `npm run build` — passed TypeScript and Vite production build.
- Browser: installed Chromium via agent-browser; page rendered, no Vite overlay or browser errors reported, Discover/Analyze toggles and accessible field label changes verified.
- Local `/api/status`: credentialed connectors NOT_CONFIGURED; public connectors UNKNOWN; liveSearchEnabled false. No live provider requests are claimed successful.
- Managed PostgreSQL, real email delivery, external provider connectivity, production worker operation and GitHub-hosted CI execution remain unverified until provisioned/run.

Production-readiness assessment: **5/10**. The code is a verified local/private-beta foundation; external service verification, sustained history, operational testing and calibration remain launch gates.

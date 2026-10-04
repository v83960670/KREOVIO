# KREOVIO

**See what’s rising before everyone else.**

Kreovio is a trend-intelligence product foundation focused on early discovery: finding movement, measuring it against history, exposing its evidence, and keeping trend score separate from confidence.

> **Honest status:** Kreovio now runs a real analysis pipeline: official/public collectors, deterministic scoring, credit reserve/commit/release, verified-account authentication, and PostgreSQL persistence (local PGlite, or `DATABASE_URL`). It is **not production-ready**. YouTube, Reddit, and licensed search-trend providers stay `NOT CONFIGURED` until credentials are supplied. News (GDELT), Wikipedia pageviews, and Hacker News are implemented and will report `UNAVAILABLE` if this runtime cannot open TLS to them. Sample report values remain labelled illustrative and are not returned by Trend Search.

## Run locally

```bash
npm install
npm run dev
```

Open the Vite URL printed by the command (normally `http://localhost:5173`). The dev command starts the web app and the preview API together. The API is proxied through `/api`; browser code uses relative URLs.

```bash
npm test       # scoring and data-normalization tests
npm run build  # TypeScript checks and production frontend build
```

Optional API process settings: copy `.env.example` to `.env` and set `API_HOST` / `API_PORT`. Do not put secrets in frontend variables (`VITE_*`) or commit a real `.env` file.

## What is implemented

- Original Kreovio identity and a responsive, cinematic landing page with a dynamically loaded Three.js/WebGL Trend Core, lower-pixel-ratio mobile rendering, and an animated Canvas/CSS fallback.
- Accessible Trend Finder inputs for topic, country, language, sources, and time window. Country and language are independent.
- API-backed source-readiness and pricing states. A live search request explicitly returns `CONNECTORS_NOT_CONFIGURED` with `charged: false`; it never fabricates a live result.
- Annotated sample report with list/universe views, lifecycle and score placeholders, an evidence-detail modal, and local-only saved-example interaction. All sample metrics, curves, and geographies are labelled illustrative.
- Reduced-motion support, keyboard states, semantic sections, mobile layouts, and non-WebGL/Canvas fallback content.
- Algorithmic scoring primitives in `server/trend-engine.mjs`: robust log-scaled velocity with minimum-volume gates, acceleration, freshness, source confirmation, saturation opportunity, observed-only geographic strength, momentum decay, score coverage/withholding, a distinct evidence-confidence estimate, lifecycle/early-signal thresholds, topic normalization, and near-duplicate handling.
- PostgreSQL starting schema in `db/schema.sql` for users, regional plan prices, searches, append-only credit ledger, atomic reservations, source signals, normalized topics, episodes, snapshots, score versions, evidence, saved trends, costs, admin settings, audit logs, source health, and background jobs.
- PostgreSQL transaction helpers in `server/credit-ledger.mjs` for verified free-credit grants, verified payment grants, idempotent search reservations, commit-on-success, and release-on-failure. They are **not wired into the preview API** until authentication and a configured PostgreSQL pool exist.
- A fail-closed `PaymentService` boundary in `server/payment-service.mjs` with idempotent checkout contracts, HTTPS return-host allowlisting, webhook-signature delegation, minimal event envelopes, and exact server-side payment amount/currency verification. No payment provider adapter or checkout route is registered.

## API

- `GET /api/health` — service health and persistence kind.
- `GET /api/status` — real connector status. Missing credentials are `NOT CONFIGURED`. Failed collections are not relabeled as healthy.
- `GET /api/pricing?currency=INR` — India plan values from the brief. Checkout is not configured.
- `POST /api/auth/register`, `/api/auth/verify`, `/api/auth/login`, `/api/auth/me` — server-side accounts. The free search is granted only after verification.
- `POST /api/search` — authenticated search. Reserves one credit, collects configured sources, and commits only after a valid report. Failure releases the credit. `Accept: text/event-stream` streams real stages.
- `GET /api/reports/:id` — reopen a stored report. Costs zero credits.

The preview API includes a small in-memory request throttle for local testing. It is **not** a distributed production rate limiter and is not an identity or abuse-control system.

## Scoring and trust rules

`server/trend-engine.mjs` is intentionally independent from an LLM. Dimensions and weights default to the brief’s KTS-1.0 allocation. The score is withheld if less than 60% of configured dimensions have observations. Confidence is a distinct signal-quality estimate with missing-data and conflict penalties. “Early signal” requires age, acceleration, confidence, source independence, sample-size, saturation, and score thresholds. These are initial heuristics and require historical evaluation/calibration before production use.

A source adapter must only be added after access rights, provider terms, quota/cost, attribution, retention, and country/language coverage are reviewed. A sampled API response must not be represented as the entirety of a platform. Relative interest must never be labelled absolute search volume. Missing baselines must result in a withheld score, not an invented one.

## Before production

Authentication, the credit ledger, and PostgreSQL persistence are wired. The following is still required before calling the service production-ready:

1. Provision managed PostgreSQL and set `DATABASE_URL`. Local PGlite is real PostgreSQL SQL for development, not a managed production database.
2. Supply `YOUTUBE_API_KEY`, Reddit OAuth credentials, and a licensed search-trend key such as `SERPAPI_API_KEY`. Without them those connectors stay `NOT CONFIGURED`.
3. Run the API somewhere that can open TLS to GDELT, Wikimedia, and Hacker News. This sandbox cannot; those connectors then report `UNAVAILABLE` and invent nothing.
4. Wire SMTP. Verification currently uses a local mailbox token when `SMTP_URL` is unset.
5. Add payment-provider adapters, webhook signature checks, and server-verified checkout. The payment boundary is fail-closed and no checkout is registered.
6. Replace the in-process cache/worker with a durable queue, distributed rate limiting, retention jobs, and operational alerts.
7. Complete privacy/terms, export/deletion, load tests, and a deployment CSP review.

## Repository layout

```text
src/                      Product experience. Sample reports stay labeled and are not search results.
server/index.mjs          HTTP API, auth cookies, SSE search progress
server/search-service.mjs Credit-gated search orchestration
server/analyze.mjs        Evidence assembly. No LLM scoring.
server/sources/           YouTube, Reddit, search, GDELT, Wikipedia, Hacker News adapters
server/trend-engine.mjs   Deterministic KTS-1.0 primitives
server/credit-ledger.mjs  PostgreSQL reserve / commit / release
server/db.mjs             PGlite or DATABASE_URL
db/schema.sql             PostgreSQL schema
```

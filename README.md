# KREOVIO

**See what’s rising before everyone else.**

Kreovio is a trend-intelligence product foundation focused on early discovery: finding movement, measuring it against history, exposing its evidence, and keeping trend score separate from confidence.

> **Honest preview status:** this repository currently builds a polished product preview and the foundations around it. It is **not yet a production trend-intelligence service**. No live data providers, user authentication, PostgreSQL connection, payment processor, or background collection workers are enabled. The app says so in the UI. Sample report values are visibly labelled as illustrative and must not be interpreted as real trends.

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

## Preview API

- `GET /api/health` — preview service health.
- `GET /api/status` — intentionally reports all data providers as not connected.
- `GET /api/pricing?currency=INR` — returns the brief’s India plan values. Checkout and billing cadence are not configured.
- `GET /api/pricing?currency=USD|EUR|GBP|CAD|AUD` — reports that the regional price is not configured; the app does not convert INR at an arbitrary exchange rate.
- `POST /api/search` — validates the topic, then returns a safe, uncharged “connectors not configured” response in this build.

The preview API includes a small in-memory request throttle for local testing. It is **not** a distributed production rate limiter and is not an identity or abuse-control system.

## Scoring and trust rules

`server/trend-engine.mjs` is intentionally independent from an LLM. Dimensions and weights default to the brief’s KTS-1.0 allocation. The score is withheld if less than 60% of configured dimensions have observations. Confidence is a distinct signal-quality estimate with missing-data and conflict penalties. “Early signal” requires age, acceleration, confidence, source independence, sample-size, saturation, and score thresholds. These are initial heuristics and require historical evaluation/calibration before production use.

A source adapter must only be added after access rights, provider terms, quota/cost, attribution, retention, and country/language coverage are reviewed. A sampled API response must not be represented as the entirety of a platform. Relative interest must never be labelled absolute search volume. Missing baselines must result in a withheld score, not an invented one.

## Before production

The following work is still required; the included schema and helpers are foundations, not a claim these services are live:

1. Choose and integrate secure verified-email authentication and server-side authorization.
2. Provision PostgreSQL, apply reviewed migrations, seed admin-managed plans/prices, wire the ledger helpers, and add transaction/integration tests.
3. Implement and operate permitted/licensed source adapters plus historical snapshots, deduplication, clustering, geographic coverage, evaluation, and source-health jobs.
4. Add a durable queue/cache, cost aggregation, distributed rate limiting, concurrency and fair-use controls, operational alerts, and data-retention/deletion workflows.
5. Add payment-provider adapters (UPI/cards/PayPal as eligible), authenticated checkout, signature-verified webhooks, idempotency/reconciliation, refunds, taxes, and explicit billing/renewal terms. The preview has no checkout.
6. Configure regional price records in a protected admin system; international prices are deliberately unpublished until configured.
7. Complete security review, privacy/terms, export/deletion, observability, load tests, and deployment-specific CSP/CSRF controls.

## Repository layout

```text
src/                     React product experience and styles
server/index.mjs          Preview-only HTTP API
server/trend-engine.mjs   Deterministic scoring and normalization primitives
server/credit-ledger.mjs  PostgreSQL transaction helpers (not preview-wired)
server/payment-service.mjs Provider-neutral, fail-closed payment boundary
server/pricing.mjs        Preview price configuration
server/*.test.mjs         Node test suite
db/schema.sql             PostgreSQL starting schema
```

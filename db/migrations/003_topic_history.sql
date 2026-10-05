ALTER TABLE trend_searches DROP CONSTRAINT IF EXISTS trend_searches_time_window_check;
ALTER TABLE trend_searches ADD CONSTRAINT trend_searches_time_window_check CHECK (time_window IN ('1h','6h','24h','3d','7d','30d','90d'));
CREATE TABLE IF NOT EXISTS tracked_topics (
  id text PRIMARY KEY, query text NOT NULL, country text NOT NULL, language text NOT NULL,
  source text NOT NULL, time_window text NOT NULL, mode text NOT NULL,
  priority integer NOT NULL DEFAULT 10, reason text NOT NULL,
  last_requested_at timestamptz NOT NULL DEFAULT now(), next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_token text, failures integer NOT NULL DEFAULT 0,
  last_error text, active_until timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS tracked_topics_due ON tracked_topics(next_run_at, priority DESC);
CREATE TABLE IF NOT EXISTS topic_clusters (
  cluster_key text PRIMARY KEY, name text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]',
  first_observed_at timestamptz NOT NULL, last_observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_observations (
  scope_key text NOT NULL, cluster_key text NOT NULL REFERENCES topic_clusters(cluster_key),
  source_id text NOT NULL, bucket_at timestamptz NOT NULL, collected_at timestamptz NOT NULL,
  metrics jsonb NOT NULL, evidence jsonb NOT NULL,
  PRIMARY KEY(scope_key, cluster_key, source_id, bucket_at)
);
CREATE INDEX IF NOT EXISTS topic_observations_history ON topic_observations(scope_key, cluster_key, source_id, collected_at);
CREATE TABLE IF NOT EXISTS provider_budgets (
  source_id text NOT NULL, day date NOT NULL, calls integer NOT NULL DEFAULT 0,
  PRIMARY KEY(source_id, day)
);
CREATE TABLE IF NOT EXISTS request_limits (
  key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_series_batches (
  scope_key text NOT NULL, source_id text NOT NULL, collected_at timestamptz NOT NULL,
  series jsonb NOT NULL, PRIMARY KEY(scope_key,source_id,collected_at)
);
ALTER TABLE source_freshness ADD COLUMN IF NOT EXISTS config_hash text;

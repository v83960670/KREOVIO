-- Kreovio PostgreSQL starting schema (PostgreSQL 15+).
-- Apply through reviewed migrations in production; do not expose database credentials to clients.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text UNIQUE NOT NULL,
  email citext UNIQUE NOT NULL,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deletion_pending', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text,
  billing_region char(2),
  preferred_currency char(3) NOT NULL DEFAULT 'INR',
  language_code varchar(16) NOT NULL DEFAULT 'en',
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  search_allowance integer CHECK (search_allowance >= 0),
  is_unlimited boolean NOT NULL DEFAULT false,
  fair_use_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((is_unlimited AND search_allowance IS NULL) OR (NOT is_unlimited AND search_allowance IS NOT NULL))
);

-- Search allowances are admin-managed starting defaults; regional amounts live separately.
INSERT INTO plans (id, name, search_allowance, is_unlimited, fair_use_rules)
VALUES
  ('free', 'Free', 1, false, '{}'::jsonb),
  ('basic', 'Basic', 20, false, '{}'::jsonb),
  ('pro', 'Pro', 50, false, '{}'::jsonb),
  ('pro-plus', 'Pro Plus', NULL, true, '{"max_concurrent": 2, "rate_per_minute": 60}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE regional_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id text NOT NULL REFERENCES plans(id),
  region_code char(2) NOT NULL,
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  billing_type text NOT NULL CHECK (billing_type IN ('one_time', 'recurring', 'not_configured')),
  interval_unit text CHECK (interval_unit IN ('day', 'week', 'month', 'year')),
  interval_count integer CHECK (interval_count > 0),
  tax_behavior text NOT NULL DEFAULT 'provider_managed' CHECK (tax_behavior IN ('inclusive', 'exclusive', 'provider_managed')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  configured_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, region_code, currency, effective_from),
  CHECK ((billing_type = 'recurring') = (interval_unit IS NOT NULL)),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES plans(id),
  provider text NOT NULL,
  provider_subscription_id text,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  region_code char(2),
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  period_started_at timestamptz,
  period_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);
CREATE INDEX subscriptions_user_status_idx ON subscriptions(user_id, status);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id text NOT NULL REFERENCES plans(id),
  subscription_id uuid REFERENCES subscriptions(id),
  provider text NOT NULL,
  provider_payment_id text,
  idempotency_key text NOT NULL,
  region_code char(2),
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  status text NOT NULL CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'refunded', 'disputed')),
  provider_payload_digest text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, idempotency_key),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX payments_user_created_idx ON payments(user_id, created_at DESC);

CREATE TABLE trend_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  query text NOT NULL CHECK (char_length(query) BETWEEN 2 AND 100),
  country_code text NOT NULL DEFAULT 'WORLDWIDE',
  language_code varchar(16) NOT NULL DEFAULT 'en',
  source_filter text NOT NULL DEFAULT 'all',
  time_window text NOT NULL CHECK (time_window IN ('6h', '24h', '3d', '7d', '30d', '90d')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'collecting', 'normalizing', 'scoring', 'succeeded', 'failed', 'cancelled')),
  failure_code text,
  failure_message_safe text,
  source_coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);
CREATE INDEX trend_searches_user_created_idx ON trend_searches(user_id, created_at DESC);
CREATE INDEX trend_searches_status_created_idx ON trend_searches(status, created_at);

CREATE TABLE usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  search_id uuid NOT NULL UNIQUE REFERENCES trend_searches(id) ON DELETE RESTRICT,
  plan_id text NOT NULL REFERENCES plans(id),
  credits_reserved integer NOT NULL DEFAULT 1 CHECK (credits_reserved >= 0),
  credits_consumed integer NOT NULL DEFAULT 0 CHECK (credits_consumed >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released', 'expired')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  expires_at timestamptz NOT NULL,
  request_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (credits_consumed <= credits_reserved),
  CHECK ((status = 'committed' AND (credits_consumed > 0 OR credits_reserved = 0)) OR status <> 'committed')
);
CREATE INDEX usage_reservations_open_user_idx ON usage_reservations(user_id, status, expires_at);

CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  search_id uuid REFERENCES trend_searches(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES usage_reservations(id) ON DELETE RESTRICT,
  plan_id text NOT NULL REFERENCES plans(id),
  credits_reserved integer NOT NULL DEFAULT 0 CHECK (credits_reserved >= 0),
  credits_consumed integer NOT NULL DEFAULT 0 CHECK (credits_consumed >= 0),
  transaction_type text NOT NULL CHECK (transaction_type IN ('grant', 'reserve', 'consume', 'release', 'refund', 'adjustment', 'expiry')),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'reversed')),
  request_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  credit_delta integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (credits_consumed <= credits_reserved OR transaction_type NOT IN ('reserve', 'consume')),
  CHECK (transaction_type <> 'reserve' OR credit_delta = -credits_reserved),
  CHECK (transaction_type <> 'release' OR credit_delta = credits_reserved),
  CHECK (transaction_type <> 'grant' OR credit_delta >= 0),
  CHECK (transaction_type <> 'consume' OR credit_delta = 0)
);
CREATE INDEX usage_ledger_user_created_idx ON usage_ledger(user_id, created_at DESC);
CREATE INDEX usage_ledger_search_idx ON usage_ledger(search_id) WHERE search_id IS NOT NULL;
CREATE FUNCTION reject_usage_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage_ledger is append-only; record a reversal instead of mutating a transaction';
END;
$$;
CREATE TRIGGER usage_ledger_append_only
  BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_usage_ledger_mutation();

CREATE TABLE trend_sources (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  adapter_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  source_weight numeric(6,5) NOT NULL DEFAULT 0.5 CHECK (source_weight BETWEEN 0 AND 1),
  independent_group text NOT NULL,
  license_name text,
  license_reviewed_at timestamptz,
  retention_days integer CHECK (retention_days IS NULL OR retention_days >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE raw_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES trend_sources(id),
  external_id text,
  title text,
  body_digest text,
  topic_hint text,
  observed_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  country_code text,
  language_code varchar(16),
  platform text,
  metric_name text,
  metric_value numeric,
  metric_unit text,
  source_confidence numeric(5,4) CHECK (source_confidence BETWEEN 0 AND 1),
  publisher_id text,
  reference_url text,
  dedupe_key text,
  duplicate_of uuid REFERENCES raw_signals(id),
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_until timestamptz,
  UNIQUE (source_id, external_id)
);
CREATE INDEX raw_signals_observed_source_idx ON raw_signals(source_id, observed_at DESC);
CREATE INDEX raw_signals_dedupe_key_idx ON raw_signals(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX raw_signals_topic_country_time_idx ON raw_signals(topic_hint, country_code, observed_at DESC);
CREATE INDEX raw_signals_retention_idx ON raw_signals(retention_until) WHERE retention_until IS NOT NULL;

CREATE TABLE normalized_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  normalized_key text NOT NULL UNIQUE,
  category text,
  language_code varchar(16),
  entity_type text,
  entity_id text,
  clustering_method text NOT NULL,
  clustering_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE topic_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES normalized_topics(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  language_code varchar(16),
  alias_source text NOT NULL,
  confidence numeric(5,4) CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_alias, language_code)
);
CREATE INDEX topic_aliases_topic_idx ON topic_aliases(topic_id);

CREATE TABLE signal_topic_links (
  signal_id uuid NOT NULL REFERENCES raw_signals(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES normalized_topics(id) ON DELETE CASCADE,
  relevance numeric(5,4) NOT NULL CHECK (relevance BETWEEN 0 AND 1),
  method_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id, topic_id)
);
CREATE INDEX signal_topic_links_topic_idx ON signal_topic_links(topic_id, created_at DESC);

CREATE TABLE trend_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES normalized_topics(id),
  country_code text NOT NULL DEFAULT 'WORLDWIDE',
  language_code varchar(16),
  episode_number integer NOT NULL DEFAULT 1 CHECK (episode_number > 0),
  first_detected_at timestamptz NOT NULL,
  acceleration_started_at timestamptz,
  last_observed_at timestamptz NOT NULL,
  expired_at timestamptz,
  current_lifecycle text NOT NULL DEFAULT 'emerging' CHECK (current_lifecycle IN ('emerging', 'rising', 'accelerating', 'peaking', 'stable', 'cooling', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_id, country_code, language_code, episode_number),
  CHECK (last_observed_at >= first_detected_at)
);
CREATE INDEX trend_episodes_market_idx ON trend_episodes(country_code, current_lifecycle, last_observed_at DESC);
CREATE INDEX trend_episodes_topic_idx ON trend_episodes(topic_id, first_detected_at DESC);

CREATE TABLE trend_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES trend_episodes(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES trend_sources(id),
  observed_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  country_code text,
  language_code varchar(16),
  platform text,
  relative_interest numeric,
  observation_count integer CHECK (observation_count IS NULL OR observation_count >= 0),
  unique_publishers integer CHECK (unique_publishers IS NULL OR unique_publishers >= 0),
  engagement_total numeric,
  source_quality numeric(5,4) CHECK (source_quality BETWEEN 0 AND 1),
  coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, source_id, observed_at, country_code, language_code)
);
CREATE INDEX trend_snapshots_episode_time_idx ON trend_snapshots(episode_id, observed_at DESC);
CREATE INDEX trend_snapshots_market_time_idx ON trend_snapshots(country_code, language_code, observed_at DESC);

CREATE TABLE trend_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES trend_episodes(id) ON DELETE CASCADE,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  score_version text NOT NULL,
  trend_score smallint CHECK (trend_score BETWEEN 0 AND 100),
  confidence_score smallint CHECK (confidence_score BETWEEN 0 AND 100),
  velocity numeric(8,5),
  acceleration numeric(8,5),
  freshness numeric(8,5),
  saturation_opportunity numeric(8,5),
  geographic_strength numeric(8,5),
  cross_source_confirmation numeric(8,5),
  evidence_coverage numeric(8,5) CHECK (evidence_coverage BETWEEN 0 AND 1),
  lifecycle text NOT NULL CHECK (lifecycle IN ('emerging', 'rising', 'accelerating', 'peaking', 'stable', 'cooling', 'expired')),
  early_signal boolean NOT NULL DEFAULT false,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  thresholds_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trend_scores_episode_time_idx ON trend_scores(episode_id, calculated_at DESC);
CREATE INDEX trend_scores_rank_idx ON trend_scores(trend_score DESC NULLS LAST, confidence_score DESC NULLS LAST, calculated_at DESC);

CREATE TABLE trend_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES trend_episodes(id) ON DELETE CASCADE,
  score_id uuid REFERENCES trend_scores(id) ON DELETE SET NULL,
  signal_id uuid REFERENCES raw_signals(id) ON DELETE SET NULL,
  source_id text NOT NULL REFERENCES trend_sources(id),
  observed_at timestamptz NOT NULL,
  evidence_type text NOT NULL,
  observed_metric text,
  observed_value numeric,
  unit text,
  source_confidence numeric(5,4) CHECK (source_confidence BETWEEN 0 AND 1),
  reference_url text,
  independence_group text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trend_evidence_episode_time_idx ON trend_evidence(episode_id, observed_at DESC);

CREATE TABLE search_results (
  search_id uuid NOT NULL REFERENCES trend_searches(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES trend_episodes(id) ON DELETE RESTRICT,
  rank smallint NOT NULL CHECK (rank > 0),
  score_id uuid NOT NULL REFERENCES trend_scores(id) ON DELETE RESTRICT,
  score_at_search smallint CHECK (score_at_search BETWEEN 0 AND 100),
  confidence_at_search smallint CHECK (confidence_at_search BETWEEN 0 AND 100),
  lifecycle_at_search text NOT NULL,
  explanation text,
  result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (search_id, episode_id),
  UNIQUE (search_id, rank)
);
CREATE INDEX search_results_episode_idx ON search_results(episode_id);

CREATE TABLE saved_trends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES trend_episodes(id) ON DELETE RESTRICT,
  saved_at timestamptz NOT NULL DEFAULT now(),
  score_at_save smallint CHECK (score_at_save BETWEEN 0 AND 100),
  lifecycle_at_save text,
  note text,
  notifications_enabled boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, episode_id)
);
CREATE INDEX saved_trends_user_saved_idx ON saved_trends(user_id, saved_at DESC);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  country_code text NOT NULL DEFAULT 'WORLDWIDE',
  language_code varchar(16) NOT NULL DEFAULT 'en',
  source_filter text NOT NULL DEFAULT 'all',
  default_time_window text NOT NULL DEFAULT '24h',
  notification_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id uuid REFERENCES trend_episodes(id) ON DELETE SET NULL,
  notification_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_created_idx ON notifications(user_id, created_at DESC);

CREATE TABLE source_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES trend_sources(id),
  checked_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('healthy', 'degraded', 'unavailable', 'quota_limited', 'disabled')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  success_count integer NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  quota_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  freshness_lag_seconds integer CHECK (freshness_lag_seconds IS NULL OR freshness_lag_seconds >= 0),
  safe_error_code text
);
CREATE INDEX source_health_source_time_idx ON source_health(source_id, checked_at DESC);

CREATE TABLE cost_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id uuid REFERENCES trend_searches(id) ON DELETE SET NULL,
  request_id uuid NOT NULL,
  provider text NOT NULL,
  api_request_count integer NOT NULL DEFAULT 0 CHECK (api_request_count >= 0),
  api_cost_minor bigint NOT NULL DEFAULT 0 CHECK (api_cost_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  llm_model text,
  llm_input_tokens integer NOT NULL DEFAULT 0 CHECK (llm_input_tokens >= 0),
  llm_output_tokens integer NOT NULL DEFAULT 0 CHECK (llm_output_tokens >= 0),
  llm_cost_minor bigint NOT NULL DEFAULT 0 CHECK (llm_cost_minor >= 0),
  db_cost_estimate_minor bigint NOT NULL DEFAULT 0 CHECK (db_cost_estimate_minor >= 0),
  cache_hit boolean,
  processing_ms integer CHECK (processing_ms IS NULL OR processing_ms >= 0),
  total_estimated_cost_minor bigint NOT NULL DEFAULT 0 CHECK (total_estimated_cost_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_logs_search_idx ON cost_logs(search_id) WHERE search_id IS NOT NULL;
CREATE INDEX cost_logs_provider_created_idx ON cost_logs(provider, created_at DESC);

CREATE TABLE admin_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  request_id uuid,
  ip_prefix_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_target_time_idx ON audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX audit_logs_actor_time_idx ON audit_logs(actor_user_id, created_at DESC);

CREATE TABLE background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_owner text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX background_jobs_ready_idx ON background_jobs(state, available_at) WHERE state IN ('queued', 'retrying');

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  password_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_user_idx ON email_verifications(user_id, created_at DESC);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_secret text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent_hash text
);
CREATE INDEX sessions_user_idx ON sessions(user_id, expires_at DESC);

CREATE TABLE source_freshness (
  source_id text PRIMARY KEY REFERENCES trend_sources(id),
  status text NOT NULL,
  live_status text NOT NULL,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  latest_signal_at timestamptz,
  latency_ms integer,
  requests integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  limitation text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE intelligence_cache (
  cache_key text PRIMARY KEY,
  algorithm_version text NOT NULL,
  report jsonb NOT NULL,
  fresh_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intelligence_cache_fresh_idx ON intelligence_cache(fresh_until);

INSERT INTO trend_sources (id, display_name, adapter_version, enabled, source_weight, independent_group, license_name)
VALUES
  ('search', 'Search interest', '1.0.0', false, 0.80000, 'search', 'Requires a licensed search-trend provider'),
  ('youtube', 'YouTube', '1.0.0', false, 0.75000, 'youtube', 'YouTube API Services'),
  ('reddit', 'Reddit', '1.0.0', false, 0.65000, 'reddit', 'Reddit API'),
  ('news', 'News', '1.0.0', true, 0.80000, 'news', 'GDELT DOC 2.0'),
  ('wikipedia', 'Wikipedia attention', '1.0.0', true, 0.55000, 'wikipedia', 'Wikimedia REST API'),
  ('hackernews', 'Hacker News', '1.0.0', true, 0.40000, 'hackernews', 'HN Algolia API')
ON CONFLICT (id) DO NOTHING;

INSERT INTO admin_settings (key, value)
VALUES
  ('kts_weights', '{"velocity":30,"crossSource":20,"acceleration":15,"freshness":15,"saturation":10,"geography":10}'::jsonb),
  ('early_signal', '{"maxHours":72,"minAcceleration":0.67,"minConfidence":70,"maxSaturation":0.4,"minIndependentSources":2,"minSampleSize":10,"minScore":55}'::jsonb),
  ('cache_ttl_seconds', '{"default":900}'::jsonb),
  ('rate_limits', '{"search_per_minute":8,"auth_per_minute":8}'::jsonb)
ON CONFLICT (key) DO NOTHING;

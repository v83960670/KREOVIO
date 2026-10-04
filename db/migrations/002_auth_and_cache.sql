-- Applied only when an older database already has the initial tables.
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  password_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS source_freshness (
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

ALTER TABLE trend_searches ADD COLUMN IF NOT EXISTS report jsonb;

CREATE TABLE IF NOT EXISTS intelligence_cache (
  cache_key text PRIMARY KEY,
  algorithm_version text NOT NULL,
  report jsonb NOT NULL,
  fresh_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

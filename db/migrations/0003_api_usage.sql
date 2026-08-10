-- 0003_api_usage.sql
-- API request events (partitioned by month) + daily rollups + rollup cursor state.

-- The partition bounds below are date-only literals, resolved in the session
-- TimeZone at DDL time. Pin UTC so a fresh database bootstrapped on a server
-- with a non-UTC default gets the same absolute bounds as production (0011's
-- alignment guard depends on this). No effect where this migration is already
-- applied — apply.sh skips it by version.
SET LOCAL TimeZone = 'UTC';

CREATE TABLE api_request_events (
    id          text NOT NULL,
    project_id  text NOT NULL,
    api_key_id  text NOT NULL,
    key_prefix  text NOT NULL,
    method      text NOT NULL,
    path        text NOT NULL,
    endpoint    text NOT NULL,
    status      integer NOT NULL,
    latency_ms  integer NOT NULL,
    error_tag   text,
    ts          bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Indexes propagate to partitions.
CREATE INDEX api_request_events_by_project ON api_request_events (project_id);
CREATE INDEX api_request_events_by_project_and_ts ON api_request_events (project_id, ts);
CREATE INDEX api_request_events_by_project_and_endpoint_and_ts ON api_request_events (project_id, endpoint, ts);
CREATE INDEX api_request_events_by_api_key_and_ts ON api_request_events (api_key_id, ts);

-- Initial partitions: previous, current, next month. pg_partman or a cron handles
-- subsequent months going forward.
CREATE TABLE api_request_events_y2026m05 PARTITION OF api_request_events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE api_request_events_y2026m06 PARTITION OF api_request_events
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE api_request_events_y2026m07 PARTITION OF api_request_events
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE api_request_events_y2026m08 PARTITION OF api_request_events
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Catch-all for rows outside the pre-created partitions (historical imports,
-- partitions not yet rolled forward by the cron). A future maintenance job
-- migrates rows out of the default partition into the correct month.
CREATE TABLE api_request_events_default PARTITION OF api_request_events DEFAULT;

CREATE TABLE api_request_daily_rollups (
    id              text PRIMARY KEY,
    project_id      text NOT NULL,
    day             date NOT NULL,
    total_calls     bigint NOT NULL DEFAULT 0,
    asset_calls     bigint NOT NULL DEFAULT 0,
    success_calls   bigint NOT NULL DEFAULT 0,
    sum_latency_ms  bigint NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX api_request_daily_rollups_by_project_and_day ON api_request_daily_rollups (project_id, day);

CREATE TABLE api_request_endpoint_daily_rollups (
    id                 text PRIMARY KEY,
    project_id         text NOT NULL,
    day                date NOT NULL,
    endpoint           text NOT NULL,
    calls              bigint NOT NULL DEFAULT 0,
    success_calls      bigint NOT NULL DEFAULT 0,
    sum_latency_ms     bigint NOT NULL DEFAULT 0,
    latency_histogram  jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX api_request_endpoint_daily_rollups_by_proj_day_endpoint
    ON api_request_endpoint_daily_rollups (project_id, day, endpoint);
CREATE INDEX api_request_endpoint_daily_rollups_by_project_and_day
    ON api_request_endpoint_daily_rollups (project_id, day);

CREATE TABLE api_request_rollup_state (
    project_id            text PRIMARY KEY,
    cursor_creation_time  bigint NOT NULL DEFAULT 0,
    locked_until          bigint NOT NULL DEFAULT 0,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('0003_api_usage');

-- 0011_api_usage_partitions.sql
-- Extend api_request_events monthly partition coverage through March 2027.
--
-- 0003_api_usage.sql pre-created partitions only through August 2026
-- (upper bound 2026-09-01); from that instant every insert would silently
-- fall through to api_request_events_default, and once a month's rows sit
-- in the default partition that month's partition can no longer be created
-- with plain DDL. The create-api-usage-partitions cron on cloudrun-assets
-- rolls coverage forward from here; this migration closes the immediate gap
-- and gives the cron several months of headroom.
--
-- apply.sh runs this file inside a single transaction, so SET LOCAL applies
-- to every statement below. TimeZone is pinned so the bound literals and the
-- guard's rendered text are session-independent; lock_timeout keeps the
-- ACCESS EXCLUSIVE lock acquisition on the parent from damming the insert
-- path behind a long-running query (on timeout the whole file rolls back and
-- can simply be re-applied).
SET LOCAL TimeZone = 'UTC';
SET LOCAL lock_timeout = '5s';

-- Guard: the new partitions butt up against api_request_events_y2026m08.
-- If its live upper bound is not exactly 2026-09-01 00:00:00+00 (e.g. 0003
-- was applied under a non-UTC session TimeZone), creating m09 from that
-- instant would leave a silent coverage gap — abort loudly instead.
DO $$
DECLARE
    m08_bounds text;
BEGIN
    SELECT pg_get_expr(c.relpartbound, c.oid) INTO m08_bounds
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'api_request_events_y2026m08';

    IF m08_bounds IS NULL THEN
        RAISE EXCEPTION 'api_request_events_y2026m08 not found; 0003_api_usage must be applied first';
    END IF;
    IF m08_bounds <> 'FOR VALUES FROM (''2026-08-01 00:00:00+00'') TO (''2026-09-01 00:00:00+00'')' THEN
        RAISE EXCEPTION 'api_request_events_y2026m08 has unexpected bounds [%]; verify partition alignment before applying 0011', m08_bounds;
    END IF;
END $$;

-- IF NOT EXISTS (unlike 0003's plain CREATE): the roll-forward cron or an
-- emergency manual fix may legitimately create some of these partitions
-- before this migration is applied; a name collision must not wedge the
-- whole file. Bounds use explicit +00 offsets so the resolved instants do
-- not depend on the applying session's TimeZone.
CREATE TABLE IF NOT EXISTS api_request_events_y2026m09 PARTITION OF api_request_events
    FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS api_request_events_y2026m10 PARTITION OF api_request_events
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS api_request_events_y2026m11 PARTITION OF api_request_events
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS api_request_events_y2026m12 PARTITION OF api_request_events
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS api_request_events_y2027m01 PARTITION OF api_request_events
    FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS api_request_events_y2027m02 PARTITION OF api_request_events
    FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS api_request_events_y2027m03 PARTITION OF api_request_events
    FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');

INSERT INTO schema_migrations(version) VALUES ('0011_api_usage_partitions');

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
-- to every statement below. TimeZone and DateStyle are pinned so the bound
-- literals and the guard's pg_get_expr-rendered text are session- and
-- cluster-setting-independent; lock_timeout keeps the ACCESS EXCLUSIVE lock
-- acquisition on the parent from damming the insert path behind a
-- long-running query (on timeout the whole file rolls back and can simply be
-- re-applied).
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO';
SET LOCAL lock_timeout = '5s';

-- Guards. First: the new partitions butt up against
-- api_request_events_y2026m08 — if its live upper bound is not exactly
-- 2026-09-01 00:00:00+00 (e.g. 0003 was applied under a non-UTC session
-- TimeZone), creating m09 from that instant would leave a silent coverage
-- gap; abort loudly instead. Second: IF NOT EXISTS below skips by name only,
-- so any pre-existing relation named like a target partition must be a real
-- partition of api_request_events with exactly the expected bounds —
-- otherwise this file would record success while the coverage gap persists.
DO $$
DECLARE
    m08_bounds text;
    rec record;
    found_bounds text;
    found_parent_ok boolean;
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

    FOR rec IN
        SELECT *
        FROM (VALUES
            ('api_request_events_y2026m09', '2026-09-01 00:00:00+00', '2026-10-01 00:00:00+00'),
            ('api_request_events_y2026m10', '2026-10-01 00:00:00+00', '2026-11-01 00:00:00+00'),
            ('api_request_events_y2026m11', '2026-11-01 00:00:00+00', '2026-12-01 00:00:00+00'),
            ('api_request_events_y2026m12', '2026-12-01 00:00:00+00', '2027-01-01 00:00:00+00'),
            ('api_request_events_y2027m01', '2027-01-01 00:00:00+00', '2027-02-01 00:00:00+00'),
            ('api_request_events_y2027m02', '2027-02-01 00:00:00+00', '2027-03-01 00:00:00+00'),
            ('api_request_events_y2027m03', '2027-03-01 00:00:00+00', '2027-04-01 00:00:00+00')
        ) AS t(relname, lo, hi)
    LOOP
        SELECT pg_get_expr(c.relpartbound, c.oid),
               COALESCE(i.inhparent = 'public.api_request_events'::regclass, false)
          INTO found_bounds, found_parent_ok
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
         WHERE n.nspname = 'public' AND c.relname = rec.relname;

        IF FOUND AND (NOT found_parent_ok
                      OR found_bounds IS DISTINCT FROM format('FOR VALUES FROM (%L) TO (%L)', rec.lo, rec.hi)) THEN
            RAISE EXCEPTION '% already exists but is not a partition of api_request_events with bounds [% .. %); resolve it before applying 0011',
                rec.relname, rec.lo, rec.hi;
        END IF;
    END LOOP;
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

-- The create-api-usage-partitions cron probes the default partition daily
-- for covered-era rows (created_at >= 2026-05-01). No inherited index covers
-- created_at (the PK leads with id), so without this the probe is a
-- sequential scan of whatever sits in the default partition — 0003
-- explicitly anticipates historical imports living there. Index only this
-- partition; the hot-path monthly partitions are unaffected.
CREATE INDEX IF NOT EXISTS api_request_events_default_created_at_idx
    ON api_request_events_default (created_at);

INSERT INTO schema_migrations(version) VALUES ('0011_api_usage_partitions');

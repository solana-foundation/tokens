-- Per (mint, interval) refresh bookkeeping for the curated OHLCV crons.
--
-- The refresh picked mints by a deterministic rotating window, so a mint's
-- turn came around on a fixed cadence regardless of how stale its candles
-- were, and a mint with no trades in the window (no candle to store) was
-- re-fetched every single run. Recording attempts lets the cron pick the
-- stalest mints first and treat "fetched, nothing to store" as refreshed.
--
-- last_attempted_at: any attempt (success, empty, or provider error).
-- last_refreshed_at: last attempt that completed without error.
-- last_candle_time:  newest candle time known after that attempt (unix s).
CREATE TABLE IF NOT EXISTS ohlcv_refresh_state (
    address           text   NOT NULL,
    interval          text   NOT NULL CHECK (interval IN ('1m','5m','15m','1H','4H','1D','1W')),
    last_attempted_at bigint NOT NULL,
    last_refreshed_at bigint,
    last_candle_time  bigint,
    PRIMARY KEY (address, interval)
);

CREATE INDEX IF NOT EXISTS ohlcv_refresh_state_by_interval_attempted
    ON ohlcv_refresh_state (interval, last_attempted_at);

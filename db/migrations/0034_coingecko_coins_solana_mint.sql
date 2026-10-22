-- 0034: look up a CoinGecko coin by its Solana mint.
--
-- Why: `GET /v1/news/feed?mint=<mint>` resolves the CoinGecko coin id on the
-- API side so partners can get coin-specific news for mints that are not
-- registered as tokens.xyz assets (JUP, BONK, PENGU, ...). `coingecko_coins`
-- already carries every coin's platform contract map from the
-- `/coins/list?include_platform=true` sync; this is just the index for the
-- `platforms->>'solana' = $mint` predicate so the lookup is a point read
-- rather than a scan over the whole catalog.
--
-- Apply manually (db/apply.sh), stg then prd. Additive and idempotent; the
-- read path degrades to a seq scan (not an error) if the image ships first.

CREATE INDEX IF NOT EXISTS coingecko_coins_by_solana_mint
    ON coingecko_coins ((platforms->>'solana'));

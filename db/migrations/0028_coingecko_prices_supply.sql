-- Canonical (cross-chain) supply + FDV on the CoinGecko price snapshot.
--
-- `asset.stats.totalSupply/circulatingSupply` are the ON-SOLANA tokenized
-- supply summed over variants (BTC on Solana ≈ 5.8k, SOL null because the
-- wSOL mint reports none). The canonical figures — BTC 21M max supply,
-- SOL circulating — only existed in the metadata doc (`/profile`), refreshed
-- for 25 coins per 6h. The 5-minute prices cron now reads `/coins/markets`,
-- which carries them, so they ride along on `coingecko_prices_latest`.
--
-- Nullable + additive; the next cron run fills every curated coin.
ALTER TABLE coingecko_prices_latest
    ADD COLUMN IF NOT EXISTS circulating_supply double precision,
    ADD COLUMN IF NOT EXISTS total_supply       double precision,
    ADD COLUMN IF NOT EXISTS max_supply         double precision,
    ADD COLUMN IF NOT EXISTS fdv_usd            double precision;

-- 0037: per-variant shares behind a computed 30d chain rollup.
--
-- Why: rollup-v2-chain-volume-30d sums every active variant's daily samples,
-- while the API's quality guard leaves rejected rows (stale, dust, price
-- outliers) out of the 24h figures. With each address's 30d volume and sampled
-- day count on the row, the API serves the 30d figure over the same accepted
-- rows: it subtracts a rejected row's share and judges window completeness
-- over the accepted variants only.
--
-- Apply manually (db/apply.sh), stg then prd, after 0036 and BEFORE deploying
-- the worker image of the cross-chain 30d volume change (its rollup writes
-- and its reads select this column). Additive and idempotent.
-- Runbook: docs/operations/v2-multichain-assets.md

-- { "<address>": { "volume": <usd over the window>, "days": <distinct sampled days> } }
ALTER TABLE v2_asset_chain_markets_latest ADD COLUMN IF NOT EXISTS volume_30d_by_address jsonb;

INSERT INTO schema_migrations (version) VALUES ('0037_v2_volume_30d_by_address') ON CONFLICT DO NOTHING;

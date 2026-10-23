locals {
  # v2 multichain assets (docs/operations/v2-multichain-assets.md): the three
  # worker jobs that populate the chain-first tables from migration 0033
  # (v2_asset_variants, v2_variant_markets_latest, v2_asset_chain_markets_latest).
  #
  #   sync-v2-solana-variants        set-based mirror of v1's Solana rows
  #                                  (asset_variants / variant_markets_latest /
  #                                  asset_markets_latest) into the v2 tables.
  #                                  No provider calls; every 5 min in prd.
  #   sync-v2-evm-variants           derives EVM variants for registered assets
  #                                  from coingecko_coins.platforms plus the
  #                                  registry's native-coin table. Daily.
  #   refresh-v2-evm-variant-markets per-chain Birdeye token-overview snapshots
  #                                  for the stalest EVM variants. Every 15 min
  #                                  in prd (minAgeMs keeps a row to ~1 fetch/h).
  #
  # Minute offsets stagger the two frequent jobs from the `*/10`
  # refresh-asset-variant-markets tick (whose output the Solana mirror copies),
  # the `1-59/5` CoinGecko price refresh, the `9-59/15` logo-sync, the `23`
  # solana-data sync and the `4-` / `7-` prestocks / launchpad crons. The job
  # group is `404 v2_assets_jobs_disabled` when BIRDEYE_API_KEY is missing on
  # the worker; no new secrets or env are needed.
  v2_assets_cron_jobs = [
    {
      name             = "sync-v2-solana-variants"
      schedule         = var.env == "stg" ? "*/30 * * * *" : "3-58/5 * * * *"
      http_path        = "/jobs/sync-v2-solana-variants"
      body_json        = jsonencode({})
      attempt_deadline = "180s"
      retry_count      = 0
    },
    {
      name      = "sync-v2-evm-variants"
      schedule  = "10 6 * * *"
      http_path = "/jobs/sync-v2-evm-variants"
      body_json = jsonencode({
        maxAssets = 5000
      })
      attempt_deadline = "540s"
      retry_count      = 1
    },
    {
      name      = "refresh-v2-evm-variant-markets"
      schedule  = var.env == "stg" ? "20 3 * * *" : "7-59/15 * * * *"
      http_path = "/jobs/refresh-v2-evm-variant-markets"
      body_json = jsonencode({
        maxVariants   = 400
        minAgeMs      = 900000
        emptyMinAgeMs = 3600000
        concurrency   = 2
        delayMs       = 150
        budgetMs      = 500000
      })
      attempt_deadline = "540s"
      retry_count      = 0
    },
    {
      # Daily: sums the last 30 UTC days of per-variant volume samples into the
      # `computed` chain rollup rows (EVM 30d volume; Solana's is mirrored from v1).
      name             = "rollup-v2-chain-volume-30d"
      schedule         = "25 0 * * *"
      http_path        = "/jobs/rollup-v2-chain-volume-30d"
      body_json        = jsonencode({ retentionDays = 45 })
      attempt_deadline = "300s"
      retry_count      = 1
    },
  ]
}

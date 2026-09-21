locals {
  launchpad_cron_jobs = [
    {
      # stonk.fun launches quoted in curated tokens (surfaced on the quote
      # asset's page). ~22 unauthenticated page reads per run plus up to
      # `newMintBirdeyeBudget` Birdeye overview calls for coins seen for the
      # first time (identity/decimals). Minute offset staggers it from the
      # `*/10` variant-market refresh and the `4-` prestocks cron.
      name      = "sync-stonkfun-launches"
      schedule  = "7-59/15 * * * *"
      http_path = "/jobs/sync-stonkfun-launches"
      body_json = jsonencode({
        newMintBirdeyeBudget = 25
        minMarketCapUsd      = 25000
        minVolume24hUsd      = 10000
      })
      attempt_deadline = "540s"
    },
  ]
}

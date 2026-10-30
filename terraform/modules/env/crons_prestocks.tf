locals {
  prestocks_cron_jobs = [
    {
      # PreStocks reference data (mark price/valuation) for tokenized pre-IPO
      # equities — one unauthenticated GET of the /api/prestocks list endpoint
      # per run, filtered to our PRE_STOCKS allowlist. Minute offset staggers
      # this from the `2-` (stock prices) and `3-` (trade snapshots) crons.
      # The handler is a no-op unless PRESTOCKS_REFRESH_ENABLED=true is set on
      # the assets service (managed out-of-band, like the other refresh flags).
      name      = "refresh-prestocks-prices"
      schedule  = "4-59/5 * * * *"
      http_path = "/jobs/refresh-prestocks-prices"
      body_json = jsonencode({
        requireRefreshEnabled = true
      })
      attempt_deadline = "120s"
    },
  ]
}

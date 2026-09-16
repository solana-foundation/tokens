locals {
  webacy_depeg_cron_jobs = [
    {
      # Reconciliation sweep for the Webacy stablecoin depeg monitor. Webhooks
      # (DEPEG_TIER_CHANGE, received by the usage service) are the primary
      # trigger; this sweep covers missed deliveries, cooldown-based clears,
      # coverage gaps and vendor-incident detection, so it runs every few hours
      # rather than every few minutes. Minute offset 17 keeps it off the
      # `*/5` and `*/10` market crons.
      #
      # The handler is a no-op unless WEBACY_DEPEG_REFRESH_ENABLED=true is set
      # on the assets worker (managed out-of-band like the other refresh flags).
      # `dryRun` in the body decides whether advisories are written; the webhook
      # nudge omits it and reads WEBACY_DEPEG_DRY_RUN on the worker instead, so
      # flip both together at go-live.
      name = "reconcile-stablecoin-depeg"
      # Staging polls half as often (same inline-env precedent as main.tf).
      schedule  = var.env == "stg" ? "17 */12 * * *" : var.webacy_depeg_sweep_schedule
      http_path = "/jobs/reconcile-stablecoin-depeg"
      body_json = jsonencode({
        requireRefreshEnabled = true
        dryRun                = var.webacy_depeg_dry_run
        trigger               = "sweep"
        pageSize              = 200
        maxPages              = var.webacy_depeg_max_pages
        budgetMs              = 90000
      })
      attempt_deadline = "120s"
      # One retry: a transient Webacy error is worth a second try, but the next
      # tick is only a few hours away and the webhook path is still live.
      retry_count = 1
    },
    {
      # Daily Webacy v3 structural health grades for every tracked stablecoin
      # (depeg-monitored registry mints plus the `currencies` curated list).
      name      = "refresh-stablecoin-structural-health"
      schedule  = "20 5 * * *"
      http_path = "/jobs/refresh-stablecoin-structural-health"
      body_json = jsonencode({
        requireRefreshEnabled = true
        batchSize             = 100
        budgetMs              = 300000
      })
      attempt_deadline = "360s"
    },
  ]
}

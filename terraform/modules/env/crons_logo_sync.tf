locals {
  # First-party logo re-hosting (docs/operations/logo-sync.md). Every run takes
  # up to `limit` mints (curated first, then anything with a logo fetched in the
  # last 30 days), fetches the artwork (Pinata gateway for IPFS refs, origin
  # unless it is a public gateway, dexscreener, Jupiter), normalises it to 256px
  # WebP and uploads to the public asset-logo bucket. Staging runs once a day.
  # Minute offset staggers it from the `*/10` variant-market refresh, the `4-`
  # prestocks cron and the `7-` launchpad sync.
  logo_sync_cron_jobs = [
    {
      name      = "logo-sync"
      schedule  = var.env == "stg" ? "35 3 * * *" : "9-59/15 * * * *"
      http_path = "/jobs/logo-sync"
      body_json = jsonencode({
        limit       = 200
        concurrency = 3
        budgetMs    = 480000
      })
      attempt_deadline = "540s"
      retry_count      = 1
    },
  ]

  # Plain env for the job (both the assets API service and the jobs worker,
  # since Scheduler can route to either). Secret ref: PINATA_GATEWAY_TOKEN.
  # Note: Cloud Run env is under lifecycle.ignore_changes, so on existing
  # services these land via `gcloud run services update` + sync-assets-worker-env.sh.
  logo_sync_env_vars = merge(
    var.pinata_gateway_host != "" ? { PINATA_GATEWAY_HOST = var.pinata_gateway_host } : {},
    var.logo_public_base_url != "" ? { GCS_LOGO_PUBLIC_BASE_URL = var.logo_public_base_url } : {},
  )

  logo_sync_secret_env_vars = {
    PINATA_GATEWAY_TOKEN = {
      secret_id = module.secrets.pinata_gateway_token_secret_id
    }
  }
}

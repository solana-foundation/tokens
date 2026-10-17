locals {
  # Project Canon asset registry (docs/operations/solana-data-registry.md): one
  # GET data.solana.com/v1/assets per run (~3.3k rows, one body), upsert into
  # solana_data_assets_latest, then up to providerLimit/50 Birdeye meta-data calls
  # for mints the platform has no logo for. Hourly in prd; the data team
  # regenerates a few times a day at most. Minute offset staggers it from the
  # `*/10` variant-market refresh and the `4-` / `7-` / `9-` crons.
  solana_data_cron_jobs = [
    {
      name      = "sync-solana-data-assets"
      schedule  = var.env == "stg" ? "23 */6 * * *" : "23 * * * *"
      http_path = "/jobs/sync-solana-data-assets"
      body_json = jsonencode({
        providerLimit = 500
        budgetMs      = 300000
      })
      attempt_deadline = "360s"
      retry_count      = 1
    },
  ]

  # Secret ref for the job (both the assets API service and the jobs worker,
  # since Scheduler can route to either). Note: Cloud Run env is under
  # lifecycle.ignore_changes, so on existing services it lands via
  # `gcloud run services update --update-secrets` + sync-assets-worker-env.sh.
  solana_data_secret_env_vars = {
    SOLANA_DATA_API_KEY = {
      secret_id = module.secrets.solana_data_api_key_secret_id
    }
  }
}

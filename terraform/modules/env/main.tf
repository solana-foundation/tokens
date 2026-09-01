module "iam" {
  source = "../iam"

  project_id     = var.project_id
  project_number = var.project_number
  env            = var.env
}

module "network" {
  source = "../network"

  project_id  = var.project_id
  region      = var.region
  env         = var.env
  name_suffix = var.name_suffix
  flow_logs   = var.assets_db_flow_logs
}

module "artifact_registry" {
  source = "../artifact_registry"

  project_id = var.project_id
  region     = var.region
  env        = var.env
}

module "cloud_sql" {
  source = "../cloud_sql"

  project_id          = var.project_id
  region              = var.region
  env                 = var.env
  name_suffix         = var.name_suffix
  vpc_self_link       = module.network.vpc_self_link
  psa_connection      = module.network.psa_connection
  tier                = var.cloud_sql_tier
  availability_type   = var.cloud_sql_availability_type
  max_connections     = var.cloud_sql_max_connections
  disk_size_gb        = var.cloud_sql_disk_size_gb
  deletion_protection = var.cloud_sql_deletion_protection
}

module "memorystore" {
  source = "../memorystore"

  project_id              = var.project_id
  region                  = var.region
  env                     = var.env
  name_suffix             = var.name_suffix
  vpc_id                  = module.network.vpc_id
  psa_connection          = module.network.psa_connection
  tier                    = var.memorystore_tier
  memory_size_gb          = var.memorystore_memory_size_gb
  connect_mode            = var.redis_connect_mode
  transit_encryption_mode = var.redis_transit_encryption_mode
  auth_enabled            = var.redis_auth_enabled
}

module "secrets" {
  source = "../secrets"

  project_id        = var.project_id
  env               = var.env
  region            = var.region
  runtime_sa_email  = module.iam.cloud_run_runtime_sa_email
  sql_app_user      = module.cloud_sql.app_user
  sql_app_password  = module.cloud_sql.app_password
  sql_private_ip    = module.cloud_sql.private_ip
  sql_database_name = module.cloud_sql.database_name
}

module "cloud_run" {
  source   = "../cloud_run"
  for_each = toset(var.cloud_run_services)

  project_id          = var.project_id
  region              = var.region
  env                 = var.env
  name_suffix         = var.name_suffix
  service_name        = each.value
  runtime_sa_email    = module.iam.cloud_run_runtime_sa_email
  network_id          = module.network.vpc_id
  subnet_id           = module.network.subnet_id
  max_instances       = var.cloud_run_max_instances
  request_concurrency = each.value == "assets" ? var.cloud_run_assets_request_concurrency : 80
  # `usage` hosts Cloud Scheduler cron endpoints — Scheduler sends from GCP-managed
  # infra outside the VPC, so it can't reach an INTERNAL_LOAD_BALANCER ingress.
  # OIDC auth at the handler still gates access.
  ingress = each.value == "usage" ? "INGRESS_TRAFFIC_ALL" : var.cloud_run_ingress

  # `assets` hosts every Cloud Scheduler cron handler (see scheduler_jobs below).
  # The longest cron attempt_deadline is 540s, but Cloud Run's default request
  # timeout is 300s — which killed refresh-solana-clickhouse-trade-snapshots at
  # exactly 300s (504) on every single run. Keep this >= the longest
  # attempt_deadline of any cron routed at the service.
  request_timeout = each.value == "assets" ? "540s" : "300s"

  cpu                    = each.value == "assets" ? var.cloud_run_assets_cpu : "1"
  memory                 = each.value == "assets" ? var.cloud_run_assets_memory : "512Mi"
  startup_probe_path     = each.value == "assets" && var.enable_assets_db_startup_probe ? "/startup" : null
  startup_probe_tcp_port = each.value == "assets" && !var.enable_assets_db_startup_probe ? 8080 : null

  min_instances       = each.value == "assets" ? var.cloud_run_assets_min_instances : (contains(var.cloud_run_min_instance_services, each.value) ? 1 : 0)
  deletion_protection = var.cloud_run_deletion_protection

  # Bearer-token (TOKENS_CLOUDRUN_AUTH_TOKEN) at the handler layer is the auth gate.
  # Per-service opt-in: only services listed in cloud_run_unauthenticated_services
  # get the allUsers/run.invoker binding. Admin is intentionally NOT in the stg list
  # so it stays IAM-gated regardless of ingress mode.
  allow_unauthenticated = contains(var.cloud_run_unauthenticated_services, each.value)

  env_vars = merge(
    {
      NODE_ENV        = "production"
      TOKENS_ENV      = var.env
      GCP_PROJECT     = var.project_id
      GCP_REGION      = var.region
      REDIS_HOST      = module.memorystore.host
      REDIS_PORT      = tostring(module.memorystore.port)
      SQL_INSTANCE    = module.cloud_sql.connection_name
      SQL_DATABASE    = module.cloud_sql.database_name
      SQL_USER        = module.cloud_sql.app_user
      GCS_LOGO_BUCKET = "tokens-asset-logos-${var.env}"
    },
    each.value == "assets" ? {
      SERVICE_ROLE       = "api"
      PG_POOL_MAX        = "16"
      PG_CONNECT_TIMEOUT = "3"
    } : {},
  )

  secret_env_vars = merge(
    {
      DATABASE_URL = {
        secret_id = module.secrets.database_url_secret_id
      }
      TOKENS_CLOUDRUN_AUTH_TOKEN = {
        secret_id = module.secrets.cloudrun_auth_token_secret_id
      }
    },
    # Usage-service-only secrets: key reveal encryption (dashboard reset/reveal)
    # and the /hooks/* observability ingest. Versions seeded out-of-band — see
    # modules/secrets.
    each.value == "usage" ? merge(
      {
        TOKENS_API_KEY_ENCRYPTION_SECRET = {
          secret_id = module.secrets.api_key_encryption_secret_id
        }
      },
      { for name, id in module.secrets.usage_hooks_secret_ids : name => { secret_id = id } }
    ) : {}
  )
}

# Isolated Scheduler worker. It deliberately starts disabled: the assets API
# currently has several provider credentials managed out-of-band, and routing
# jobs before those credentials are mirrored would silently disable them.
module "cloud_run_assets_jobs" {
  source = "../cloud_run"
  count  = var.enable_assets_worker ? 1 : 0

  project_id       = var.project_id
  region           = var.region
  env              = var.env
  name_suffix      = var.name_suffix
  service_name     = "assets-jobs"
  image            = module.cloud_run["assets"].image
  runtime_sa_email = module.iam.cloud_run_runtime_sa_email
  network_id       = module.network.vpc_id
  subnet_id        = module.network.subnet_id

  ingress             = "INGRESS_TRAFFIC_ALL"
  request_timeout     = "540s"
  request_concurrency = 2
  cpu                 = "8"
  memory              = "8Gi"
  min_instances       = 0
  max_instances       = 2
  deletion_protection = var.cloud_run_deletion_protection
  startup_probe_path  = "/startup"

  env_vars = {
    NODE_ENV           = "production"
    TOKENS_ENV         = var.env
    GCP_PROJECT        = var.project_id
    GCP_REGION         = var.region
    REDIS_HOST         = module.memorystore.host
    REDIS_PORT         = tostring(module.memorystore.port)
    SQL_INSTANCE       = module.cloud_sql.connection_name
    SQL_DATABASE       = module.cloud_sql.database_name
    SQL_USER           = module.cloud_sql.app_user
    GCS_LOGO_BUCKET    = "tokens-asset-logos-${var.env}"
    SERVICE_ROLE       = "worker"
    PG_POOL_MAX        = "8"
    PG_CONNECT_TIMEOUT = "3"
  }

  secret_env_vars = {
    DATABASE_URL = {
      secret_id = module.secrets.database_url_secret_id
    }
    TOKENS_CLOUDRUN_AUTH_TOKEN = {
      secret_id = module.secrets.cloudrun_auth_token_secret_id
    }
  }
}

locals {
  assets_jobs_service_url  = var.route_assets_jobs_to_worker ? module.cloud_run_assets_jobs[0].url : module.cloud_run["assets"].url
  assets_jobs_service_name = var.route_assets_jobs_to_worker ? module.cloud_run_assets_jobs[0].service_name : module.cloud_run["assets"].service_name
}

module "scheduler_tasks" {
  source = "../scheduler_tasks"

  project_id         = var.project_id
  region             = var.region
  env                = var.env
  scheduler_sa_email = module.iam.scheduler_sa_email
  tasks_sa_email     = module.iam.tasks_sa_email
  usage_service_url  = module.cloud_run["usage"].url
}

# Cloud Scheduler invokes the `usage` service via OIDC. Without
# roles/run.invoker on the Scheduler SA, Cloud Run returns 403 before any
# handler runs.
resource "google_cloud_run_v2_service_iam_member" "scheduler_invokes_usage" {
  project  = var.project_id
  location = var.region
  name     = module.cloud_run["usage"].service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.iam.scheduler_sa_email}"
}

# Cloud Tasks targets the same usage handlers (deferred work fan-out).
resource "google_cloud_run_v2_service_iam_member" "tasks_invokes_usage" {
  project  = var.project_id
  location = var.region
  name     = module.cloud_run["usage"].service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.iam.tasks_sa_email}"
}

module "scheduler_jobs" {
  source = "../scheduler_jobs"
  count  = var.enable_crons ? 1 : 0

  project_id       = var.project_id
  region           = var.region
  env              = var.env
  service_url      = local.assets_jobs_service_url
  invoker_sa_email = module.iam.scheduler_sa_email

  jobs = concat(local.coingecko_cron_jobs, local.clickhouse_cron_jobs, local.prestocks_cron_jobs, local.depth_cron_jobs, [
    {
      name      = "refresh-asset-variant-markets"
      schedule  = var.env == "stg" ? "15 2 * * *" : "*/10 * * * *"
      http_path = "/jobs/refresh-asset-variant-markets"
      body_json = jsonencode({
        priorityCount     = 75
        maxMints          = 250
        minAgeMs          = 3300000
        concurrency       = 3
        delayMs           = 100
        selectionWindowMs = 600000
        budgetMs          = 260000
      })
      attempt_deadline = "300s"
    },
    {
      name      = "refresh-asset-aggregates"
      schedule  = "0-59/5 * * * *"
      http_path = "/jobs/refresh-asset-aggregates"
      body_json = jsonencode({
        maxAssets         = 1000
        minAgeMs          = 240000
        concurrency       = 2
        delayMs           = 150
        selectionWindowMs = 300000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
      # High-frequency job: the next scheduled tick is the retry; a 500 must not
      # stack scheduler retries on top of a 1-5 minute cadence.
      retry_count = 0
    },
    {
      name      = "refresh-stale-asset-variant-markets"
      schedule  = var.env == "stg" ? "45 2 * * *" : "2-59/10 * * * *"
      http_path = "/jobs/refresh-stale-asset-variant-markets"
      body_json = jsonencode({
        maxVariants = 250
        minAgeMs    = 3600000
        concurrency = 2
        delayMs     = 200
        budgetMs    = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name             = "sync-sanctum-lsts"
      schedule         = "50 */6 * * *"
      http_path        = "/jobs/sync-sanctum-lsts"
      body_json        = "{}"
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-curated-asset-risk"
      schedule  = "30 */6 * * *"
      http_path = "/jobs/refresh-curated-asset-risk"
      body_json = jsonencode({
        maxMints          = 20
        minAgeMs          = 21600000
        concurrency       = 2
        delayMs           = 250
        selectionWindowMs = 21600000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name             = "seed-canonical-assets-registry"
      schedule         = "0 3 * * *"
      http_path        = "/jobs/seed-canonical-assets-registry"
      body_json        = "{}"
      attempt_deadline = "540s"
    },
    {
      name      = "backfill-missing-asset-identity"
      schedule  = "0 */6 * * *"
      http_path = "/jobs/backfill-missing-asset-identity"
      body_json = jsonencode({
        concurrency = 2
        delayMs     = 150
        budgetMs    = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-fresh-trending-markets"
      schedule  = "1-59/2 * * * *"
      http_path = "/jobs/refresh-fresh-trending-markets"
      body_json = jsonencode({
        maxMints              = 1500
        limit                 = 50
        concurrency           = 3
        requireRefreshEnabled = true
        budgetMs              = 260000
      })
      attempt_deadline = "300s"
      # High-frequency job: the next scheduled tick is the retry; a 500 must not
      # stack scheduler retries on top of a 1-5 minute cadence.
      retry_count = 0
    },
    {
      name      = "refresh-clickhouse-variant-market-metrics"
      schedule  = "* * * * *"
      http_path = "/jobs/refresh-clickhouse-variant-market-metrics"
      body_json = jsonencode({
        maxMints              = 500
        chunkSize             = 100
        delayMs               = 100
        requireRefreshEnabled = true
        budgetMs              = 150000
      })
      attempt_deadline = "180s"
      # High-frequency job: the next scheduled tick is the retry; a 500 must not
      # stack scheduler retries on top of a 1-5 minute cadence.
      retry_count = 0
    },
    {
      name      = "refresh-solana-clickhouse-trending-markets"
      schedule  = "4-59/5 * * * *"
      http_path = "/jobs/refresh-solana-clickhouse-trending-markets"
      body_json = jsonencode({
        maxMints              = 1000
        concurrency           = 3
        delayMs               = 25
        requireRefreshEnabled = true
        budgetMs              = 260000
      })
      attempt_deadline = "300s"
    },
    {
      name      = "refresh-clickhouse-fill-quality-variants"
      schedule  = "20 */6 * * *"
      http_path = "/jobs/refresh-clickhouse-fill-quality-variants"
      body_json = jsonencode({
        maxMints              = 1000
        concurrency           = 3
        delayMs               = 25
        requireRefreshEnabled = true
        budgetMs              = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-solana-clickhouse-ohlcv-15m"
      schedule  = "*/15 * * * *"
      http_path = "/jobs/refresh-solana-clickhouse-ohlcv-15m"
      body_json = jsonencode({
        interval              = "15m"
        days                  = 7
        maxMints              = 25
        priorityCount         = 5
        concurrency           = 1
        delayMs               = 500
        selectionWindowMs     = 900000
        requireRefreshEnabled = true
        budgetMs              = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-solana-clickhouse-ohlcv-1h"
      schedule  = "7 * * * *"
      http_path = "/jobs/refresh-solana-clickhouse-ohlcv-1h"
      body_json = jsonencode({
        interval              = "1H"
        days                  = 30
        maxMints              = 25
        priorityCount         = 5
        concurrency           = 1
        delayMs               = 500
        selectionWindowMs     = 3600000
        requireRefreshEnabled = true
        budgetMs              = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-solana-clickhouse-ohlcv-4h"
      schedule  = "10 */4 * * *"
      http_path = "/jobs/refresh-solana-clickhouse-ohlcv-4h"
      body_json = jsonencode({
        interval              = "4H"
        days                  = 90
        maxMints              = 25
        priorityCount         = 5
        concurrency           = 1
        delayMs               = 500
        selectionWindowMs     = 14400000
        requireRefreshEnabled = true
        budgetMs              = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-solana-clickhouse-ohlcv-1d"
      schedule  = "30 0 * * *"
      http_path = "/jobs/refresh-solana-clickhouse-ohlcv-1d"
      body_json = jsonencode({
        interval              = "1D"
        days                  = 365
        maxMints              = 25
        priorityCount         = 5
        concurrency           = 1
        delayMs               = 500
        selectionWindowMs     = 86400000
        requireRefreshEnabled = true
        budgetMs              = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-solana-clickhouse-ohlcv-1w"
      schedule  = "45 1 * * 1"
      http_path = "/jobs/refresh-solana-clickhouse-ohlcv-1w"
      body_json = jsonencode({
        interval              = "1W"
        days                  = 1095
        maxMints              = 25
        priorityCount         = 5
        concurrency           = 1
        delayMs               = 500
        selectionWindowMs     = 604800000
        requireRefreshEnabled = true
        budgetMs              = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-public-equity-stock-ohlcv-1h"
      schedule  = "15 * * * *"
      http_path = "/jobs/refresh-public-equity-stock-ohlcv-1h"
      body_json = jsonencode({
        interval          = "1H"
        days              = 90
        maxAssets         = 250
        concurrency       = 2
        delayMs           = 100
        selectionWindowMs = 3600000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-public-equity-stock-ohlcv-4h"
      schedule  = "20 */12 * * *"
      http_path = "/jobs/refresh-public-equity-stock-ohlcv-4h"
      body_json = jsonencode({
        interval          = "4H"
        days              = 365
        maxAssets         = 250
        concurrency       = 2
        delayMs           = 100
        selectionWindowMs = 43200000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-public-equity-stock-ohlcv-1d"
      schedule  = "25 1 * * *"
      http_path = "/jobs/refresh-public-equity-stock-ohlcv-1d"
      body_json = jsonencode({
        interval          = "1D"
        days              = 365
        maxAssets         = 250
        concurrency       = 2
        delayMs           = 100
        selectionWindowMs = 86400000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "rollup-active-api-usage"
      schedule  = "1-59/5 * * * *"
      http_path = "/jobs/rollup-active-api-usage"
      body_json = jsonencode({
        lookbackMinutes     = 15
        maxProjects         = 100
        maxEventsPerProject = 5000
        budgetMs            = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "prune-api-request-events"
      schedule  = "10 */6 * * *"
      http_path = "/jobs/prune-api-request-events"
      body_json = jsonencode({
        retentionDays       = 30
        batchSizePerProject = 5000
        maxProjects         = 100
        budgetMs            = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-curated-ohlcv-15m"
      schedule  = "6,36 * * * *"
      http_path = "/jobs/refresh-curated-ohlcv-15m"
      body_json = jsonencode({
        interval          = "15m"
        days              = 1
        priorityCount     = 50
        maxMints          = 1
        concurrency       = 2
        delayMs           = 200
        selectionWindowMs = 1800000
        upsertChunkSize   = 1000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-curated-ohlcv-1h"
      schedule  = "12,42 * * * *"
      http_path = "/jobs/refresh-curated-ohlcv-1h"
      body_json = jsonencode({
        interval          = "1H"
        days              = 90
        priorityCount     = 25
        maxMints          = 150
        concurrency       = 2
        delayMs           = 200
        selectionWindowMs = 1800000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-curated-ohlcv-4h"
      schedule  = var.env == "stg" ? "5 3 * * *" : "40 */6 * * *"
      http_path = "/jobs/refresh-curated-ohlcv-4h"
      body_json = jsonencode({
        interval          = "4H"
        days              = 365
        priorityCount     = 25
        maxMints          = 150
        concurrency       = 2
        delayMs           = 200
        selectionWindowMs = 21600000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-curated-ohlcv-1d"
      schedule  = var.env == "stg" ? "25 3 * * *" : "30 */6 * * *"
      http_path = "/jobs/refresh-curated-ohlcv-1d"
      body_json = jsonencode({
        interval          = "1D"
        days              = 365
        priorityCount     = 25
        maxMints          = 200
        concurrency       = 2
        delayMs           = 200
        selectionWindowMs = 21600000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name      = "refresh-curated-ohlcv-1w"
      schedule  = var.env == "stg" ? "45 3 * * *" : "10 1 * * *"
      http_path = "/jobs/refresh-curated-ohlcv-1w"
      body_json = jsonencode({
        interval          = "1W"
        days              = 365
        priorityCount     = 25
        maxMints          = 200
        concurrency       = 2
        delayMs           = 200
        selectionWindowMs = 86400000
        budgetMs          = 500000
      })
      attempt_deadline = "540s"
    },
    {
      name             = "refresh-solana-default-variants-view"
      schedule         = "17,47 * * * *"
      http_path        = "/jobs/refresh-solana-default-variants-view"
      body_json        = "{}"
      attempt_deadline = "540s"
    },
  ])
}

# Cloud Scheduler invokes the isolated worker when enabled, otherwise the
# existing assets service during the credential-mirroring transition.
resource "google_cloud_run_v2_service_iam_member" "scheduler_invokes_assets" {
  count = var.enable_crons ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = local.assets_jobs_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.iam.scheduler_sa_email}"
}

module "observability" {
  source = "../observability"

  project_id              = var.project_id
  env                     = var.env
  name_suffix             = var.name_suffix
  push_target_service_url = module.cloud_run["admin"].url
}

# Pub/Sub's OIDC push identity must pass Cloud Run IAM on the (IAM-locked)
# admin service before the handler re-verifies it.
resource "google_cloud_run_v2_service_iam_member" "logs_pusher_invokes_admin" {
  project  = var.project_id
  location = var.region
  name     = module.cloud_run["admin"].service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.observability.logs_pusher_sa_email}"
}

# Public asset-logo bucket. Admin curation uploads land here via V4 signed PUT
# URLs generated by cloudrun-admin; assets.image_url stores the public URL.
resource "google_storage_bucket" "asset_logos" {
  project                     = var.project_id
  name                        = "tokens-asset-logos-${var.env}"
  location                    = var.region
  uniform_bucket_level_access = true

  # Public reads from anywhere; browser PUTs (signed-URL uploads) only from
  # explicitly allowlisted origins. Signed URLs gate actual writes either way —
  # this just keeps the CORS surface no broader than needed.
  cors {
    origin          = ["*"]
    method          = ["GET"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }

  dynamic "cors" {
    for_each = length(var.asset_logo_upload_cors_origins) > 0 ? [1] : []
    content {
      origin          = var.asset_logo_upload_cors_origins
      method          = ["PUT"]
      response_header = ["Content-Type"]
      max_age_seconds = 3600
    }
  }
}

resource "google_storage_bucket_iam_member" "asset_logos_public_read" {
  bucket = google_storage_bucket.asset_logos.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_storage_bucket_iam_member" "asset_logos_runtime_writer" {
  bucket = google_storage_bucket.asset_logos.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${module.iam.cloud_run_runtime_sa_email}"
}

# V4 URL signing without a key file requires the runtime SA to be able to
# sign blobs as itself (IAM Credentials signBlob).
resource "google_service_account_iam_member" "runtime_sa_self_token_creator" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${module.iam.cloud_run_runtime_sa_email}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${module.iam.cloud_run_runtime_sa_email}"
}

module "load_balancer" {
  source = "../load_balancer"
  count  = var.enable_load_balancer ? 1 : 0

  project_id             = var.project_id
  region                 = var.region
  env                    = var.env
  domain                 = var.domain
  cloud_run_service_name = module.cloud_run["assets"].service_name
}

check "internal_ingress_should_not_be_paired_with_public_invokers" {
  assert {
    condition     = var.cloud_run_ingress != "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" || length(var.cloud_run_unauthenticated_services) == 0
    error_message = "Internal-LB ingress was selected but cloud_run_unauthenticated_services is non-empty. Loosening ingress later (e.g. for debugging) would silently expose these services publicly via the *.run.app URL because allUsers/run.invoker is still bound. Either keep the list empty or pick a non-internal ingress mode explicitly."
  }
}

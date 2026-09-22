data "google_project" "this" {}

# The isolated assets jobs worker was created out-of-band on 2026-08-19 to
# restore Cloud Scheduler /jobs/* handling (404ing since the 2026-08-14 assets
# deploy set SERVICE_ROLE=api); Terraform adopts it here, mirroring prd.
import {
  to = module.env.module.cloud_run_assets_jobs[0].google_cloud_run_v2_service.this
  id = "projects/${data.google_project.this.project_id}/locations/${var.region}/services/tokens-assets-jobs-stg-us"
}

module "env" {
  source = "../../modules/env"

  project_id     = data.google_project.this.project_id
  project_number = data.google_project.this.number
  env            = var.env
  region         = var.region
  name_suffix    = "-us"

  cloud_sql_tier                = "db-custom-1-3840"
  cloud_sql_availability_type   = "ZONAL"
  cloud_sql_disk_size_gb        = 20
  cloud_sql_deletion_protection = false

  memorystore_tier           = "BASIC"
  memorystore_memory_size_gb = 1

  cloud_run_max_instances       = 5
  cloud_run_deletion_protection = false
  cloud_run_ingress             = "INGRESS_TRAFFIC_ALL"
  cloud_run_unauthenticated_services = [
    "assets",
    "prices",
    "usage",
  ]

  # Worker cutover mirrors prd (see docs/operations/assets-db-resilience.md):
  # the worker was created out-of-band on 2026-08-19 and is adopted via the
  # import block above. The startup probe stays false pending its own rollout.
  enable_assets_db_startup_probe = false
  enable_assets_worker           = true
  route_assets_jobs_to_worker    = true

  enable_load_balancer = false
  enable_crons         = true

  # Assets logo-sync (docs/operations/logo-sync.md). Pinata dedicated gateway
  # for IPFS-hosted artwork; tokens-pinata-gateway-token-stg version seeded
  # 2026-09-22. Cloud Run env is ignore_changes, so the live value is pushed
  # with gcloud (see the runbook) — this records the desired state.
  pinata_gateway_host = "yellow-key-catshark-460.mypinata.cloud"
  # logo_public_base_url = "https://img.tokens.xyz"  # after the img host fronts the bucket
}

output "wif_provider" {
  value = module.env.wif_provider
}

output "tf_deployer_sa_email" {
  value = module.env.tf_deployer_sa_email
}

output "tf_planner_sa_email" {
  value = module.env.tf_planner_sa_email
}

output "cloudrun_deployer_sa_email" {
  value = module.env.cloudrun_deployer_sa_email
}

output "cloud_run_runtime_sa_email" {
  value = module.env.cloud_run_runtime_sa_email
}

output "artifact_registry_url" {
  value = module.env.artifact_registry_url
}

output "cloud_run_urls" {
  value = module.env.cloud_run_urls
}

output "cloud_sql_connection_name" {
  value = module.env.cloud_sql_connection_name
}

output "cloud_sql_app_password" {
  value     = module.env.cloud_sql_app_password
  sensitive = true
}

output "memorystore_host" {
  value = module.env.memorystore_host
}

output "memorystore_auth_string" {
  value     = module.env.memorystore_auth_string
  sensitive = true
}

output "cloudrun_auth_token_secret_id" {
  value = module.env.cloudrun_auth_token_secret_id
}

output "cloudrun_auth_token_value" {
  value     = module.env.cloudrun_auth_token_value
  sensitive = true
}

output "database_url_secret_id" {
  value = module.env.database_url_secret_id
}

# Vercel OIDC → WIF for the admin app (see modules/vercel_oidc). Created only
# once the Vercel project id is provided; the admin Cloud Run service stays
# IAM-gated either way.
module "vercel_oidc" {
  count  = var.vercel_admin_project_id == "" ? 0 : 1
  source = "../../modules/vercel_oidc"

  project_id         = data.google_project.this.project_id
  project_number     = data.google_project.this.number
  env                = var.env
  region             = var.region
  vercel_team_slug   = var.vercel_team_slug
  vercel_project_id  = var.vercel_admin_project_id
  vercel_environment = "preview"
  admin_service_name = "tokens-admin-${var.env}-us"
}

output "vercel_wif_audience" {
  value       = try(module.vercel_oidc[0].wif_audience, null)
  description = "Set as GCP_WIF_AUDIENCE on the Vercel tokens-admin project."
}

output "vercel_admin_invoker_sa_email" {
  value       = try(module.vercel_oidc[0].invoker_sa_email, null)
  description = "Set as GCP_ADMIN_INVOKER_SA on Vercel and TOKENS_RPC_INVOKER_SA on the Cloud Run services."
}

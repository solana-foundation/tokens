data "google_project" "this" {}

import {
  to = module.env.module.network.google_compute_subnetwork.subnet
  id = "projects/${data.google_project.this.project_id}/regions/${var.region}/subnetworks/tokens-subnet-prd-us"
}

import {
  to = module.env.module.network.google_compute_router.nat_router
  id = "projects/${data.google_project.this.project_id}/regions/${var.region}/routers/tokens-router-prd-us"
}

import {
  to = module.env.module.network.google_compute_router_nat.nat
  id = "${data.google_project.this.project_id}/${var.region}/tokens-router-prd-us/tokens-nat-prd"
}

import {
  to = module.env.module.network.google_compute_address.nat_static
  id = "projects/${data.google_project.this.project_id}/regions/${var.region}/addresses/tokens-nat-static-prd"
}

import {
  to = module.env.module.artifact_registry.google_artifact_registry_repository.containers
  id = "projects/${data.google_project.this.project_id}/locations/${var.region}/repositories/tokens-prd"
}

import {
  to = module.env.module.scheduler_tasks.google_cloud_tasks_queue.queues["prunes"]
  id = "projects/${data.google_project.this.project_id}/locations/${var.region}/queues/tokens-prunes-prd"
}

import {
  to = module.env.module.scheduler_tasks.google_cloud_tasks_queue.queues["refreshes"]
  id = "projects/${data.google_project.this.project_id}/locations/${var.region}/queues/tokens-refreshes-prd"
}

import {
  to = module.env.module.scheduler_tasks.google_cloud_tasks_queue.queues["rollups"]
  id = "projects/${data.google_project.this.project_id}/locations/${var.region}/queues/tokens-rollups-prd"
}

# The isolated assets jobs worker was created out-of-band on 2026-08-19 to
# restore Cloud Scheduler /jobs/* handling (404ing since the 2026-08-14 assets
# deploy set SERVICE_ROLE=api); Terraform adopts it here.
import {
  to = module.env.module.cloud_run_assets_jobs[0].google_cloud_run_v2_service.this
  id = "projects/${data.google_project.this.project_id}/locations/${var.region}/services/tokens-assets-jobs-prd-us"
}

module "env" {
  source = "../../modules/env"

  project_id     = data.google_project.this.project_id
  project_number = data.google_project.this.number
  env            = var.env
  region         = var.region

  name_suffix = "-us"

  redis_connect_mode            = "DIRECT_PEERING"
  redis_transit_encryption_mode = "DISABLED"
  redis_auth_enabled            = false

  cloud_sql_tier                = "db-custom-8-32768"
  cloud_sql_availability_type   = "REGIONAL"
  cloud_sql_disk_size_gb        = 100
  cloud_sql_deletion_protection = true
  cloud_sql_max_connections     = "1000"

  memorystore_tier           = "STANDARD_HA"
  memorystore_memory_size_gb = 1

  cloud_run_max_instances              = 10
  cloud_run_assets_cpu                 = "8"
  cloud_run_assets_memory              = "8Gi"
  cloud_run_assets_request_concurrency = 40
  cloud_run_min_instance_services      = ["assets", "usage"]
  cloud_run_assets_min_instances       = 3
  assets_db_flow_logs = {
    aggregation_interval = "INTERVAL_30_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
    filter_expr          = "connection.dest_ip == '172.20.2.3' && connection.dest_port == 5432"
  }
  cloud_run_ingress = "INGRESS_TRAFFIC_ALL"
  cloud_run_unauthenticated_services = [
    "assets",
    "prices",
    "usage",
  ]

  # Phase-two activation (see docs/operations/assets-db-resilience.md). The
  # startup probe stays false until its own staged rollout; the worker flags
  # match the live out-of-band cutover adopted via the import block above.
  enable_assets_db_startup_probe = false
  enable_assets_worker           = true
  route_assets_jobs_to_worker    = true

  enable_crons         = true
  enable_load_balancer = true
  domain               = "api.tokens.xyz"
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

output "lb_ip_address" {
  value = module.env.lb_ip_address
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
  vercel_environment = "production"
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

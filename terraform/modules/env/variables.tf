variable "project_id" {
  type = string
}

variable "project_number" {
  type = string
}

variable "env" {
  type = string
}

variable "region" {
  type = string
}

variable "name_suffix" {
  type        = string
  description = "Optional trailing suffix appended to regional resource names (Cloud Run services, Cloud SQL, Redis, subnet, router, VPC connector). Used by prd to carry the \"-us\" tag left over from the us-east4 migration, where the region rename recreated resources with an extra suffix. Global resources (VPC, artifact registry, buckets, secrets, IAM) always use env-only names."
  default     = ""
}

variable "redis_connect_mode" {
  type        = string
  description = "Memorystore connect mode. Create-time only: changing it forces instance replacement (cache flush + IP change that baked-in REDIS_HOST env vars won't follow). Prd pins DIRECT_PEERING to match the instance re-created during the us-east4 migration."
  default     = "PRIVATE_SERVICE_ACCESS"
}

variable "redis_transit_encryption_mode" {
  type        = string
  description = "Passed to memorystore. Create-time only — see redis_connect_mode rationale."
  default     = "SERVER_AUTHENTICATION"
}

variable "redis_auth_enabled" {
  type        = bool
  description = "Passed to memorystore. Flipping to true breaks clients that connect without an AUTH string."
  default     = true
}

variable "cloud_run_deletion_protection" {
  type    = bool
  default = true
}

variable "cloud_run_services" {
  type    = list(string)
  default = ["assets", "prices", "usage", "admin"]
}

variable "cloud_sql_tier" {
  type = string
}

variable "cloud_sql_availability_type" {
  type    = string
  default = "REGIONAL"
}

variable "cloud_sql_disk_size_gb" {
  type    = number
  default = 50
}

variable "cloud_sql_max_connections" {
  type    = string
  default = "400"
}

variable "cloud_sql_deletion_protection" {
  type    = bool
  default = true
}

variable "memorystore_tier" {
  type    = string
  default = "STANDARD_HA"
}

variable "memorystore_memory_size_gb" {
  type    = number
  default = 1
}

variable "cloud_run_max_instances" {
  type    = number
  default = 10
}

variable "cloud_run_assets_max_instances" {
  type        = number
  description = "Max instances for the `assets` Cloud Run service. Overrides cloud_run_max_instances because assets sits behind every asset read, so pegging its cap rejects requests across the whole API. Null falls back to cloud_run_max_instances."
  default     = null
}

variable "cloud_run_assets_cpu" {
  type        = string
  description = "CPU limit for the `assets` Cloud Run service. Overrides the module default because prd composite handlers (curated/search) are CPU-bound on 1 vCPU; other services stay on default."
  default     = "1"
}

variable "cloud_run_assets_memory" {
  type        = string
  description = "Memory limit for the `assets` Cloud Run service. Scales with cloud_run_assets_cpu."
  default     = "512Mi"
}

variable "cloud_run_assets_request_concurrency" {
  type        = number
  description = "Maximum concurrent requests per assets API instance."
  default     = 40
}

variable "enable_assets_db_startup_probe" {
  type        = bool
  description = "Enable the assets HTTP /startup probe only after a revision containing that endpoint is serving successfully."
  default     = false
}

variable "assets_db_flow_logs" {
  type = object({
    aggregation_interval = string
    flow_sampling        = number
    metadata             = string
    filter_expr          = string
  })
  description = "Optional subnet flow logging focused on the assets database path."
  default     = null
  nullable    = true
}

variable "cloud_run_min_instance_services" {
  type        = set(string)
  description = "Services that should keep at least one warm instance. Prevents Cloud Run autoscale-down from cutting in-flight requests when top-of-hour cron bursts trigger recycle. Prd should include the heavy-write services (`assets`, `usage`)."
  default     = []
}

variable "cloud_run_ingress" {
  type        = string
  description = "Default ingress for Cloud Run services. The `usage` service overrides this to INGRESS_TRAFFIC_ALL so Cloud Scheduler (outside the VPC) can reach its cron endpoints — OIDC auth at the handler gates access."
  default     = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
}

variable "cloud_run_unauthenticated_services" {
  type        = set(string)
  description = "Names of Cloud Run services in this env that get an allUsers/run.invoker IAM binding (i.e. their *.run.app URL is reachable without GCP IAM auth — the TOKENS_CLOUDRUN_AUTH_TOKEN bearer check at the handler is the actual auth gate). Stg lists assets/prices/usage so apps/api can hit them directly; admin is intentionally excluded so it stays IAM-gated. Prd should leave this empty and front Cloud Run with an internal LB."
  default     = []
  validation {
    condition     = alltrue([for s in var.cloud_run_unauthenticated_services : contains(["assets", "prices", "usage", "admin"], s)])
    error_message = "cloud_run_unauthenticated_services may only contain assets, prices, usage, or admin. Listing admin here is allowed but discouraged."
  }
}

variable "enable_load_balancer" {
  type    = bool
  default = false
}

variable "domain" {
  type        = string
  default     = ""
  description = "Hostname for the External LB. Required if enable_load_balancer=true."
}

variable "enable_crons" {
  type        = bool
  default     = false
  description = "When true, provision Cloud Scheduler jobs that POST to the assets Cloud Run service /jobs/* handlers. Staging-only during migration overlap (PRO-1379)."
}

variable "enable_assets_worker" {
  type        = bool
  default     = false
  description = "Provision the isolated assets Scheduler worker without changing Scheduler routing. Mirror and verify its provider credentials before enabling route_assets_jobs_to_worker."
}

variable "route_assets_jobs_to_worker" {
  type        = bool
  default     = false
  description = "Route Scheduler jobs to the provisioned assets worker after its image and provider credentials have been verified."

  validation {
    condition     = !var.route_assets_jobs_to_worker || var.enable_assets_worker
    error_message = "route_assets_jobs_to_worker requires enable_assets_worker=true."
  }
}

variable "asset_logo_upload_cors_origins" {
  type        = list(string)
  default     = []
  description = "Browser origins allowed to CORS-preflight PUTs to the asset-logo bucket (V4 signed-URL uploads from the admin app). Empty disables the PUT CORS rule entirely — operator uploads via gcloud/scripts are unaffected since CORS only applies to browsers. Set to the admin app's origin(s) when the browser upload flow ships; never use \"*\"."

  validation {
    condition     = !contains(var.asset_logo_upload_cors_origins, "*")
    error_message = "asset_logo_upload_cors_origins must list explicit origins; wildcard PUT CORS is not allowed."
  }
}


variable "cloud_run_assets_min_instances" {
  type    = number
  default = 1
}

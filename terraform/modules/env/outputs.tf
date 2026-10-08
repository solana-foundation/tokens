output "wif_provider" {
  value = module.iam.wif_provider
}

output "tf_deployer_sa_email" {
  value = module.iam.tf_deployer_sa_email
}

output "tf_planner_sa_email" {
  value = module.iam.tf_planner_sa_email
}

output "cloudrun_deployer_sa_email" {
  value = module.iam.cloudrun_deployer_sa_email
}

output "cloud_run_runtime_sa_email" {
  value = module.iam.cloud_run_runtime_sa_email
}

output "artifact_registry_url" {
  value = module.artifact_registry.repository_url
}

output "cloud_run_urls" {
  value = { for k, v in module.cloud_run : k => v.url }
}

output "cloud_sql_connection_name" {
  value = module.cloud_sql.connection_name
}

output "cloud_sql_app_password" {
  value       = module.cloud_sql.app_password
  sensitive   = true
  description = "Push into Doppler as TOKENS_SQL_PASSWORD after first apply."
}

output "memorystore_host" {
  value = module.memorystore.host
}

output "memorystore_auth_string" {
  value       = module.memorystore.auth_string
  sensitive   = true
  description = "Push into Doppler as TOKENS_REDIS_AUTH after first apply."
}

output "lb_ip_address" {
  value = var.enable_load_balancer ? module.load_balancer[0].ip_address : null
}

output "cloudrun_auth_token_secret_id" {
  value       = module.secrets.cloudrun_auth_token_secret_id
  description = "Secret Manager id holding the bearer the apps/api caller and Cloud Run services share."
}

output "cloudrun_auth_token_value" {
  value       = module.secrets.cloudrun_auth_token_value
  sensitive   = true
  description = "Generated TOKENS_CLOUDRUN_AUTH_TOKEN. Copy into Doppler tokens/<env> + Vercel apps/api after first apply."
}

output "identity_signing_secret_id" {
  value       = module.secrets.identity_signing_secret_id
  description = "Secret Manager id holding the HMAC key for the signed x-tokens-identity token (usage service)."
}

output "identity_signing_secret_value" {
  value       = module.secrets.identity_signing_secret_value
  sensitive   = true
  description = "Generated TOKENS_IDENTITY_SIGNING_SECRET. Copy into Vercel apps/app (Production = prd, Preview = stg) after first apply."
}

output "database_url_secret_id" {
  value       = module.secrets.database_url_secret_id
  description = "Secret Manager id holding the composed postgres://… connection string consumed by Cloud Run services."
}

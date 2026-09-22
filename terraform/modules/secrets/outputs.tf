output "cloudrun_auth_token_secret_id" {
  value       = google_secret_manager_secret.cloudrun_auth_token.secret_id
  description = "Secret Manager secret id (not the full resource name) for TOKENS_CLOUDRUN_AUTH_TOKEN."
}

output "cloudrun_auth_token_value" {
  value       = random_password.cloudrun_auth_token.result
  sensitive   = true
  description = "Generated bearer token. Copy into Doppler (tokens/<env>) and Vercel (apps/api) as TOKENS_CLOUDRUN_AUTH_TOKEN after first apply."
}

output "database_url_secret_id" {
  value       = google_secret_manager_secret.database_url.secret_id
  description = "Secret Manager secret id for DATABASE_URL."
}

output "api_key_encryption_secret_id" {
  value       = google_secret_manager_secret.api_key_encryption_secret.secret_id
  description = "Secret Manager secret id for TOKENS_API_KEY_ENCRYPTION_SECRET (version seeded out-of-band from Doppler; must match Convex's value)."
}

output "usage_hooks_secret_ids" {
  value = {
    LOKI_PUSH_URL        = google_secret_manager_secret.usage_hooks["loki-push-url"].secret_id
    LOKI_PUSH_AUTH       = google_secret_manager_secret.usage_hooks["loki-push-auth"].secret_id
    VERCEL_DRAIN_SECRET  = google_secret_manager_secret.usage_hooks["vercel-drain-secret"].secret_id
    CLERK_WEBHOOK_SECRET = google_secret_manager_secret.usage_hooks["clerk-webhook-secret"].secret_id
  }
  description = "Secret ids for the usage service /hooks/* env vars (versions seeded out-of-band)."
}

output "pinata_gateway_token_secret_id" {
  value       = google_secret_manager_secret.pinata_gateway_token.secret_id
  description = "Secret Manager secret id for PINATA_GATEWAY_TOKEN (assets logo-sync; version seeded out-of-band)."
}

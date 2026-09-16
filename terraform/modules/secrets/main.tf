resource "google_project_service" "secretmanager" {
  project            = var.project_id
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "random_password" "cloudrun_auth_token" {
  length  = 48
  special = false

  keepers = {
    env = var.env
  }
}

resource "google_secret_manager_secret" "cloudrun_auth_token" {
  project   = var.project_id
  secret_id = "tokens-cloudrun-auth-token-${var.env}"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "cloudrun_auth_token" {
  secret      = google_secret_manager_secret.cloudrun_auth_token.id
  secret_data = random_password.cloudrun_auth_token.result
}

resource "google_secret_manager_secret_iam_member" "cloudrun_auth_token_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.cloudrun_auth_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.runtime_sa_email}"

  depends_on = [google_project_service.secretmanager]
}

# API key reveal-encryption secret. NO version is managed here: the value MUST
# be byte-identical to the TOKENS_API_KEY_ENCRYPTION_SECRET Convex used (keys
# encrypted before the migration must still decrypt). Seed it out-of-band:
#   doppler secrets get TOKENS_API_KEY_ENCRYPTION_SECRET --plain --project tokens --config prd \
#     | gcloud secrets versions add tokens-api-key-encryption-secret-<env> --data-file=-
resource "google_secret_manager_secret" "api_key_encryption_secret" {
  project   = var.project_id
  secret_id = "tokens-api-key-encryption-secret-${var.env}"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_iam_member" "api_key_encryption_secret_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.api_key_encryption_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.runtime_sa_email}"

  depends_on = [google_project_service.secretmanager]
}

# Observability/webhook ingest secrets for the usage service's /hooks/* routes
# (Vercel log drain + Clerk webhook → Loki, Webacy depeg webhook → jobs worker).
# Versions are seeded out-of-band from Doppler via scripts/seed-usage-hook-secrets.sh:
#   LOKI_PUSH_URL, LOKI_PUSH_AUTH, VERCEL_DRAIN_SECRET, CLERK_WEBHOOK_SECRET,
#   WEBACY_WEBHOOK_SECRET
resource "google_secret_manager_secret" "usage_hooks" {
  for_each = toset([
    "loki-push-url",
    "loki-push-auth",
    "vercel-drain-secret",
    "clerk-webhook-secret",
    "webacy-webhook-secret",
  ])

  project   = var.project_id
  secret_id = "tokens-${each.value}-${var.env}"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_iam_member" "usage_hooks_accessor" {
  for_each = google_secret_manager_secret.usage_hooks

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.runtime_sa_email}"

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "database_url" {
  project   = var.project_id
  secret_id = "tokens-database-url-${var.env}"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgres://${var.sql_app_user}:${var.sql_app_password}@${var.sql_private_ip}:5432/${var.sql_database_name}?sslmode=require"
}

resource "google_secret_manager_secret_iam_member" "database_url_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.runtime_sa_email}"

  depends_on = [google_project_service.secretmanager]
}

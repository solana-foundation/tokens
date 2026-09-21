resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-${var.env}"
  display_name              = "GitHub Actions (${var.env})"
  description               = "OIDC pool for GitHub Actions running against ${var.env}."
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.actor"      = "assertion.actor"
  }

  attribute_condition = "assertion.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "tf_deployer" {
  account_id   = "tf-deployer-${var.env}"
  display_name = "Terraform deployer (${var.env})"
  description  = "GH Actions assumes via WIF on main only — runs terraform apply."
}

resource "google_project_iam_member" "tf_deployer_owner" {
  project = var.project_id
  role    = "roles/owner"
  member  = "serviceAccount:${google_service_account.tf_deployer.email}"
}

resource "google_service_account_iam_member" "tf_deployer_wif_binding" {
  service_account_id = google_service_account.tf_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.ref/refs/heads/main"
}

resource "google_service_account" "tf_planner" {
  account_id   = "tf-planner-${var.env}"
  display_name = "Terraform planner (${var.env})"
  description  = "GH Actions assumes via WIF on any branch — read-only, runs terraform plan on PRs."
}

resource "google_project_iam_member" "tf_planner_roles" {
  for_each = toset([
    "roles/viewer",
    "roles/iam.securityReviewer",
    "roles/redis.dbConnectionUser",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.tf_planner.email}"
}

resource "google_project_iam_custom_role" "tf_planner_redis_auth" {
  project     = var.project_id
  role_id     = "tokensTfPlannerRedisAuth"
  title       = "Tokens TF Planner Redis Auth Reader"
  description = "Lets terraform plan refresh google_redis_instance state when auth_enabled=true"
  permissions = ["redis.instances.getAuthString"]
  stage       = "GA"
}

resource "google_project_iam_member" "tf_planner_redis_auth" {
  project = var.project_id
  role    = google_project_iam_custom_role.tf_planner_redis_auth.name
  member  = "serviceAccount:${google_service_account.tf_planner.email}"
}

resource "google_storage_bucket_iam_member" "tf_planner_state" {
  bucket = "tokens-tf-state-${var.env}"
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.tf_planner.email}"
}

resource "google_storage_bucket_iam_member" "tf_deployer_state" {
  bucket = "tokens-tf-state-${var.env}"
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.tf_deployer.email}"
}

resource "google_service_account_iam_member" "tf_planner_wif_binding" {
  service_account_id = google_service_account.tf_planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

resource "google_service_account" "cloud_run_runtime" {
  account_id   = "cr-runtime-${var.env}"
  display_name = "Cloud Run runtime (${var.env})"
  description  = "Identity for tokens Cloud Run services."
}

resource "google_project_iam_member" "cloud_run_runtime_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/redis.viewer",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/cloudtrace.agent",
    "roles/cloudtasks.enqueuer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}

resource "google_service_account" "scheduler" {
  account_id   = "scheduler-${var.env}"
  display_name = "Cloud Scheduler invoker (${var.env})"
}

resource "google_service_account" "tasks" {
  account_id   = "tasks-${var.env}"
  display_name = "Cloud Tasks invoker (${var.env})"
}

resource "google_service_account" "cloudrun_deployer" {
  account_id   = "cr-deployer-${var.env}"
  display_name = "Cloud Run deployer (${var.env})"
  description  = "GH Actions assumes via WIF on main only — deploys Cloud Run revisions."
}

resource "google_project_iam_member" "cloudrun_deployer_roles" {
  for_each = toset([
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountUser",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cloudrun_deployer.email}"
}

resource "google_service_account_iam_member" "cloudrun_deployer_wif_binding" {
  service_account_id = google_service_account.cloudrun_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.ref/refs/heads/main"
}

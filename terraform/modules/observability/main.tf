resource "google_project_service" "pubsub" {
  project            = var.project_id
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

resource "google_pubsub_topic" "logs" {
  name       = "tokens-logs-${var.env}"
  depends_on = [google_project_service.pubsub]
}

data "google_project" "this" {
  project_id = var.project_id
}

# Identity Pub/Sub uses to sign OIDC tokens on push deliveries. The usage
# service verifies issuer + this SA's email, so nothing secret lives in the
# push endpoint URL or terraform state.
resource "google_service_account" "logs_pusher" {
  project      = var.project_id
  account_id   = "logs-pusher-${var.env}"
  display_name = "Pub/Sub -> usage /hooks/gcp-logs push identity"
}

resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.logs_pusher.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "logs_to_grafana" {
  name  = "tokens-logs-to-grafana-${var.env}"
  topic = google_pubsub_topic.logs.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }

  # Push into the admin service (IAM-locked, no user traffic), which forwards
  # to Grafana Loki — isolated from the usage service so log ingestion can
  # never contend with API-key auth. Pub/Sub signs a Google OIDC token as
  # logs_pusher; Cloud Run IAM admits it (run.invoker granted in the env
  # module) and the handler re-pins issuer + SA email (GCP_LOGS_INVOKER_SA
  # in the deploy-time env, Doppler {env}_cloudrun).
  push_config {
    push_endpoint = "${var.push_target_service_url}/hooks/gcp-logs"

    oidc_token {
      service_account_email = google_service_account.logs_pusher.email
      audience              = var.push_target_service_url
    }
  }

  # One Cloud Logging entry is one push. When a burst saturates the admin
  # service (429 "no available instance"), Pub/Sub backs off per message; a
  # 600s ceiling parked rejected entries for ten minutes and stretched a
  # 500k-entry backlog into a 40+ minute Loki lag (2026-10-27, see
  # docs/operations/log-pipeline.md). Keep retries short so the backlog
  # drains as fast as the endpoint allows.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "60s"
  }
}

resource "google_logging_project_sink" "tokens" {
  name        = "tokens-cloudrun-${var.env}"
  destination = "pubsub.googleapis.com/${google_pubsub_topic.logs.id}"

  filter = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name=~"^tokens-.*-${var.env}${var.name_suffix}$"
    (severity>=WARNING OR logName:"stdout" OR logName:"stderr")
    NOT textPayload=~"^loki: "
    NOT httpRequest.requestUrl=~"/hooks/gcp-logs"
  EOT

  unique_writer_identity = true
}

resource "google_pubsub_topic_iam_member" "sink_writer" {
  topic  = google_pubsub_topic.logs.name
  role   = "roles/pubsub.publisher"
  member = google_logging_project_sink.tokens.writer_identity
}

locals {
  # PARKED (2026-08-23). The depth sampler wrote price-impact curves to
  # variant_depth_curves_latest to back a graded, cached evaluation surface.
  # /v2/execution/evaluate now serves live Jupiter/Titan quote comparison
  # instead, so nothing reads those curves — leaving the schedule in place
  # spent Titan quota every 30 minutes for data no caller could see.
  #
  # Deliberately kept rather than deleted: the handler
  # (/jobs/refresh-depth-curves), the table, the read path, and the grading
  # helpers in @tokens/asset-registry all still work. Re-enable by moving the
  # job back into depth_cron_jobs and setting DEPTH_REFRESH_ENABLED=true on the
  # assets service (the handler is a no-op without it).
  depth_cron_jobs = []

  depth_cron_jobs_parked = [
    {
      name      = "refresh-depth-curves"
      schedule  = "*/30 * * * *"
      http_path = "/jobs/refresh-depth-curves"
      body_json = jsonencode({
        maxMints              = 60
        concurrency           = 1
        delayMs               = 500
        requireRefreshEnabled = true
        budgetMs              = 500000
      })
      attempt_deadline = "540s"
      # High-frequency job: the next scheduled tick is the retry.
      retry_count = 0
    },
  ]
}

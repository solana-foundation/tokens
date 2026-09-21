# DB migrations (Cloud SQL, stg + prd)

`db/migrations/*.sql` are **not** applied by Tokens Deploy. Both Cloud SQL instances are
private-IP only, so nothing on a laptop or in the Vercel/Cloud Run deploy jobs can reach them
directly. Apply them with the **DB migrate** GitHub workflow.

## Apply a release's migrations

1. Actions → **DB migrate** → *Run workflow* on `main` (the deployer's WIF binding is main-only).
2. `env=prd`, `mode=status`. The run summary lists every file under `db/migrations/` as
   `applied` or `PENDING`, plus anything applied in the DB that this checkout doesn't have.
3. Same again with `mode=apply`. Only the pending files are shipped to the job; `db/apply.sh`
   runs them one transaction each under the advisory lock and re-checks `schema_migrations`
   before every file, so a concurrent run is safe. The summary shows `apply.sh`'s output.
4. Tokens Deploy posts a ⚠️ *Pending DB migrations* Slack message and step summary whenever a
   release ships new SQL — treat that as the cue to run steps 2–3. Order relative to the Cloud
   Run promotion is a per-change call: handlers that only *read* new tables are usually
   fail-open (e.g. `launchpadListByQuoteMints` → empty list), handlers that *write* on a cron
   will log failures until the tables exist.

## How it works

`scripts/db-migrate/run-job.sh` creates a one-off Cloud Run **job** (`postgres:16`) in the
env VPC (`tokens-vpc-<env>` / `tokens-subnet-<env>-us`, egress all-traffic) running as the
runtime SA `cr-runtime-<env>` with `DATABASE_URL` mounted from Secret Manager
(`tokens-database-url-<env>-us`), executes it with `--wait`, prints its logs, and deletes it.
The in-job scripts are `scripts/db-migrate/status.sh` (read-only) and
`scripts/db-migrate/apply.sh` (unpacks `db/apply.sh` + pending files from an env var and runs
it). The deployer SA needs `run.admin`, `iam.serviceAccountUser` and `logging.viewer`
(terraform `modules/iam`).

Gotchas already handled: the secret value ends in a newline psql rejects (`tr -d '\r\n'`);
Cloud Run env vars have a hard size cap, which is why only pending files are shipped;
`--args`/`--set-env-vars` use custom delimiters so quotes and `=` in the payload survive.

## Manual fallback

Same one-off job by hand with `gcloud run jobs create … --image postgres:16
--set-secrets DATABASE_URL=tokens-database-url-prd-us:latest --service-account
cr-runtime-prd@… --network tokens-vpc-prd --subnet tokens-subnet-prd-us --vpc-egress
all-traffic`, base64 the SQL into an env var, `psql "$DB" -v ON_ERROR_STOP=1`, read logs via
`gcloud logging read 'resource.type="cloud_run_job" …'`, delete the job. Wrap DDL in the same
`BEGIN; SELECT pg_advisory_xact_lock(712347); … COMMIT;` that `db/apply.sh` uses.

# Secret rotation runbooks (key-path secrets)

Procedures for the secrets in the "Key-path" table of
[`key-inventory.md`](key-inventory.md). Each runbook is written to be run
staging first, then production, and to leave the old value accepted until the
new one is confirmed everywhere, so a rotation never causes a 401 window.

Cloud Run services read secrets from Secret Manager at revision start. Because
`terraform/modules/cloud_run/main.tf` ignores changes to container `env`,
terraform declares secrets but does not push env changes to a running service.
Use `gcloud run services update` for the live wiring; when traffic is pinned,
the update creates a 0%-traffic revision that must be promoted explicitly.

Status: the `_PREVIOUS` fallbacks and the `apiKeysReencrypt` mutation referred
to below ship with the rotation-support change (PR 5 of the SDLC remediation).
Until that lands, rotating the bearer token or encryption secret requires a
short maintenance window and the steps marked "without fallback".

## `TOKENS_CLOUDRUN_AUTH_TOKEN` (shared RPC bearer)

Consumers: apps/api, apps/app, apps/admin (local fallback), cloudrun-admin,
cloudrun-assets (+ jobs worker), cloudrun-prices, cloudrun-usage,
`infra/cron/usage-digest.sh`, `scripts/_cloudrun.mjs`.

1. Generate the new value in terraform:
    ```
    cd terraform/envs/<env>
    terraform apply -replace=module.env.module.secrets.random_password.cloudrun_auth_token
    terraform output -raw cloudrun_auth_token_value
    ```
    This adds a new Secret Manager version; Cloud Run services pick it up on
    their next revision as the current token.
2. Set the old value as the fallback on every Cloud Run service so both are
   accepted during the cutover:
    ```
    for svc in admin assets assets-jobs prices usage; do
      gcloud run services update tokens-$svc-<env>-us --region us-east4 \
        --update-env-vars=TOKENS_CLOUDRUN_AUTH_TOKEN_PREVIOUS=<old value>
    done
    ```
    Promote the new revisions. (Without fallback: skip this step and accept
    401s between steps 1 and 3.)
3. Update the callers with the new value: Doppler `tokens/<env>`
   (`TOKENS_CLOUDRUN_AUTH_TOKEN`), Vercel env on the api and app projects
   (Production for prd, Preview for stg), and wherever
   `infra/cron/usage-digest.sh` runs. Redeploy apps/api and apps/app (the
   client caches the token at boot).
4. Verify: dashboard loads and can list keys; `scripts/_cloudrun.mjs ping`
   succeeds; no `unauthorized` 401s in the usage service logs.
5. Remove the fallback: `--remove-env-vars=TOKENS_CLOUDRUN_AUTH_TOKEN_PREVIOUS`
   on each service, promote, and disable the old Secret Manager version.
6. Record the rotation in Doppler's activity log (do not add dates to this
   repo).

## `TOKENS_IDENTITY_SIGNING_SECRET` (signed identity token)

Consumers: apps/app (signer), cloudrun-usage (verifier).

1. `terraform apply -replace=module.env.module.secrets.random_password.identity_signing_secret`
   and read `terraform output -raw identity_signing_secret_value`.
2. On the usage service set `TOKENS_IDENTITY_SIGNING_SECRET_PREVIOUS=<old value>`
   so tokens signed with either value verify; promote the revision.
3. Set the new value in Vercel on the app project and redeploy apps/app.
4. Verify: dashboard key list, create key, reveal key all succeed; no
   `identity_invalid` warnings in the usage logs.
5. Remove `TOKENS_IDENTITY_SIGNING_SECRET_PREVIOUS`, promote, disable the old
   Secret Manager version.

Tokens are valid for 60 s, so there is no long-lived material to invalidate.

## `TOKENS_API_KEY_ENCRYPTION_SECRET` (API-key reveal encryption)

Consumer: cloudrun-usage only. Rotating this secret does not invalidate any
API key; it only affects whether the dashboard can reveal stored keys. Every
`api_keys` row carries `encrypted_raw_key_version` so rows can be rewritten
under a new secret.

1. Generate a new 32-byte random value locally (`openssl rand -hex 32`) and add
   it as a new version of `tokens-api-key-encryption-secret-<env>` in Secret
   Manager. Do not change Doppler yet.
2. On the usage service set `TOKENS_API_KEY_ENCRYPTION_SECRET_PREVIOUS=<old value>`
   and promote. Decryption now tries the current value then the previous one,
   so reveal keeps working for every row.
3. Run the re-encrypt job (bearer-gated, explicit confirmation):
    ```
    node scripts/_cloudrun.mjs usage mutation apiKeysReencrypt '{"confirm":"reencrypt"}'
    ```
    It rewrites every row that decrypts only with the previous value and
    returns `{processed, reencrypted, failed}`. Re-run until `failed` is 0.
    A row that fails both secrets is a legacy hash-only key; it still
    authenticates, and the owner regenerates it from the dashboard to make it
    revealable again.
4. Verify: reveal a key from a project created before the rotation.
5. Remove `TOKENS_API_KEY_ENCRYPTION_SECRET_PREVIOUS`, promote, disable the old
   Secret Manager version, and update Doppler `tokens/<env>` so the next
   out-of-band seed uses the new value.

Without fallback: rows encrypted under the old value become unrevealable
until regenerated. Only do that in an emergency (suspected secret exposure),
and tell affected projects to reset their key.

## `TOKENS_PLAYGROUND_PROXY_SECRET` (dashboard playground proxy)

Consumers: apps/app (signer), apps/api (verifier). Tokens live 60 s.

1. Generate a new value; set it on the api project in Vercel first and
   redeploy apps/api. There is no fallback, so the playground returns 401 for
   the next step's duration.
2. Set it on the app project and redeploy apps/app.
3. Verify a playground request from the dashboard succeeds.

## `DATABASE_URL`

Rotate the Cloud SQL application user's password through terraform
(`module.cloud_sql`), which writes a new Secret Manager version. Restart each
Cloud Run service by deploying a new revision; postgres-js reconnects with the
new credentials. Expect connection errors on in-flight requests for the few
seconds between the password change and the revision switch; do this in a low
traffic window.

## On suspicion of compromise

Rotate the affected secret immediately with the "without fallback" variant,
then follow the full runbook for the dependent secrets:

- bearer leaked → rotate bearer; identity signing secret unaffected.
- identity signing secret leaked → rotate it; bearer unaffected.
- both leaked, or usage service compromised → rotate bearer, signing secret,
  encryption secret (with re-encrypt), and ask every project with a key
  revealed in the window to reset it.
- `DATABASE_URL` leaked → rotate it and the encryption secret.

Open a security advisory draft in GitHub for the incident record per
`SECURITY.md`.

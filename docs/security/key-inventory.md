# Key inventory (shared service secrets)

Living inventory required by SDLC §6.5. One row per shared secret: what it is
for, who consumes it, where the value lives, who owns it, and how often it
rotates. Values and last-rotation dates are never recorded here; Secret
Manager and Doppler version history are the source of truth for those.
Reviewed every six months; next review is due 2027-04 (owner: product team).

Storage legend: **SM** = GCP Secret Manager secret `tokens-<name>-<env>`
(declared in `terraform/modules/secrets/main.tf`, one per env); **Doppler** =
project `tokens`, config `<env>`; **Vercel** = project environment variables
on the named Vercel project; **GH** = GitHub Actions repository secret.

Rotation procedures are in [`secret-rotation.md`](secret-rotation.md).

## Key-path secrets (Critical tier)

| Secret                             | Purpose                                                               | Consumers                                                                                                                           | Storage                                                                   | Owner           | Rotation                                          |
| ---------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------- | ------------------------------------------------- |
| `TOKENS_CLOUDRUN_AUTH_TOKEN`       | shared bearer admitting RPC calls to the `cloudrun-*` services        | apps/api, apps/app, apps/admin (local fallback), all four Cloud Run services, `infra/cron/usage-digest.sh`, `scripts/_cloudrun.mjs` | SM `cloudrun-auth-token` (terraform-generated); Doppler; Vercel api + app | @stevesarmiento | quarterly, or on suspicion                        |
| `TOKENS_IDENTITY_SIGNING_SECRET`   | HMAC key for the signed `x-tokens-identity` token (dashboard → usage) | apps/app (signer), cloudrun-usage (verifier)                                                                                        | SM `identity-signing-secret` (terraform-generated); Vercel app            | @stevesarmiento | quarterly, or on suspicion                        |
| `TOKENS_API_KEY_ENCRYPTION_SECRET` | AES-GCM key (via SHA-256) for the revealable copy of each API key     | cloudrun-usage only                                                                                                                 | SM `api-key-encryption-secret` (seeded from Doppler)                      | @stevesarmiento | annually or on suspicion; requires re-encrypt job |
| `TOKENS_PLAYGROUND_PROXY_SECRET`   | HMAC key for dashboard playground → apps/api proxy auth               | apps/app (signer), apps/api (verifier)                                                                                              | Vercel app + api                                                          | @stevesarmiento | quarterly                                         |
| `DATABASE_URL`                     | Cloud SQL connection string for the auth and asset tables             | all four Cloud Run services                                                                                                         | SM `database-url`                                                         | @stevesarmiento | on personnel change or suspicion                  |

## Usage-service ingest secrets

| Secret                             | Purpose                                                         | Consumers      | Storage                                       | Owner           | Rotation              |
| ---------------------------------- | --------------------------------------------------------------- | -------------- | --------------------------------------------- | --------------- | --------------------- |
| `CLERK_WEBHOOK_SECRET`             | Svix signature for Clerk user webhooks (`/hooks/clerk-webhook`) | cloudrun-usage | SM `clerk-webhook-secret`; Clerk dashboard    | @stevesarmiento | annually              |
| `VERCEL_DRAIN_SECRET`              | signature for the Vercel log drain (`/hooks/log-drain`)         | cloudrun-usage | SM `vercel-drain-secret`; Vercel drain config | @stevesarmiento | annually              |
| `VERCEL_VERIFY_TOKEN`              | drain registration challenge                                    | cloudrun-usage | Cloud Run env (out of band)                   | @stevesarmiento | with the drain secret |
| `LOKI_PUSH_URL` / `LOKI_PUSH_AUTH` | Grafana Cloud Loki push credentials                             | cloudrun-usage | SM `loki-push-url`, `loki-push-auth`          | @stevesarmiento | annually              |

## Asset pipeline secrets

| Secret                                                                            | Purpose                              | Consumers                                  | Storage                            | Owner           | Rotation                       |
| --------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------ | ---------------------------------- | --------------- | ------------------------------ |
| `PINATA_GATEWAY_TOKEN`                                                            | dedicated IPFS gateway for logo sync | cloudrun-assets worker                     | SM `pinata-gateway-token`; Doppler | @stevesarmiento | annually                       |
| Provider API keys (Birdeye, CoinGecko, Webacy, Helius, Allium, Jupiter, Titan, X) | upstream market/risk/social data     | apps/api, cloudrun-assets, cloudrun-prices | Doppler; Vercel api; Cloud Run env | @stevesarmiento | annually or on provider notice |

## CI/CD and deploy credentials

| Secret                                                                                                          | Purpose                                                   | Consumers                                                         | Storage           | Owner           | Rotation                                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- | ----------------- | --------------- | ---------------------------------------------- |
| `DOPPLER_TOKEN`                                                                                                 | service token letting workflows read Doppler `tokens/prd` | `deploy.yml`, `terraform.yml`, `rollback.yml`, `grafana-push.yml` | GH                | @stevesarmiento | quarterly                                      |
| `VERCEL_TOKEN`                                                                                                  | deploys apps/web, apps/app, apps/admin, apps/api          | `deploy.yml` (fetched from Doppler)                               | Doppler           | @stevesarmiento | quarterly (team token preferred over personal) |
| `VERCEL_PROJECT_ID*`, `TOKENS_*_STAGE_URL`, `TOKENS_*_PROD_URL`, `CLERK_JWT_ISSUER_DOMAIN`                      | deploy metadata (not secret-bearing, treated as Internal) | `deploy.yml`                                                      | Doppler           | @stevesarmiento | n/a                                            |
| `TOKENS_API_KEY`, `TOKENS_API_KEY_STAGING`                                                                      | platform keys used by stage/prod smoke tests              | `deploy.yml`                                                      | Doppler           | @stevesarmiento | regenerate from the dashboard quarterly        |
| `SLACK_DEPLOY_WEBHOOK_URL`                                                                                      | deploy notifications                                      | `deploy.yml`                                                      | Doppler           | @stevesarmiento | annually                                       |
| GCP planner/deployer service accounts (Workload Identity Federation, `GCP_WIF_PROVIDER` + `GCP_*_SA` repo vars) | terraform plan/apply, Cloud Run deploy                    | `terraform.yml`, `cloudrun-deploy.yml`, `deploy.yml`              | GCP IAM (keyless) | @stevesarmiento | keyless; review bindings semi-annually         |
| `GRAFANA_API_TOKEN`                                                                                             | pushes dashboards and alert rules                         | `grafana-push.yml` (fetched from Doppler)                         | Doppler           | @stevesarmiento | annually                                       |

## Individual credentials (not tracked here)

Personal GitHub tokens, gcloud logins, and local `.env.local` values belong to
the individual (1Password or local keychain) per SDLC §6.3. The semi-annual
access review confirms departed members no longer hold access to GCP, Vercel,
Doppler, Clerk, Grafana, or the GitHub org.

## Maintenance

- A secret found in use but missing from this table is rotated immediately,
  assigned an owner, and added.
- Adding a secret in terraform or a workflow without a row here should be
  caught in code review (`/docs/security/` and `/terraform/` share code owners).

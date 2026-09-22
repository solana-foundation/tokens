# @tokens/cloudrun-assets

Cloud Run service that handles the `assets` slice of the Convex → GCP migration. Implements the wire format that `apps/api/src/lib/cloudrun/CloudRunClient` calls into.

## Wire format

`POST /query/{name}` and `POST /mutation/{name}`, JSON body, `Authorization: Bearer <TOKENS_CLOUDRUN_AUTH_TOKEN>`. `GET /health` is process-only; `GET /startup` verifies Postgres before Cloud Run sends traffic.

The query names match the corresponding Convex export names (e.g. `getByAssetId`) so callers in `apps/api` can swap `fetchQuery(api.assets.getByAssetId, args)` for `client.query('assets', 'getByAssetId', args)`.

## Implemented

| Name           | Kind  | Status                                                                                                             |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `getByAssetId` | query | template, parity with `convex/assets.ts:getByAssetId` minus the `imageStorageId` lookup (dropped during migration) |

The remaining `assets.*`, `assetVariants.*`, `assetMarkets.*` functionality will
be implemented incrementally by the maintainers.

## Env

| Var                           | Required | Notes                                                                                                                                                                                         |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | yes      | Cloud SQL Postgres connection string                                                                                                                                                          |
| `TOKENS_CLOUDRUN_AUTH_TOKEN`  | yes      | Shared bearer token with the `CloudRunClient` caller                                                                                                                                          |
| `PORT`                        | no       | Defaults to 8080 (Cloud Run's default)                                                                                                                                                        |
| `SERVICE_ROLE`                | no       | `api` (RPC routes only) or `worker` (Scheduler `/jobs/*` only); defaults to `api`                                                                                                             |
| `PG_POOL_MAX`                 | no       | postgres-js connection pool size, default 16 for API and 8 for worker                                                                                                                         |
| `PG_IDLE_TIMEOUT`             | no       | seconds, default 240                                                                                                                                                                          |
| `PG_CONNECT_TIMEOUT`          | no       | connection-establishment timeout in seconds, default 3                                                                                                                                        |
| `TOKENS_ADMIN_CLERK_USER_IDS` | no       | Comma-separated Clerk user id allowlist for the `/mutation/admin*` endpoints                                                                                                                  |
| `TOKENS_ADMIN_EMAILS`         | no       | Comma-separated verified-email allowlist (case-insensitive) for the `/mutation/admin*` endpoints, unioned with the user-id list; when both lists are empty every admin call is rejected (403) |
| `TOKENS_RPC_INVOKER_SA`       | no       | Service-account email whose Google OIDC ID tokens are accepted on `/query`/`/mutation` (the Vercel admin app's WIF invoker); unset ⇒ shared bearer only                                       |
| `TOKENS_RPC_OIDC_AUDIENCE`    | no       | Expected `aud` of those ID tokens (this service's run.app URL); recommended whenever `TOKENS_RPC_INVOKER_SA` is set                                                                           |
| `GCS_LOGO_BUCKET`             | no       | Public asset-logo bucket the `logo-sync` job uploads 256px WebP copies to (`solana/<mint>.webp`); unset ⇒ `/jobs/logo-sync` disabled. Written with the runtime SA's default credentials      |
| `GCS_LOGO_PUBLIC_BASE_URL`    | no       | Base URL served as `logoURI` for those copies; defaults to `https://storage.googleapis.com/<bucket>`                                                                                          |
| `PINATA_GATEWAY_HOST`         | no       | Pinata dedicated gateway (e.g. `tokens.mypinata.cloud`) used to fetch IPFS-hosted artwork; unset ⇒ IPFS logos rely on the dexscreener / Jupiter fallbacks                                     |
| `PINATA_GATEWAY_TOKEN`        | no       | Gateway access token sent as `x-pinata-gateway-token` (Secret Manager `tokens-pinata-gateway-token-<env>`)                                                                                     |
| `JUPITER_TOKEN_API_URL`       | no       | Jupiter token-API lookup template for the last-resort logo source (`{mint}` placeholder); defaults to `https://lite-api.jup.ag/tokens/v2/search?query={mint}`                                 |

## Local dev

```bash
DATABASE_URL=postgres://... TOKENS_CLOUDRUN_AUTH_TOKEN=dev \
    bun run apps/cloudrun-assets/src/index.ts
```

## Tests

```bash
bun test apps/cloudrun-assets/src
```

Handlers take a stub `AssetsRepo` so tests don't need a live Postgres.

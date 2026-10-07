# @tokens/cloudrun-usage

Cloud Run service that handles the `usage` slice of the Convex → GCP migration: platform API-key auth, request logging, Redis usage-aggregate ingest, and the dashboard-facing user/project/usage queries.

Unlike the other `cloudrun-*` services, `usage` has `ingress = INGRESS_TRAFFIC_ALL` (needed for externally-sourced webhook/ingest traffic). The canonical event rollup + prune crons live on **cloudrun-assets** (`/jobs/rollup-active-api-usage`, `/jobs/prune-api-request-events`) — this service intentionally hosts no crons to avoid double-counting.

## Wire format

- `GET /health` — Cloud Run startup/liveness probe.
- `POST /query/{name}` — bearer-auth, called by `apps/api`'s `CloudRunClient` (`Authorization: Bearer <TOKENS_CLOUDRUN_AUTH_TOKEN>`). Same shape as `cloudrun-assets`.
- `POST /mutation/{name}` — bearer-auth, same gate as `/query/*`.
- Caller identity: an optional `x-tokens-identity` header carries the Clerk-session-verified caller for user-scoped handlers, which enforce membership/role checks in SQL against it. The header is a **signed token** (`@tokens/cloudrun-shutdown/identity`): `base64url(payload).base64url(HMAC-SHA256)` where the payload is `{v:1, clerkUserId, projectId?, email?, kind, fn, bodySha256, iat, exp}`. The token is bound to the RPC (`kind` + `fn`), to the exact request body, and to a 60 s window; anything that fails verification is a `401 {error:'identity_invalid', reason}` before the handler runs, even for RPCs that ignore identity. During the rollout `TOKENS_IDENTITY_ACCEPT_UNSIGNED=true` also admits the legacy unsigned base64 JSON form.

## Implemented

| Name | Kind | Status |
| --- | --- | --- |
| `ping` | query | trivial echo, exercises the bearer-auth path end-to-end for smoke tests |
| `apiKeysAuthenticate` | query | parity with `convex/apiKeys.ts:authenticate`. Resolves an active key by SHA-256 hash (personal-project fallback for legacy keys, default legacy scopes) and returns the platform auth context `apps/api` uses on every authenticated `/v1` request. |
| `logApiRequest` | mutation | parity with `convex/auth.ts:logApiRequest`. Best-effort insert into `api_request_events` (same ownership checks + latency clamping) and a deduped `api_keys.last_used_at` bump. Feeds the cloudrun-assets rollup job. |
| `ingestUsageAggregates` | mutation | parity with `convex/apiUsageRollups.ts:ingestUsageAggregates`. Ingests usage buckets (daily + per-endpoint with latency histograms) into the rollup tables additively, in one transaction. Its original caller (the Upstash drain timer) is retired. Buckets are deltas; not replay-safe. |
| `syncUsageAggregates` | mutation | Target of the API's self-drain (`apps/api/src/effect/usage-drain.ts`). Same bucket shape, but buckets carry running totals and each column is raised to the larger of stored and incoming, so a replayed batch cannot double-count. |

The dashboard queries and mutations (`users.*`, `projects.*`,
`auth.getProjectUsage*`, key reset/reveal) will be implemented incrementally by
the maintainers.

## Env

| Var | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Cloud SQL Postgres connection string |
| `TOKENS_CLOUDRUN_AUTH_TOKEN` | yes | Shared bearer token with the `CloudRunClient` caller for `/query/*` + `/mutation/*` |
| `TOKENS_IDENTITY_SIGNING_SECRET` | yes\* | HMAC key verifying the signed `x-tokens-identity` token (apps/app signs with the same value). \*May be unset only while `TOKENS_IDENTITY_ACCEPT_UNSIGNED=true`; the process refuses to start with neither. |
| `TOKENS_IDENTITY_ACCEPT_UNSIGNED` | no | `true` keeps accepting the legacy unsigned identity header during the signed-token rollout. Remove once every caller signs. |
| `TOKENS_API_KEY_ENCRYPTION_SECRET` | no | Required for key reset/reveal (AES-GCM reveal copy); those handlers error without it |
| `PORT` | no | Defaults to 8080 |
| `PG_POOL_MAX` | no | postgres-js connection pool size, default 10 |
| `PG_IDLE_TIMEOUT` | no | seconds, default 30 |

## Local dev

```bash
DATABASE_URL=postgres://... TOKENS_CLOUDRUN_AUTH_TOKEN=dev TOKENS_IDENTITY_SIGNING_SECRET=dev-identity-signing-secret \
    bun run apps/cloudrun-usage/src/index.ts
```

## Tests

```bash
bun test apps/cloudrun-usage/src
```

Handlers take stub repo interfaces (`PlatformAuthRepo`, `UsageIngestRepo`, …) so tests don't need a live Postgres.

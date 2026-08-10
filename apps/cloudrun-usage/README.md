# @tokens/cloudrun-usage

Cloud Run service that handles the `usage` slice of the Convex → GCP migration: platform API-key auth, request logging, Redis usage-aggregate ingest, and the dashboard-facing user/project/usage queries.

Unlike the other `cloudrun-*` services, `usage` has `ingress = INGRESS_TRAFFIC_ALL` (needed for externally-sourced webhook/ingest traffic). The canonical event rollup + prune + partition-maintenance crons live on **cloudrun-assets** (`/jobs/rollup-active-api-usage`, `/jobs/prune-api-request-events`, `/jobs/create-api-usage-partitions`) — this service intentionally hosts no crons to avoid double-counting.

## Wire format

- `GET /health` — Cloud Run startup/liveness probe.
- `POST /query/{name}` — bearer-auth, called by `apps/api`'s `CloudRunClient` (`Authorization: Bearer <TOKENS_CLOUDRUN_AUTH_TOKEN>`). Same shape as `cloudrun-assets`.
- `POST /mutation/{name}` — bearer-auth, same gate as `/query/*`.
- Caller identity: an optional `x-tokens-identity` header (base64 JSON `{clerkUserId, projectId?, email?}`) carries the Clerk-session-verified caller for user-scoped handlers, which enforce membership/role checks in SQL against it.

## Implemented

| Name | Kind | Status |
| --- | --- | --- |
| `ping` | query | trivial echo, exercises the bearer-auth path end-to-end for smoke tests |
| `apiKeysAuthenticate` | query | parity with `convex/apiKeys.ts:authenticate`. Resolves an active key by SHA-256 hash (personal-project fallback for legacy keys, default legacy scopes) and returns the platform auth context `apps/api` uses on every authenticated `/v1` request. |
| `logApiRequest` | mutation | parity with `convex/auth.ts:logApiRequest`. Best-effort insert into `api_request_events` (same ownership checks + latency clamping) and a deduped `api_keys.last_used_at` bump. Feeds the cloudrun-assets rollup job. |
| `ingestUsageAggregates` | mutation | parity with `convex/apiUsageRollups.ts:ingestUsageAggregates`. Ingests usage buckets (daily + per-endpoint with latency histograms) into the rollup tables additively, in one transaction. Its original caller (the Upstash drain timer) is retired. |

The dashboard queries/mutations (`users.*`, `projects.*`, `auth.getProjectUsage*`, key reset/reveal) land in follow-up PRs.

## Env

| Var | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Cloud SQL Postgres connection string |
| `TOKENS_CLOUDRUN_AUTH_TOKEN` | yes | Shared bearer token with the `CloudRunClient` caller for `/query/*` + `/mutation/*` |
| `PORT` | no | Defaults to 8080 |
| `PG_POOL_MAX` | no | postgres-js connection pool size, default 10 |
| `PG_IDLE_TIMEOUT` | no | seconds, default 30 |

## Local dev

```bash
DATABASE_URL=postgres://... TOKENS_CLOUDRUN_AUTH_TOKEN=dev \
    bun run apps/cloudrun-usage/src/index.ts
```

## Tests

```bash
bun test apps/cloudrun-usage/src
```

Handlers take stub repo interfaces (`PlatformAuthRepo`, `UsageIngestRepo`, …) so tests don't need a live Postgres.

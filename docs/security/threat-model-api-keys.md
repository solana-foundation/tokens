# Threat model: API-key provisioning and platform auth

Scope: the path that mints, stores, reveals, revokes, and verifies platform
API keys. Written 2026-10-07 against the Solana Foundation SDLC §3.1 (design
and threat modeling) and reviewed against the code at that date. This is the
standing threat model for the subsystem; update it whenever a trust boundary
below changes (new caller, new secret, new service, new ingress mode).

Classification: this document is public (the code it describes is open
source). It names secrets and services but carries no values, hostnames,
rotation dates, or alert thresholds. See `key-inventory.md` for ownership and
`secret-rotation.md` for procedures.

## What is being built and what it touches

A signed-in dashboard user creates a project and asks for an API key. The usage
service mints a `tok_<64 hex>` key from 32 random bytes, stores its SHA-256
hash for lookup and an AES-GCM-256 copy for later reveal, and revokes the
project's previous key. The public API verifies keys on every `/v1` request by
hashing the `x-api-key` header and resolving the hash through a short-lived
Redis cache and then the usage service.

Data touched:

| Data                                               | Classification | Where                                                          |
| -------------------------------------------------- | -------------- | -------------------------------------------------------------- |
| Raw API key                                        | Restricted     | returned once to the browser; AES-GCM ciphertext in `api_keys` |
| Key hash (SHA-256)                                 | Internal       | `api_keys.key_hash`, Redis auth cache (`api-auth:v1:<hash>`)   |
| Key→project/scope/limits mapping                   | Internal       | `api_keys`, `projects`, Redis auth cache                       |
| Caller identity (Clerk user id, email, project id) | Internal       | signed identity token on dashboard→usage calls                 |
| Usage events (path, status, latency per key)       | Internal       | `api_request_events` and rollups                               |

## Data flow and trust boundaries

```
Browser (Clerk session)
   │  cookie-authenticated POST /api/dashboard/<fn>
   ▼
apps/app  (Vercel, Next.js route handler)                      ── boundary A
   │  verifies Clerk session; builds identity {clerkUserId, email?, projectId?}
   │  signs identity + {kind, fn, bodySha256, iat, exp} with TOKENS_IDENTITY_SIGNING_SECRET
   │  POST /<kind>/<fn>  Authorization: Bearer <TOKENS_CLOUDRUN_AUTH_TOKEN>
   │                     x-tokens-identity: <signed token>
   ▼
cloudrun-usage  (Cloud Run, public ingress)                    ── boundary B
   │  1. bearer check (constant-time)        → 401
   │  2. identity token verify (HMAC, TTL, fn + body binding) → 401 identity_invalid
   │  3. handler: membership/role checks in SQL against the verified clerkUserId
   │  apiKeysReset: random key → sha256 → AES-GCM(secret) → INSERT, revoke prior
   ▼
Cloud SQL  api_keys / projects / project_members                ── boundary C
   ▲
   │  apiKeysAuthenticate(keyHash)  (bearer only, no identity)
apps/api  (Vercel)                                             ── boundary D
   ▲  x-api-key → sha256 → Redis cache (TTL ≤ 60 s) → usage service → scopes/limits
   │
External API consumer
```

| Boundary                                        | Who can cross it                            | With what authority                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: browser → apps/app                           | anyone on the internet                      | a valid Clerk session cookie; unauthenticated calls get 401 before any downstream call                                                                                                    |
| B: apps/app → usage service                     | holders of the shared bearer token          | bearer token admits the RPC; the signed identity token decides _which user_ the RPC acts as. Both are required for user-scoped handlers                                                   |
| B': apps/api, cron, ops scripts → usage service | holders of the shared bearer token          | bearer only; these RPCs (`apiKeysAuthenticate`, `logApiRequest`, `limitsEnforce`, `syncUsageAggregates`, `listProjectsDigest`) take no caller identity and cannot act on behalf of a user |
| C: usage service → Cloud SQL                    | the runtime service account over private IP | full read/write on the auth tables; the service is the only writer of `api_keys`                                                                                                          |
| D: consumer → apps/api                          | anyone on the internet                      | a key hash that resolves to an unrevoked `api_keys` row with the required scopes                                                                                                          |

The usage service runs with public ingress because Cloud Scheduler and webhook
sources sit outside the VPC. Its `*.run.app` URL is reachable without GCP IAM,
so the application-layer checks at boundary B are the only gate. That is a
deliberate trade-off and the reason the identity token is signed rather than
merely encoded: a leaked bearer token alone must not be enough to impersonate
a user.

## External dependencies

| Dependency                                                                           | If it fails                                                                          | If it lies or is compromised                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clerk (session verification in apps/app)                                             | dashboard unusable; no key operations possible; API traffic unaffected               | attacker gets a valid session for a victim and can reset or reveal that victim's keys. Mitigation: Clerk MFA settings, and reveal/reset are logged with `created_by_clerk_user_id` |
| GCP Secret Manager (bearer, signing, encryption secrets)                             | new revisions fail to start; running instances keep their copy                       | holder of the secrets can call any RPC and forge identity. Mitigation: least-privilege `secretAccessor` on the runtime SA only; rotation runbook                                   |
| Doppler / Vercel env (apps/app and apps/api copies of the bearer and signing secret) | deploys fail or calls 401                                                            | same as above. Mitigation: SSO + hardware 2FA on both platforms; named owners in `key-inventory.md`                                                                                |
| Redis (auth cache)                                                                   | apps/api falls through to the usage service on every request (slower, still correct) | a poisoned cache entry grants a forged auth context for up to 60 s. Mitigation: Memorystore is private-IP, AUTH enabled, no public route                                           |
| Cloud SQL                                                                            | key mint/verify fail closed (401/5xx)                                                | full read of hashes and ciphertexts. Hashes do not yield keys; ciphertexts need `TOKENS_API_KEY_ENCRYPTION_SECRET`, which lives in a different system                              |

## STRIDE by component

| Component                | S (spoofing)                                                                                                 | T (tampering)                                                                   | R (repudiation)                                          | I (info disclosure)                                                                           | D (denial of service)                                                  | E (elevation)                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| apps/app dashboard route | Clerk session required; identity is taken from the verified session, never from the request body             | body is re-serialised and hashed into the identity token                        | `created_by_clerk_user_id` and `last_used_at` recorded   | raw key shown once; reveal is an explicit, member-gated action                                | Vercel edge limits; usage service has its own rate limits              | handler ignores client-supplied `projectId` unless membership is confirmed server-side                                |
| Identity token           | HMAC-SHA256 over the payload with a secret held only by apps/app and the usage service; constant-time verify | any change to claims, function name, kind, or body invalidates the signature    | token carries `iat`; server logs rejections with reason  | token holds only ids and email, no secrets                                                    | 60 s TTL bounds replay window; oversized TTLs rejected                 | token is bound to one `(kind, fn, body)` so it cannot be replayed against a different RPC or with different arguments |
| Usage service RPC gate   | bearer token compared in constant time; missing or wrong → 401 before any work                               | n/a                                                                             | every rejected identity logged with `{kind, fn, reason}` | error bodies carry a reason tag, never the expected value                                     | per-key limits enforced in `limitsEnforce`; Cloud Run concurrency caps | identity-scoped handlers refuse to run without a verified identity (`identity_required`)                              |
| Key generation + storage | n/a                                                                                                          | `api_keys_by_key_hash` unique index; insert and prior-revoke in one transaction | `revoked_at`, `created_at`, `created_by_clerk_user_id`   | hash at rest; reveal copy AES-GCM with random 96-bit IV; version column enables re-encryption | one active key per project; reset is idempotent on collision           | key is always bound to the project the caller is a member of                                                          |
| apps/api auth hot path   | key hash resolved server-side; 401 on unknown or revoked key                                                 | Redis entries written only by apps/api with a TTL ≤ 60 s                        | request id on every response; usage event per request    | 401 body does not distinguish unknown from revoked                                            | sliding-window + sustained limits + monthly quota per key              | scopes checked per route; legacy keys get the read-only default set                                                   |
| Secrets                  | each secret has one purpose and a named owner                                                                | terraform declares Secret Manager resources; values seeded out-of-band          | Secret Manager version history                           | values never in repo; gitleaks on every PR and full history                                   | n/a                                                                    | runtime SA holds `secretAccessor` on exactly the secrets its service needs                                            |

## Worst-case compromise

| Compromised                                    | Blast radius                                                                                                                                                               | Why it stops there                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOKENS_CLOUDRUN_AUTH_TOKEN`                   | attacker can call bearer-only RPCs: authenticate arbitrary hashes (learns project ids and limits for keys they already have), write fake usage events, read the ops digest | cannot mint, reveal, or revoke keys and cannot act as a user, because user-scoped handlers need a validly signed identity                          |
| `TOKENS_IDENTITY_SIGNING_SECRET` alone         | nothing on its own                                                                                                                                                         | the RPC gate still requires the bearer                                                                                                             |
| both bearer + signing secret                   | full impersonation of any dashboard user: mint, reveal, revoke keys on any project                                                                                         | this is the scenario the two-secret split is designed to make require two separate leaks; rotate both per `secret-rotation.md`                     |
| `TOKENS_API_KEY_ENCRYPTION_SECRET` + a DB read | every revealable raw key is recoverable                                                                                                                                    | DB read requires VPC access or the `DATABASE_URL` secret; rotate the encryption secret and re-encrypt, then force key resets for affected projects |
| a single project's raw API key                 | that project's quota and scopes                                                                                                                                            | revoke via dashboard reset; cache entry expires within 60 s                                                                                        |
| Clerk account of a project member              | that member's projects                                                                                                                                                     | reset keys from another member's account; Clerk session revocation                                                                                 |

## Controls in place

- Branch protection on `main`: signed commits, one approving review from a
  non-pusher, required status checks (`build-and-lint`, `secret-scan`,
  `dependency-audit`, `CodeQL`), and code-owner review for the paths listed
  in `.github/CODEOWNERS` (this subsystem, terraform, CI, DB migrations).
- Every PR runs gitleaks over the working tree and full history, a dependency
  audit, lint, typecheck, tests, and build. A pre-commit gitleaks hook runs
  locally when installed.
- Changes to this subsystem are Critical tier under SDLC §2: code-owner
  review plus internal security review by the most experienced engineer on the
  codebase before merge.
- Staging receives every deploy before production; rollback is a workflow.
- Alerts: `api-auth-failure-spike` (burst of 401s on the platform API) and
  the API availability/latency rules in `alert-rules/`.

## Accepted residual risks

| Risk                                                                                                            | Why accepted                                                                                                                                                                     | Revisit when                                                               |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Exact-duplicate replay of a captured identity token within its 60 s TTL against the same RPC with the same body | requires capturing a TLS-protected request in flight; queries are idempotent and the only non-idempotent effect (`apiKeysReset`) mints one extra key that the next reset revokes | a nonce store becomes cheap (Redis is already present)                     |
| Revoked key remains valid in the apps/api cache for up to 60 s                                                  | simplicity; a 60 s window on a key the owner just rotated is tolerable                                                                                                           | consumers ask for instant revocation; add a cache purge RPC                |
| Bearer-only RPCs are reachable by anyone holding the bearer token from the public `*.run.app` URL               | admin-style RPCs are not on this service; moving usage behind an internal LB would require re-plumbing Scheduler and webhooks                                                    | the usage service gains any RPC with write authority over keys or projects |
| Identity email claim selects the "effective" Clerk user for legacy account merges                               | the claim is inside the signed token, so only apps/app can set it, and apps/app takes it from the verified session                                                               | account-merge logic is retired                                             |

## Change log

- 2026-10-07: initial version; signed identity token design, CODEOWNERS and
  repo ruleset controls.

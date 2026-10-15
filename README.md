# Tokens

Tokens is the open-source monorepo for the Tokens website, API, docs, and services. This is the live repository the project is developed and deployed from — it is not a mirror or a snapshot.

Issues are welcome; external pull requests are not accepted. See the contribution policy below and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Contributions and Curation

Tokens is open source, and you are free to inspect, use, and fork the code under
the terms of the MIT license. The hosted Tokens product—including its frontend
experience and its curated token, venue, market, and metadata coverage—remains
operated and controlled by the Tokens team. Publishing the source does not make
the hosted product or its listings community-managed.

We do not accept external pull requests, including requests to add or update
tokens, venues, markets, logos, metadata, rankings, or other product content.
External pull requests are closed automatically without review.

If you have found a relevant bug, data issue, or other improvement, please
[open an issue](https://github.com/solana-foundation/tokens/issues) with enough
context for the maintainers to evaluate it. Please report security
vulnerabilities through the process in [SECURITY.md](SECURITY.md), not through a
public issue.

## Scope

- The code here powers the hosted Tokens product; the hosted surfaces remain the easiest way to *use* Tokens.
- Self-hosting a full production deployment is possible but not yet documented end to end — the app code, database schema (`db/`), and infrastructure (`terraform/`) are all here, but you will need to supply your own credentials and infrastructure.
- `apps/admin` and the operational apps are authenticated maintainer tooling, not anonymous public surfaces.

## Repo Surfaces

| Surface      | Role                                                | Deployment                                       |
| ------------ | --------------------------------------------------- | ------------------------------------------------ |
| `apps/web`         | Public product website and lightweight proxy routes | Vercel                                     |
| `apps/docs`        | Public API documentation site                       | Vercel                                     |
| `apps/api`         | Tokens platform API (`/v1/...`) and helper routes   | Vercel                                     |
| `apps/app`         | First-party dashboard for API keys and usage        | Vercel                                     |
| `apps/admin`       | Authenticated tooling for curated asset management  | Vercel (authenticated maintainer surface)  |
| `apps/cloudrun-*`  | Backend services (assets, prices, usage, admin)     | GCP Cloud Run                              |
| `packages/*`       | Shared packages and UI primitives                   | Consumed by the apps                       |
| `db/`              | SQL schema and ordered migrations                   | Postgres (Cloud SQL)                       |
| `terraform/`       | Live infrastructure-as-code for staging/production  | GCP (applied by CI)                        |
| `scripts`          | Verification, seeding, and maintenance utilities    | Local / CI tooling                         |

## Architecture

The `apps/web`, `apps/app`, and `apps/admin` Next.js frontends talk to `apps/api`
(the public `/v1/...` platform API). `apps/api` authenticates callers (Clerk for
sessions, hashed platform API keys for programmatic access) and proxies to the
Cloud Run backend services in `apps/cloudrun-*` (assets, prices, usage, admin),
which own data access to Postgres (Cloud SQL), ClickHouse, and Upstash Redis.
Schema lives in `db/`; infrastructure in `terraform/`.

## Tech Stack

- Next.js 16 App Router
- Bun workspaces + Turborepo
- TypeScript
- Tailwind CSS 4
- Clerk (auth)
- Postgres (Cloud SQL) + ClickHouse + Upstash Redis
- Cloud Run (backend services)

## Getting Started

1. Install dependencies.

```bash
bun install
```

2. Create local env files from the checked-in templates.

```bash
cp .env.example .env.local
cp apps/api/.env.example apps/api/.env.local
cp apps/app/.env.example apps/app/.env.local
cp apps/admin/.env.example apps/admin/.env.local
cp apps/web/.env.example apps/web/.env.local
```

3. Fill in the credentials and service URLs required for the apps you plan to run.
4. Apply the database schema (Postgres) if you are running services that need it.

```bash
DATABASE_URL=postgres://... ./db/apply.sh
```

5. Start the workspace dev servers.

```bash
bun dev
```

Common local ports:

- `web`: `http://localhost:3000`
- `app`: `http://localhost:3001`
- `api`: `http://localhost:3002`
- `docs`: `http://localhost:3003`
- `admin`: `http://localhost:3004`

## Common Commands

```bash
bun dev
bun run build
bun run lint
bun run check:repo-hygiene
bun run verify:api-health-routes
bun run audit:deps
```

## Verification And Releases

- Read [TESTING.md](TESTING.md) for CI and local verification guidance used by maintainers.
- Read [RELEASING.md](RELEASING.md) for how changes promote from staging to production, and how to roll back.
- Review [SECURITY.md](SECURITY.md) before reporting vulnerabilities.

## Security And Hygiene

- Local env files such as `.env.local` are ignored and must never be committed.
- Never commit credentials, secrets, or personal data. `bun run check:repo-hygiene` enforces the basics in CI.
- Threat model, key inventory, and rotation runbooks live in [docs/security/](docs/security/).

## License

MIT. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for vendored-asset posture.

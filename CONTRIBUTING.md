# Contributing to Tokens

Tokens welcomes issues and feedback, but we do not accept external pull
requests. External pull requests are closed automatically without review.

The code is open source under the MIT license, but the hosted Tokens product,
its frontend experience, and its curated token, venue, market, and metadata
coverage remain operated and controlled by the Tokens team. Maintainers decide
which reported issues and suggestions are incorporated into the hosted product.

## Filing an Issue

Before opening an issue, search existing issues to avoid duplicates. Include
enough context for the maintainers to evaluate the report or suggestion.

For bugs, include:

- A clear description of the issue
- Steps to reproduce it
- Expected and actual behavior
- Relevant environment details
- Relevant logs or errors, with secrets redacted

For data corrections or suggestions involving tokens, venues, markets, logos,
metadata, or rankings, include reliable supporting sources. Filing an issue does
not guarantee that the requested change or listing will be adopted.

For security-sensitive reports, do not open a public issue. Follow
[SECURITY.md](SECURITY.md).

## Local Development

You may fork and run the project for your own use under the terms of the MIT
license.

1. Fork and clone the repository.

```bash
git clone https://github.com/<your-username>/tokens.git
cd tokens
```

2. Install dependencies.

```bash
bun install
```

3. Create local env files from the checked-in templates.

```bash
cp .env.example .env.local
cp apps/api/.env.example apps/api/.env.local
cp apps/app/.env.example apps/app/.env.local
cp apps/admin/.env.example apps/admin/.env.local
cp apps/web/.env.example apps/web/.env.local
```

4. Fill in only the env vars required for the apps you are running.
5. Start development.

```bash
bun dev
```

## Project Structure

- `apps/web/`: public website
- `apps/docs/`: documentation site
- `apps/api/`: platform API and internal helper routes
- `apps/app/`: authenticated dashboard for projects, API keys, and usage
- `apps/admin/`: authenticated admin tooling for curated assets
- `apps/cloudrun-*/`: backend services (assets, prices, usage, admin) behind the API
- `packages/`: shared packages used by multiple apps
- `db/`: SQL schema and ordered migrations (Postgres)
- `terraform/`: infrastructure-as-code for staging/production
- `scripts/`: verification, seeding, and maintenance scripts

## Development Expectations

- Use TypeScript for new code.
- Follow the existing formatting and linting rules.
- Keep public API contracts stable unless a breaking change is intentional and documented.
- Treat admin and operational code as security-sensitive. Enforce authorization server-side, not only in UI state.
- Never commit credentials, `.env.local` files, or assistant/tooling artifacts.
- This is a public repository: never include real endpoints, tokens, Terraform plan/state files, or `.env` values in code, fixtures, commit messages, or PR descriptions. Use placeholders following the existing `*.example.run.app` / `.env.example` convention. A tracked pre-commit hook (`.githooks/pre-commit`, wired up by `bun install`) runs `gitleaks protect --staged` when gitleaks is installed locally; CI re-scans the tree and full history either way.
- Do not treat `apps/admin` as a public anonymous surface. It is an authenticated maintainer tool.
- Avoid adding vendored third-party assets unless redistribution terms are documented in `THIRD_PARTY_LICENSES.md`.

## Verifying Local Changes

```bash
bun run check:repo-hygiene
bun run verify:api-health-routes
bun run lint
bun run typecheck
bun run test
bun run build
```

CI runs the same commands in the `build-and-lint` check, plus `secret-scan`,
`dependency-audit`, and `CodeQL`; all four must pass before a PR can merge
(see [TESTING.md](TESTING.md)). Paths listed in `.github/CODEOWNERS` also
require a code-owner review.

If you touched dependency versions or security-sensitive paths, also run:

```bash
bun run audit:deps
```

## Pull Request Policy

Only maintainer-authored pull requests originating from repositories within the
`solana-foundation` GitHub organization are accepted. If you believe a change
belongs in the hosted product, open an issue so the maintainers can evaluate and
implement it.

## License

Use, modification, and redistribution of the repository code are governed by
the MIT License.

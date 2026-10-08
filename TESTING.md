# Testing

What CI enforces for maintainer-authored changes and what anyone can run
locally. Maintainer pull requests are expected to pass the credential-free
automated checks below; environment-dependent checks are run by maintainers
against staging.

## Automated Checks (no credentials needed)

These run in CI and locally with no external accounts. They are the baseline for
maintainer-authored changes:

```bash
bun run check:repo-hygiene
bun run validate:grafana-config
bun run verify:api-health-routes
bun run lint
bun run typecheck
bun run test
bun run build
bun run audit:deps
```

What these cover:

- `check:repo-hygiene`: blocks tracked secret-bearing env files, assistant artifacts, and junk files such as `.DS_Store`
- `validate:grafana-config`: validates the dashboard and alert-rule JSON under `alert-rules/`
- `verify:api-health-routes`: smoke-checks the public health route handlers and their cache/request-id behavior
- `lint`: static analysis across the monorepo
- `typecheck`: `tsc --noEmit` across the workspaces
- `test`: unit tests (`bun test`) across the workspaces
- `build`: production builds for the workspaces in scope
- `audit:deps`: dependency advisory scan

### Required status checks on `main`

The repo ruleset on `main` blocks merge until these checks pass on the PR head:

| Check              | Workflow             | Covers                                                          |
| ------------------ | -------------------- | --------------------------------------------------------------- |
| `build-and-lint`   | `ci.yml`             | everything in the list above except `audit:deps`                |
| `secret-scan`      | `security.yml`       | gitleaks over the working tree and full git history             |
| `dependency-audit` | `security.yml`       | `check:repo-hygiene` + `audit:deps`                             |
| `CodeQL`           | GitHub default setup | static analysis for JavaScript/TypeScript and Actions workflows |

Advisory (non-blocking): `Greptile Review`, `react-doctor`, the terraform
`plan` job (runs only on PRs that touch `terraform/`).

## Environment-Dependent Checks (maintainers)

Some verification requires real credentials, a seeded data environment, or a deployed API
surface, so it is not part of the credential-free baseline and is run by
maintainers against staging:

```bash
bun run verify:assets-api-v1
node scripts/smoke-assets-v1.mjs
```

These require environment variables such as:

- `API_BASE_URL` or `TOKENS_API_BASE_URL`
- `API_KEY` or `TOKENS_API_KEY`

You do not need these credentials to run the public checks or work with a fork.
Maintainers run the data-dependent checks during internal review where relevant.

## Testing Posture

- Public API route smoke coverage exists but is intentionally narrow.
- Hosted and data-dependent behavior is verified against staging during review.
- Operational apps (`apps/admin`, `apps/cloudrun-*`) are build-verified in CI, not
  comprehensively end-to-end tested here.

If you add security-sensitive behavior, auth boundaries, or public API routes, add or update
an automated check alongside the change.

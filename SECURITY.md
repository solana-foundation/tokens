# Security Policy

## Scope

Security fixes are made on the `main` branch, which is what the hosted Tokens surfaces are deployed from. Reports affecting the hosted API/website or the code in this repository are in scope.

## Reporting A Vulnerability

Do not open a public GitHub issue for security reports.

Report privately via GitHub's [private vulnerability reporting](https://github.com/solana-foundation/tokens/security/advisories/new) for this repository. Please include:

- A clear description of the issue
- The affected paths, endpoints, or packages
- Reproduction steps or proof of concept
- Impact assessment
- Any suggested remediation

Please redact credentials, API keys, and personal data from all reports.

## Security Documentation

- [Threat model: API-key provisioning and platform auth](docs/security/threat-model-api-keys.md)
- [Key inventory](docs/security/key-inventory.md) — shared service secrets, owners, rotation cadence
- [Secret rotation runbooks](docs/security/secret-rotation.md)

Changes to the paths listed in `.github/CODEOWNERS` are treated as Critical tier under the Solana Foundation SDLC: they require code-owner review, passing status checks, and an internal security review before merge.

## Disclosure Expectations

- We will acknowledge receipt as soon as practical.
- We will validate the report, assess impact, and prepare a fix on `main`.
- We may ask for additional reproduction details if the issue is unclear.

Please avoid public disclosure until a fix or mitigation is available.

# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (main) | Yes |
| Older releases | Security fixes only for 6 months after supersession |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Send a detailed report to: **security@weaveintel.ai**

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept code or commands, if applicable)
- The affected component (app, package, deploy config)
- Any suggested mitigations you have identified

You will receive an acknowledgement within **2 business days** and a severity assessment within **7 business days**. We aim to release a fix within **30 days** for critical issues.

We follow **coordinated disclosure**: please allow us the above timeline before making any public disclosure. We will credit you in the release notes unless you prefer to remain anonymous.

## Security Architecture

WeaveIntel is a monorepo containing:
- `apps/geneweave` — HTTP API server (Node.js / TypeScript)
- `packages/` — shared primitives (compliance, reliability, workflows, oauth, …)
- `deploy/` — production entrypoint

Key security controls:
- JWT-based authentication with CSRF double-submit protection
- All HTTP responses carry `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`, and `Strict-Transport-Security` headers
- Database inputs parameterised via the SQLite adapter; prototype-pollution hardened via safe input parsing
- Network-guard (`packages/net-guard`) blocks SSRF from agent tool calls
- Rate limiting on auth and API routes
- GDPR right-to-delete (`DELETE /api/me/account`) and data portability (`GET /api/me/export`)

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| XSS | `Content-Security-Policy`, `X-Content-Type-Options`, React's DOM escaping |
| CSRF | CSRF double-submit token on all mutating routes |
| SQL injection | Parameterised queries in SQLiteAdapter |
| SSRF | `net-guard` allowlist on agent tool HTTP calls |
| JWT forgery | `HS256` with server-held secret; short session TTL |
| Secrets in logs | PII redaction via `@weaveintel/observability` |
| Prototype pollution | `safePageInt` + JSON body hardening |
| DoS (query floods) | In-process rate limiter (Redis-backed in clustered deployments) |

## Automated Security Checks

The `.github/workflows/security.yml` workflow runs on every push to `main` and weekly:
- **CodeQL** — static analysis for JS/TS vulnerabilities
- **npm audit** — dependency vulnerability gate (fail on HIGH/CRITICAL)
- **gitleaks** — secret scanning across git history
- **Trivy** — container and filesystem vulnerability scan
- **CycloneDX** — SBOM generation

Dependabot is configured to open PRs for npm and GitHub Actions updates weekly.

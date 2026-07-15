# Contributing to WeaveIntel

Thank you for taking the time to contribute!

## Getting Started

```bash
git clone https://github.com/your-org/weaveintel.git
cd weaveintel
npm install
cp .env.example .env   # fill in required keys
npm run dev            # starts all packages in watch mode
```

## Repository Layout

```
apps/
  geneweave/          API server + UI
  geneweave-ui/       React SPA
packages/
  core/               Shared primitives, UUID, runtime
  compliance/         GDPR deletion, consent, audit-export
  reliability/        Idempotency, health checks, retry
  workflows/          Workflow engine, rate limiter
  observability/      Structured logging, OTel tracing
  oauth/              OAuth 2.0 providers
  net-guard/          SSRF protection for agent tools
  ui-primitives/      Shared React UI components
deploy/               Production entrypoint (server.ts)
scripts/              Developer scripts, pentest, stress tests
```

## Development Workflow

1. **Fork** the repo and create a branch: `git checkout -b feat/my-feature`
2. **Write tests** — new behaviour requires unit tests; bug fixes require a regression test
3. **Run the test suite**: `npm test`
4. **Lint**: `npm run lint` (we use ESLint + TypeScript strict mode)
5. **Type-check**: `npm run typecheck`
6. **Open a PR** against `main` with a clear description of what and why

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): add Redis-backed rate limiter
fix(auth): prevent session fixation on re-login
docs: update CONTRIBUTING.md
chore(deps): bump typescript to 5.8
```

Scopes match the app or package name (`geneweave`, `compliance`, `workflows`, etc.).

## Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] TypeScript compiles without errors (`npm run typecheck`)
- [ ] No new `any` types introduced without a comment explaining why
- [ ] Security-sensitive changes include a note in the PR description
- [ ] Breaking API changes are documented in the PR body
- [ ] New environment variables are documented in `deploy/server.ts` header JSDoc
- [ ] **A changeset is included** for any change to a published `@weaveintel/*` package (`npx changeset`)

## Releasing

The `@weaveintel/*` libraries are published to npm **independently** with [Changesets](.changeset/README.md); the
geneWeave product versions separately (see [`VERSIONING.md`](VERSIONING.md)).

- **In your PR:** run `npx changeset`, pick the package(s) you changed and the bump type (`major` = breaking,
  `minor` = feature, `patch` = fix), and commit the generated `.changeset/*.md`. No changeset ⇒ that package
  won't release.
- **After merge (automated):** the Release workflow opens a **"Version Packages" PR** that applies the pending
  changesets; merging it **publishes** the bumped packages to npm via **Trusted Publishing (OIDC)** with a
  provenance attestation — no tokens, nothing to run by hand. See [`.changeset/README.md`](.changeset/README.md).

## Reporting Bugs

Open a GitHub issue using the **Bug Report** template. For security vulnerabilities see [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.

## License

By contributing you agree that your contributions will be licensed under the same license as the project (see `LICENSE`).

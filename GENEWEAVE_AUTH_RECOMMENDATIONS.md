# GeneWeave Authentication Security Recommendations

Date: 2026-05-15
Scope: apps/geneweave authentication, sessions, OAuth callbacks, and admin-route authorization posture.

## Summary
GeneWeave has a solid baseline for cookie-based auth (JWT + DB session + CSRF + scrypt), but there are important modernization and hardening opportunities.

Most important priorities:
1. Enforce RBAC consistently on all `/api/admin/*` routes.
2. Harden production IP/rate-limit trust boundaries.
3. Lock OAuth origin behavior to configured public origin.
4. Modernize token/session lifecycle with rotating refresh tokens and session management.
5. Add phishing-resistant MFA (passkeys/WebAuthn).

## Current Strengths
- JWT signing and verification with algorithm checks and timing-safe signature compare.
- Session lookup in DB with expiry checks.
- CSRF token validation for mutating routes.
- Password hashing via scrypt with migration-aware verification.
- `HttpOnly` auth cookie with `SameSite=Strict` and `Secure` in production.

## Findings and Recommendations

### 1) Admin Route Authorization Consistency (High)
Issue:
- Several admin route modules are mounted directly and perform `auth` checks but not always explicit role/permission checks.

Recommendation:
- Enforce a single policy gate for every `/api/admin/*` route.
- Route all admin endpoints through a shared permission wrapper, or require explicit `canPersonaAccess(...)` checks in each admin module.

Success criteria:
- No admin endpoint is accessible with only a valid authenticated user token.
- Permission checks are centralized and covered by tests.

### 2) IP-Based Abuse Controls and Proxy Trust (Medium-High)
Issue:
- Login/register throttles rely on `x-forwarded-for`/`x-real-ip` values when present.

Recommendation:
- Trust forwarding headers only from known reverse proxies/load balancers.
- Add proxy allowlist and fallback to socket address otherwise.
- Move auth throttling state from process memory to shared backend (Redis) for multi-instance correctness.

Success criteria:
- Header spoofing cannot bypass lockout/rate-limit controls.
- Limits apply consistently across all app instances.

### 3) OAuth Host/Origin Hardening (Medium)
Issue:
- OAuth redirect origin can be inferred from request host if `publicBaseUrl` is absent.

Recommendation:
- Require explicit `publicBaseUrl` in non-dev environments.
- Reject OAuth authorize/callback flows when host origin does not match configured origin allowlist.

Success criteria:
- OAuth redirects are deterministic and not host-header-driven in production.

### 4) Identity Canonicalization (Medium)
Issue:
- Email handling appears case-sensitive at query/storage boundaries.

Recommendation:
- Canonicalize email (`trim + lowercase`) on write and lookup.
- Enforce uniqueness against canonical value (via dedicated normalized column or DB collation strategy).

Success criteria:
- `User@domain.com` and `user@domain.com` cannot create separate logical identities.

### 5) Token/Session Lifecycle Modernization (Medium)
Issue:
- Current model is single JWT session cookie flow without refresh-token family controls.

Recommendation:
- Adopt short-lived access token + rotating refresh token family.
- Add refresh-token reuse detection and family invalidation.
- Add user-facing session/device listing and revoke-all-except-current controls.

Success criteria:
- Stolen refresh tokens are detected and neutralized.
- Users can self-remediate account compromise by revoking sessions.

### 6) MFA and Step-Up Authentication (Medium)
Issue:
- No phishing-resistant second factor for high-risk operations.

Recommendation:
- Add WebAuthn/passkeys as preferred MFA path.
- Add optional TOTP backup.
- Enforce step-up auth for sensitive actions (RBAC changes, key lifecycle actions, BYOK/break-glass operations).

Success criteria:
- Sensitive admin flows require stronger auth than baseline session.

### 7) Security Header Baseline (Low-Medium)
Issue:
- Security response header posture can be strengthened.

Recommendation:
- Add/verify: `Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, and frame restrictions.

Success criteria:
- Browser attack surface is reduced for auth/session-dependent pages.

## Suggested Implementation Phases

### Phase 1 (Immediate Hardening)
- Admin RBAC consistency pass across all `/api/admin/*` endpoints.
- Proxy trust hardening for IP extraction.
- OAuth origin lock in production.

### Phase 2 (Session Modernization)
- Rotating refresh-token family design and implementation.
- Session/device management APIs + UI controls.
- Redis-backed distributed auth throttles.

### Phase 3 (Modern Auth)
- WebAuthn/passkey enrollment/login.
- TOTP fallback support.
- Step-up auth policy for high-risk admin and encryption operations.

## Validation Checklist
- Unit/integration tests for permission gates on every admin route group.
- Abuse tests for spoofed forwarding headers.
- OAuth redirect-origin mismatch negative tests.
- Email canonicalization migration and duplicate-prevention tests.
- Refresh-token rotation + reuse detection tests.
- Step-up auth requirement tests on sensitive endpoints.

## Notes
- This document captures recommendations only. No code changes were applied as part of this write-up.

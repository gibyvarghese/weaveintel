# `@weaveintel/encryption`

Per-tenant envelope encryption for multi-tenant data stores.

- AES-256-GCM authenticated encryption with required AAD (`tenant|table|column|rowId|epoch`).
- Three-layer key hierarchy: KMS root → KEK → DEK → ciphertext.
- Pluggable `KmsProvider` (built-in `local`; cloud providers in Phase 7).
- Pluggable `EncryptionStore` and `AuditEmitter` interfaces — apps wire DB persistence.
- Sentinel ciphertext format `enc:v1:<epoch>:<iv_b64>:<ct_b64>` — plaintext rows pass through unchanged.

## Reusability invariant

Depends ONLY on `@weaveintel/core` and Node `node:crypto`. No app or DB imports. Any host wires persistence via the `EncryptionStore`/`AuditEmitter`/`KmsProvider` interfaces.

## Phase 1 scope

`KmsProvider`, `LocalKmsProvider`, `weaveTenantKeyManager` (encrypt / decrypt / bootstrapTenant / rotateDek / rotateKek), envelope codec, default field policy. Rotation rewriting and blind indexes ship in later phases.

See `docs/TENANT_ENCRYPTION_DESIGN.md` for full design.

# @weaveintel/encryption

**Per-tenant envelope encryption for sensitive fields: pluggable KMS providers, a key manager, and authenticated (AEAD) crypto.**

## Why it exists

You store customer data, and each customer wants their own lock — one tenant's key should never open another tenant's records, and you should never have to decrypt everything just to rotate one key. Doing this by hand means juggling raw keys in your database, which is exactly what auditors don't want to see. Think of it like a bank's safe-deposit vault: each box has its own key, the bank holds a master key that unlocks the boxes but never sees what's inside, and you can re-key one box without touching the rest. This package is that vault for your fields.

## When to reach for it

Reach for it when you store per-tenant sensitive data (PII, secrets, documents) and need field-level encryption, key rotation, or bring-your-own-key (BYOK) with a real KMS behind it. If you only need to *hide* data from a model or a log without storing it encrypted at rest, use `@weaveintel/guardrails/redaction` instead.

## How to use it

```ts
import { createTenantKeyManager, LocalKmsProvider, encryptValue, decryptValue } from '@weaveintel/encryption';

const keys = createTenantKeyManager({ kms: new LocalKmsProvider() });

const sealed = await encryptValue('alice@example.com', { keyManager: keys, tenantId: 't-42' });
const plain = await decryptValue(sealed, { keyManager: keys, tenantId: 't-42' });
```

## What's in the box

Main entry (`@weaveintel/encryption`):

- Core crypto: `encryptValue`, `decryptValue`, `isEncrypted`.
- Key manager: `createTenantKeyManager` / `TenantKeyManager` — per-tenant keys, wrapping, rotation.
- KMS providers: `LocalKmsProvider`, `AwsKmsProvider`, `AzureKeyVaultProvider`, `GcpKmsProvider`, `VaultTransitProvider`.
- BYOK: `ByokPemKmsProvider`, `LocalByokKeystore`, `approveBreakGlass`, plus signed attestation helpers.
- Rotation & lifecycle: `weaveRewriteScheduler`, `weavePurgeScheduler`, blind-index helpers for searchable ciphertext.

Store subpaths (each pulls in an optional peer driver):

- `@weaveintel/encryption/sqlite`, `/postgres`, `/mongodb`, `/redis`, `/dynamodb` — persist wrapped keys and audit records in your database.

## License

MIT.

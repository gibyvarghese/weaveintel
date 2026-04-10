# @weaveintel/redaction

PII detection, content classification, and policy engine.

## Features

- **6 built-in patterns** — email, phone, SSN, credit card, IPv4, UUID
- **Reversible tokenization** — Replace PII with tokens, restore originals later
- **Allowlist** — Exempt specific values from redaction
- **Policy engine** — Rule-based content evaluation with allow/deny/flag decisions

## Usage

```typescript
import { createRedactor, createPolicyEngine } from '@weaveintel/redaction';

// Redact PII
const redactor = createRedactor({ patterns: ['email', 'phone', 'ssn', 'credit_card'] });
const result = redactor.redact('Email john@example.com, call 555-123-4567');
console.log(result.redacted);  // "Email [EMAIL_0], call [PHONE_0]"
console.log(result.restore(result.redacted)); // original text

// Policy engine
const engine = createPolicyEngine();
engine.addRule({ pattern: /password/i, action: 'deny', reason: 'Contains password' });
const decision = engine.evaluate('My password is secret123');
// { action: 'deny', reason: 'Contains password' }
```

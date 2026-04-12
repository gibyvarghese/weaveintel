/**
 * Example 08: PII Redaction
 *
 * Demonstrates the redaction pipeline for detecting and masking
 * personally identifiable information before sending to LLMs.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core      — ExecutionContext
 *   @weaveintel/redaction — Two complementary subsystems:
 *     • weaveRedactor()     — Pattern-based PII detector + masker. Supports builtin
 *                            patterns (email, phone, SSN, credit card, IPv4) and custom
 *                            regex. "reversible: true" means original values can be restored.
 *     • weavePolicyEngine() — Rule-based policy evaluator. You define rules that check
 *                            an input and return { allowed, reason }. Rules run in order
 *                            and a single failure rejects the input.
 *
 * Typical flow: redact PII from user input → send to LLM → restore originals in output.
 * The policy engine adds an extra layer for content-level checks beyond PII.
 */
import { weaveContext } from '@weaveintel/core';
import { weaveRedactor, weavePolicyEngine } from '@weaveintel/redaction';

async function main() {
  const ctx = weaveContext({ userId: 'demo-user' });

  // --- Basic PII Redaction ---
  console.log('=== Basic PII Redaction ===');

  // weaveRedactor() creates a PII detection + masking engine.
  // "patterns" lists which PII types to detect (builtins use curated regex).
  // "reversible: true" stores a token→original mapping so you can undo the
  // redaction after the LLM responds (e.g. put real names back in the output).
  const redactor = weaveRedactor({
    patterns: [
      { name: 'email', type: 'builtin', builtinType: 'email' },
      { name: 'phone', type: 'builtin', builtinType: 'phone' },
      { name: 'ssn', type: 'builtin', builtinType: 'ssn' },
      { name: 'credit_card', type: 'builtin', builtinType: 'credit_card' },
      { name: 'ipv4', type: 'builtin', builtinType: 'ipv4' },
    ],
    reversible: true,
  });

  const input = `
    Customer: John Doe
    Email: john.doe@example.com
    Phone: (555) 123-4567
    SSN: 123-45-6789
    Card: 4111-1111-1111-1111
    IP: 192.168.1.100
    Notes: Please process this refund to the card above.
  `;

  // .redact() scans the text and replaces each PII match with a token
  // like <EMAIL_1>, <PHONE_1>, etc. Returns:
  //   • .redacted   — the masked text safe to send to an LLM
  //   • .detections — array of { type, original, token } for each match
  const redacted = await redactor.redact(ctx, input);
  console.log('Original:\n', input);
  console.log('Redacted:\n', redacted.redacted);
  console.log('Detections:');
  for (const det of redacted.detections) {
    console.log(`  ${det.type}: "${det.original}" → "${det.token}"`);
  }

  // .restore() reverses the redaction: replaces tokens with original values.
  // Only available when the redactor was created with "reversible: true".
  console.log('\n=== Restore ===');
  const restored = await redactor.restore!(ctx, redacted.redacted, redacted.detections);
  console.log('Restored:\n', restored);

  // Allowlists let you exempt known-safe values from redaction.
  // Here john.doe@example.com will pass through unredacted, but
  // jane@secret.com will still be masked.
  console.log('\n=== Allowlist ===');
  const redactorWithAllow = weaveRedactor({
    patterns: [
      { name: 'email', type: 'builtin', builtinType: 'email' },
      { name: 'phone', type: 'builtin', builtinType: 'phone' },
    ],
    allowlist: ['john.doe@example.com'], // This email is allowed
  });

  const result = await redactorWithAllow.redact(ctx, 'Contact john.doe@example.com or jane@secret.com, call 555-0199');
  console.log('With allowlist:', result.redacted);
  console.log('Detections:', result.detections.length);

  // weavePolicyEngine() is a lightweight rule engine. Each rule is an async
  // function that inspects the input and returns { allowed, reason, policies }.
  // All rules are evaluated; if any returns allowed=false, the overall result
  // is rejected. Use this for guardrails beyond PII (length limits, topic
  // restrictions, compliance rules, etc.).
  console.log('\n=== Policy Engine ===');

  const policy = weavePolicyEngine();

  policy.addRule({
    name: 'no-pii-in-prompts',
    description: 'Prompts must not contain PII',
    evaluate: async (_ctx, input) => {
      const text = input.data?.['text'] as string ?? '';
      const piiPatterns = [
        /\b\d{3}-\d{2}-\d{4}\b/,       // SSN
        /\b\d{4}-\d{4}-\d{4}-\d{4}\b/, // Credit card
      ];
      const hasViolation = piiPatterns.some((p) => p.test(text));
      return {
        allowed: !hasViolation,
        reason: hasViolation ? 'PII detected in input' : undefined,
        policies: ['no-pii-in-prompts'],
      };
    },
  });

  policy.addRule({
    name: 'max-length',
    description: 'Prompt must not exceed 10,000 characters',
    evaluate: async (_ctx, input) => {
      const text = input.data?.['text'] as string ?? '';
      const tooLong = text.length > 10_000;
      return {
        allowed: !tooLong,
        reason: tooLong ? `Prompt too long: ${text.length} chars` : undefined,
        policies: ['max-length'],
      };
    },
  });

  // Test clean input
  const cleanResult = await policy.evaluate(ctx, { action: 'prompt', data: { text: 'What is the weather today?' } });
  console.log('Clean input:', cleanResult.allowed ? 'PASS' : 'FAIL');

  // Test PII input
  const piiResult = await policy.evaluate(ctx, { action: 'prompt', data: { text: 'My SSN is 123-45-6789' } });
  console.log('PII input:', piiResult.allowed ? 'PASS' : 'FAIL');
  if (!piiResult.allowed) {
    console.log(`  Reason: ${piiResult.reason}`);
  }
}

main().catch(console.error);

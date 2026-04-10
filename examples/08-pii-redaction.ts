/**
 * Example 08: PII Redaction
 *
 * Demonstrates the redaction pipeline for detecting and masking
 * personally identifiable information before sending to LLMs.
 */
import { createRedactor, createPolicyEngine } from '@weaveintel/redaction';

async function main() {
  // --- Basic PII Redaction ---
  console.log('=== Basic PII Redaction ===');

  const redactor = createRedactor({
    patterns: ['email', 'phone', 'ssn', 'credit_card', 'ipv4'],
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

  const redacted = redactor.redact(input);
  console.log('Original:\n', input);
  console.log('Redacted:\n', redacted.text);
  console.log('Detections:');
  for (const det of redacted.detections) {
    console.log(`  ${det.type}: "${det.original}" → "${det.replacement}"`);
  }

  // --- Restore original values ---
  console.log('\n=== Restore ===');
  const restored = redactor.restore(redacted.text, redacted.detections);
  console.log('Restored:\n', restored);

  // --- Allowlist ---
  console.log('\n=== Allowlist ===');
  const redactorWithAllow = createRedactor({
    patterns: ['email', 'phone'],
    allowlist: ['john.doe@example.com'], // This email is allowed
  });

  const result = redactorWithAllow.redact('Contact john.doe@example.com or jane@secret.com, call 555-0199');
  console.log('With allowlist:', result.text);
  console.log('Detections:', result.detections.length);

  // --- Policy Engine ---
  console.log('\n=== Policy Engine ===');

  const policy = createPolicyEngine();

  policy.addRule({
    id: 'no-pii-in-prompts',
    description: 'Prompts must not contain PII',
    evaluate: (input: string) => {
      const piiPatterns = [
        /\b\d{3}-\d{2}-\d{4}\b/,       // SSN
        /\b\d{4}-\d{4}-\d{4}-\d{4}\b/, // Credit card
      ];
      const violations = piiPatterns
        .filter((p) => p.test(input))
        .map((p) => `PII pattern detected: ${p.source}`);
      return { passed: violations.length === 0, violations };
    },
  });

  policy.addRule({
    id: 'max-length',
    description: 'Prompt must not exceed 10,000 characters',
    evaluate: (input: string) => ({
      passed: input.length <= 10_000,
      violations: input.length > 10_000 ? [`Prompt too long: ${input.length} chars`] : [],
    }),
  });

  // Test clean input
  const cleanResult = await policy.evaluate('What is the weather today?');
  console.log('Clean input:', cleanResult.passed ? 'PASS' : 'FAIL');

  // Test PII input
  const piiResult = await policy.evaluate('My SSN is 123-45-6789');
  console.log('PII input:', piiResult.passed ? 'PASS' : 'FAIL');
  if (!piiResult.passed) {
    for (const v of piiResult.violations) {
      console.log(`  Violation: ${v}`);
    }
  }
}

main().catch(console.error);

# @weaveintel/evals

Evaluation runner with assertion-based scoring for AI model outputs.

## Assertion Types

| Type | Description |
|---|---|
| `exact_match` | Output equals expected string |
| `contains` | Output contains substring |
| `regex` | Output matches regex pattern |
| `schema_valid` | Output validates against JSON Schema |
| `latency_threshold` | Response time under N milliseconds |
| `cost_threshold` | Cost under N dollars |

## Usage

```typescript
import { createEvalRunner } from '@weaveintel/evals';

const runner = createEvalRunner({ model });

const results = await runner.run({
  name: 'geography-quiz',
  cases: [
    {
      input: { messages: [{ role: 'user', content: 'Capital of France?' }] },
      assertions: [
        { type: 'contains', value: 'Paris' },
        { type: 'latency_threshold', value: 5000 },
      ],
    },
    {
      input: { messages: [{ role: 'user', content: 'List 3 primes as JSON' }] },
      assertions: [
        { type: 'regex', value: '\\[.*\\]' },
        { type: 'schema_valid', value: { type: 'object', properties: { primes: { type: 'array' } } } },
      ],
    },
  ],
}, ctx);

console.log(results.passRate); // 0.0 - 1.0
console.log(results.cases);    // per-case results with assertion details
```

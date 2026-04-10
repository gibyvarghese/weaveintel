# @weaveintel/observability

Tracing, cost tracking, and run logging for development and testing.

## Usage

```typescript
import { createConsoleTracer, createInMemoryTracer, createUsageTracker } from '@weaveintel/observability';

// Console tracer — logs spans to stdout (development)
const tracer = createConsoleTracer();
const span = tracer.startSpan('model.generate', { model: 'gpt-4o' });
span.end({ tokens: 150 });

// In-memory tracer — collect spans for assertions (testing)
const testTracer = createInMemoryTracer();
// ... run code ...
console.log(testTracer.spans); // inspect all recorded spans

// Usage tracker — aggregate token counts and costs
const usage = createUsageTracker();
usage.record({ model: 'gpt-4o', promptTokens: 100, completionTokens: 50, cost: 0.003 });
console.log(usage.getTotal()); // { promptTokens: 100, completionTokens: 50, totalCost: 0.003 }
```

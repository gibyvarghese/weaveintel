# @weaveintel/tools-webhook

External webhook integration for live-agents: receive events from third-party systems (GitHub, Stripe, Slack) and translate them into agent-actionable contracts.

## Use cases

- **GitHub webhook:** Push events → trigger code review agent
- **Stripe webhook:** Payment events → trigger accounting agent
- **Slack bot:** Mention @agent → queue message for agent inbox

## Installation

```bash
npm install @weaveintel/tools-webhook
```

## API

### createWebhookEndpoint

Create an HTTP endpoint that receives webhooks.

```typescript
import { createWebhookEndpoint } from '@weaveintel/tools-webhook';
import express from 'express';

const app = express();
const stateStore = ...; // Your StateStore

const webhook = createWebhookEndpoint({
  stateStore,
  secret: process.env.WEBHOOK_SECRET, // Verify HMAC signature
  pathPrefix: '/webhooks',             // Endpoint: POST /webhooks/:agentId
});

app.post('/webhooks/:agentId', webhook.handler);
```

### Event translation

Map incoming webhook format to agent contract:

```typescript
const webhook = createWebhookEndpoint({
  stateStore,
  translators: {
    'github-push': async (event) => {
      // GitHub push event → code review contract
      return new Contract({
        type: 'CODE_REVIEW_REQUEST',
        statement: `Repo: ${event.repository.name}, Branch: ${event.ref}`,
        evidence: [
          { tool: 'github-webhook', result: { commits: event.commits.length } },
        ],
      });
    },
    'stripe-payment': async (event) => {
      // Stripe payment event → accounting contract
      return new Contract({
        type: 'PAYMENT_RECEIVED',
        statement: `Amount: $${event.amount}, Customer: ${event.customer_id}`,
        evidence: [
          { tool: 'stripe-webhook', result: { chargeId: event.id } },
        ],
      });
    },
  },
});
```

### Signature verification

Verify webhook signatures (HMAC-SHA256):

```typescript
// Sender (e.g., GitHub)
const signature = createHmacSignature(payload, secret);
// Header: X-Signature: sha256=abc123...

// Receiver (your webhook endpoint)
const webhook = createWebhookEndpoint({
  stateStore,
  secret: process.env.WEBHOOK_SECRET,
  verifySignature: true, // Default: true
  onUnverifiedWebhook: (event) => {
    console.warn('Unverified webhook received', event);
    // Log but don't process
  },
});
```

## Configuration

### Retry policy

```typescript
const webhook = createWebhookEndpoint({
  stateStore,
  retry: {
    maxAttempts: 3,
    backoffMs: 1000, // Exponential: 1s, 2s, 4s
  },
});
```

### Rate limiting

```typescript
const webhook = createWebhookEndpoint({
  stateStore,
  rateLimit: {
    windowMs: 60 * 1000,        // 1 minute
    maxPerWindow: 100,          // 100 webhooks per minute
    keyFn: (req) => req.body.repository?.name, // Per repository
  },
});
```

### Filtering

Only process certain webhook events:

```typescript
const webhook = createWebhookEndpoint({
  stateStore,
  filter: (event) => {
    // Only process GitHub pushes to main branch
    if (event.type === 'github-push') {
      return event.ref === 'refs/heads/main';
    }
    return true;
  },
});
```

## Routing

Route webhook events to specific agents or meshes:

```typescript
const webhook = createWebhookEndpoint({
  stateStore,
  route: async (event, agentId) => {
    // Read request path parameter to determine target agent
    // POST /webhooks/:agentId
    return agentId;
  },
  onRouteError: (event, agentId, error) => {
    console.error(`Failed to route event to agent ${agentId}`, error);
  },
});
```

## Monitoring

### Metrics

```typescript
const webhook = createWebhookEndpoint({
  stateStore,
  onSuccess: (event, agentId) => {
    metrics.counter('webhook.success', {
      eventType: event.type,
      agentId,
    });
  },
  onFailure: (event, agentId, error) => {
    metrics.counter('webhook.failure', {
      eventType: event.type,
      agentId,
      errorType: error.constructor.name,
    });
  },
});
```

### Logging

```typescript
const webhook = createWebhookEndpoint({
  stateStore,
  logger: console,
  logLevel: 'debug', // 'debug' | 'info' | 'warn' | 'error'
});
```

## Examples

### GitHub integration

```typescript
import { createWebhookEndpoint } from '@weaveintel/tools-webhook';
import express from 'express';

const app = express();
app.use(express.json());

const webhook = createWebhookEndpoint({
  stateStore,
  secret: process.env.GITHUB_WEBHOOK_SECRET,
  translators: {
    'github-push': async (event) => {
      const commits = event.commits.map(c => c.message).join(', ');
      return new Contract({
        type: 'CODE_REVIEW_REQUEST',
        statement: `Push to ${event.ref}: ${commits}`,
        evidence: [
          { tool: 'github-webhook', result: { pusher: event.pusher.name, timestamp: event.timestamp } },
        ],
      });
    },
  },
});

app.post('/webhooks/code-reviewer', webhook.handler);
app.listen(3000);

// GitHub webhook URL: https://your-domain.com/webhooks/code-reviewer
// Events: Push, Pull Request, Issues, etc.
```

### Stripe integration

```typescript
const webhook = createWebhookEndpoint({
  stateStore,
  secret: process.env.STRIPE_WEBHOOK_SECRET,
  translators: {
    'stripe-payment.success': async (event) => {
      return new Contract({
        type: 'PAYMENT_PROCESSED',
        statement: `Payment $${event.data.object.amount / 100} for ${event.data.object.customer}`,
        evidence: [{ tool: 'stripe-webhook', result: event.data }],
      });
    },
    'stripe-charge.failed': async (event) => {
      return new Contract({
        type: 'PAYMENT_FAILED',
        statement: `Failed: ${event.data.object.failure_message}`,
        evidence: [{ tool: 'stripe-webhook', result: event.data }],
      });
    },
  },
});

app.post('/webhooks/accounting', webhook.handler);
```

## Testing

### Mock webhooks

```typescript
import { createMockWebhookClient } from '@weaveintel/tools-webhook/testing';

const mockClient = createMockWebhookClient({
  baseUrl: 'http://localhost:3000',
  secret: 'test-secret',
});

// Send mock webhook
await mockClient.send('/webhooks/agent-123', {
  type: 'github-push',
  ref: 'refs/heads/main',
  repository: { name: 'weaveintel' },
  commits: [{ message: 'Fix bug' }],
});

// Verify agent received event
const messages = await stateStore.loadMessages('agent-123');
expect(messages).toHaveLength(1);
expect(messages[0].contract.type).toBe('CODE_REVIEW_REQUEST');
```

## Security

- Always verify webhook signatures (HMAC)
- Use HTTPS for webhook URLs
- Store secrets in environment variables (never commit)
- Rate limit to prevent abuse
- Log all webhook events for audit trail

## Related

- [@weaveintel/live-agents](../live-agents/README.md) — Core framework
- [@weaveintel/tools-filewatch](../tools-filewatch/README.md) — File system watching
- [Use Cases](../../docs/live-agents/use-cases.md) — Webhook examples

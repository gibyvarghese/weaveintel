# @weaveintel/a2a

**Let your agents talk to other agents over the Agent-to-Agent (A2A) protocol — as a client, a server, or both.**

## Why it exists

One agent rarely knows everything. Sometimes the right move is to delegate: hand a task to a specialist agent that lives somewhere else and wait for it to report back. A2A is the shared etiquette for that hand-off — like two colleagues agreeing on how to send a work request, check on its progress, and get notified when it's done. This package speaks that etiquette on both sides: it can hire other agents, and it can turn one of your own agents into a hireable service.

## When to reach for it

Reach for it when agents in *different* processes or services need to delegate tasks to each other. If you just want your agent to call plain tools (not other agents), you don't need this — use a `ToolRegistry` from `@weaveintel/core`. For a single in-process test you can skip HTTP entirely with `weaveA2ABus`.

## How to use it

```ts
import { weaveA2AClient } from '@weaveintel/a2a';
import { weaveContext } from '@weaveintel/core';

const client = weaveA2AClient();
const ctx = weaveContext();

const card = await client.discover('https://agents.example.com/research');
const agentUrl = card.supportedInterfaces?.[0]?.url ?? card.url!;

const task = await client.sendMessage(ctx, agentUrl, {
  message: { role: 'user', parts: [{ text: 'Summarize Q3 sales' }], messageId: 'm1', contextId: 'c1' },
});

console.log(task.status.state);   // e.g. "TASK_STATE_COMPLETED"
```

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveA2AClient()` | Client: `discover`, `sendMessage`, `streamMessage`, `getTask` |
| `weaveAgentAsA2AServer(opts)` | Turn one of your agents into an A2A-serving endpoint |
| `weaveA2ABus()` | In-process client↔server bus (no HTTP) for tests/embedding |
| `createA2ADispatcher`, `weaveA2AServer`, `streamToSse` | JSON-RPC 2.0 server dispatch + SSE streaming |
| `create*A2ATaskStore` / `createSqliteA2ATaskStore` | In-memory, durable, or SQLite task persistence |
| `signAgentCard`, `verifyAgentCard`, `createJwtValidator` | Card signing and JWT auth for trusted agents |
| `createInMemoryPushNotificationStore`, `deliverToWebhook` | Webhook push notifications for task updates |

### Authenticated, independent messages

`createAuthenticatedA2AMessageDispatcher` is an opt-in adapter for hosts that
verify credentials and authorize each request. The host supplies an
`authenticate(headers)` callback returning a verified execution context with
tenant and user IDs, and an `authorize(context, params)` callback. It accepts
only independent `SendMessage` calls; task/conversation references, streaming,
task lookup, subscriptions and push configuration are refused. It does not open
an HTTP route, authenticate credentials itself, or make an unscoped task store
safe. This is a restricted subset of the package's A2A 1.0 JSON-RPC
implementation, not a claim of full A2A 1.0 conformance; the underlying
dispatcher currently does not reject unsupported version headers.
Missing or incomplete authentication returns 401, explicit authorization denial
returns 403, and callback failures return a sanitized 500. Hosts should log
callback failures at their source without exposing credentials or private data.

#### Reuse and scope

The adapter composes the existing `createA2ADispatcher` and JSON-RPC codec; it
does not implement a second protocol engine. Its callbacks are integration seams
for the host's existing verified identity and policy engines, not a new
credential or delegation implementation. The existing dispatcher's optional
JWT validator validates a token but does not bind its claims to the supplied
execution context, and its task-store subscription path has no caller parameter.
The adapter is needed to bind a host-verified context and require authorization
for this restricted message path; it is not a replacement for owner-scoped task
authorization. The MCP server's `contextFactory` is an analogous verified
identity boundary, but is specific to MCP transports.

No event stream, model router, canvas interaction or storage engine is added.
Streaming and task storage remain available in the existing A2A package, but
are deliberately not exposed by this adapter until the host can enforce
per-caller task isolation and ongoing access.

Use a stateless or properly isolated server and enforce request limits,
resource/field permissions and auditing in the host. Credential verification
must establish the intended audience and delegated principal and consent;
never trust identity, scopes or delegation claimed in message parameters.
Downstream tools need their own authorization and controlled egress: a caller's
authorization to invoke an agent is not permission to act as the service
identity. The original dispatcher remains available for hosts implementing
their own isolation.

## License

MIT.

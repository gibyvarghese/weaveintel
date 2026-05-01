# @weaveintel/tools-kaggle

MCP server exposing Kaggle REST operations as audited, policy-gated tools. Phase **K1** shipped the **read-only** surface (13 tools). Phase **K2** adds the two competition-write tools and two sandboxed local helpers — total **17 tools**.

## Tools

### Phase K1 — read-only Kaggle REST

| Tool | Risk |
| --- | --- |
| `kaggle.competitions.list` | `read-only` |
| `kaggle.competitions.get` | `read-only` |
| `kaggle.competitions.files.list` | `read-only` |
| `kaggle.competitions.leaderboard.get` | `read-only` |
| `kaggle.competitions.submissions.list` | `read-only` |
| `kaggle.datasets.list` | `read-only` |
| `kaggle.datasets.get` | `read-only` |
| `kaggle.datasets.files.list` | `read-only` |
| `kaggle.kernels.list` | `read-only` |
| `kaggle.kernels.get` | `read-only` |
| `kaggle.kernels.pull` | `read-only` |
| `kaggle.kernels.status` | `read-only` |
| `kaggle.kernels.output` | `read-only` |

### Phase K2 — write + sandboxed local

| Tool | Risk | Approval | Notes |
| --- | --- | --- | --- |
| `kaggle.competitions.submit` | `external-side-effect` | required | Counts against Kaggle's per-competition daily submission cap (typically 5/day). Pre-validate with `kaggle.local.validate_submission` before calling. |
| `kaggle.kernels.push` | `external-side-effect` | required | Defaults to `isPrivate=true`, `enableInternet=false`, `enableGpu=false`. |
| `kaggle.local.validate_submission` | `read-only` | none | Pure-TS pre-flight: header order, row count, ID uniqueness/coverage. No network, no credentials. |
| `kaggle.local.score_cv` | `read-only` | none | Cross-validation in a sandboxed Python container via `@weaveintel/sandbox`. Requires the `kaggle-runner` image digest to be registered in the host `ImagePolicy`. |

### Sandboxed runner image

The `kaggle.local.score_cv` tool dispatches into a deterministic Python container. Build and publish:

```bash
docker build -t weaveintel/kaggle-runner:0.1.0 packages/tools-kaggle/runner
docker push weaveintel/kaggle-runner:0.1.0
```

Capture the resulting `sha256:...` digest, then:

1. Replace `KAGGLE_RUNNER_IMAGE_DIGEST` in `packages/tools-kaggle/src/local-tools.ts` (or pass `runnerImageDigest` to `createKaggleMCPServer`).
2. Register the digest in your host `ImagePolicy`:

```ts
import { ContainerExecutor, createImagePolicy } from '@weaveintel/sandbox';
import { kaggleRunnerImagePolicyEntry, createKaggleMCPServer } from '@weaveintel/tools-kaggle';

const digest = 'sha256:<from docker push>';
const executor = new ContainerExecutor({
  runtime: /* your container runtime */,
  imagePolicy: createImagePolicy([kaggleRunnerImagePolicyEntry(digest)]),
});
const server = createKaggleMCPServer({ containerExecutor: executor, runnerImageDigest: digest });
```

The default `KAGGLE_RUNNER_IMAGE_DIGEST` is a zero-hash placeholder that intentionally fails the `ImagePolicy` check until an operator overrides it.

## Credentials

Credentials are **never stored in this package**. Callers must supply them via `_meta.executionContext.metadata`:

```ts
weaveContext({ metadata: { kaggleUsername: '...', kaggleKey: '...' } })
```

When wired through GeneWeave, the operator-managed `tool_credentials` row pins the env var names (`KAGGLE_USERNAME`, `KAGGLE_KEY`) and the chat engine injects them into the execution context per request.

## Quickstart

```ts
import { createKaggleMCPServer, fixtureKaggleAdapter } from '@weaveintel/tools-kaggle';
import { createMCPStreamableHttpServerTransport } from '@weaveintel/mcp-server';

const server = createKaggleMCPServer({
  // Omit `adapter` to use the live REST adapter against https://www.kaggle.com/api/v1
  adapter: fixtureKaggleAdapter(),
});
const transport = createMCPStreamableHttpServerTransport({ port: 7421 });
await server.start(transport);
console.log('Kaggle MCP server listening on http://localhost:7421');
```

## Testing

```bash
npm test -w @weaveintel/tools-kaggle
```

To exercise the real Kaggle API (rate-limited, requires a real account):

```bash
TEST_LIVE_SANDBOX=1 KAGGLE_USERNAME=... KAGGLE_KEY=... npm test -w @weaveintel/tools-kaggle
```

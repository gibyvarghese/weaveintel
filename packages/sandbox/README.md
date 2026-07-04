# @weaveintel/sandbox

**Run untrusted code and commands inside a locked-down box, so a tool can execute something without putting the rest of your system at risk.**

## Why it exists

When an AI agent decides to "just run this snippet," you're handing the keys to a stranger. The snippet might be fine — or it might read your secrets, hammer the network, or spin forever. This package is the airlock: code goes into a sealed room governed by a written policy (what it may touch, for how long, how much memory), runs there, and only a result comes back out. Like a bank teller's cash drawer, the visitor never reaches past the counter.

## When to reach for it

Reach for it whenever a tool or agent needs to execute code or shell commands it didn't author — generated scripts, user-supplied snippets, plugin logic. Use the in-process `createSandbox` for quick, policy-bounded evaluation, or the container executor when you need true OS-level isolation. If you're running your *own* trusted, vetted code, you don't need a sandbox — call it directly.

## How to use it

```ts
import { createSandbox, createSandboxPolicy } from '@weaveintel/sandbox';

const sandbox = createSandbox();
const policy = createSandboxPolicy({ timeoutMs: 2000, allowNetwork: false });

const result = await sandbox.execute('return 40 + 2;', policy);
console.log(result.output); // 42
await sandbox.terminate();
```

## What's in the box

- `createSandbox` / `createSimulatedSandbox` — build a sandbox whose `execute(code, policy)` returns a `SandboxResult`.
- `createSandboxPolicy`, `validatePolicy`, `mergePolicies` — declare and combine the limits (timeout, memory, network, modules) a run must obey.
- `weaveContainerExecutor`, `DockerRuntime`, `FakeRuntime`, `createImagePolicy` — OS-level container isolation with an allow-listed, digest-pinned image policy.
- `ComputeSandboxEngine`, `createCSETools`, `createCSEMCPServer` — a session-based compute engine exposed as tools or an MCP server for agents.

## License

MIT.

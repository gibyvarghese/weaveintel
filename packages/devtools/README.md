# @weaveintel/devtools

**Developer conveniences for weaveIntel: scaffold new pieces, inspect what's registered, validate configs, mock a runtime, and plan migrations.**

## Why it exists

When you're building on a framework, half the friction is the boring setup: writing the same starter file again, squinting at which tools are actually registered, or catching a typo'd config before it fails at runtime. Think of it like the templates and spell-check built into a word processor — you *could* type every letter and proofread by eye, but the tooling makes the routine parts quick and catches mistakes early. `devtools` is that convenience layer for weaveIntel: generate a starting point, look inside a running setup, and check your config makes sense.

## When to reach for it

Reach for it at build and author time — scaffolding a new agent or tool, printing an inspection report of what's wired up, validating an agent/workflow config, or planning a migration. Grab a `createMock*` helper when you want a quick inline stub while prototyping. For deterministic *test-suite* fakes and eval scoring, use `@weaveintel/testing` instead.

## How to use it

```ts
import { scaffold, agentConfigValidator, inspect, formatReport } from '@weaveintel/devtools';

// Generate starter files for a new agent
const files = scaffold('agent', { name: 'researcher' });

// Catch config mistakes before runtime
const result = agentConfigValidator.validate({ name: 'researcher', maxSteps: 0 });
if (!result.valid) console.error(result.issues);

// See what's registered
console.log(formatReport(inspect({ /* registries */ })));
```

## What's in the box

- **Scaffold** — `scaffold`, `listTemplates` (`TemplateType`, `ScaffoldOptions`).
- **Inspector** — `inspect`, `formatReport` (tools, plugins, events → `InspectionReport`).
- **Validator** — `createValidator` plus ready-made `agentConfigValidator`, `workflowConfigValidator`, and rules like `requiredFields`, `maxStepsInRange`, `validJsonFields`.
- **Mock runtime** — `createMockModel`, `createMockEventBus`, `createMockToolRegistry`, `createMockRuntime`.
- **Migration** — `planMigration`, `formatMigrationPlan`.

Single entry point: `@weaveintel/devtools`.

## License

MIT.

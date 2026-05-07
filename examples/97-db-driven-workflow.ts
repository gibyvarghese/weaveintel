/**
 * Example 97 — DB-driven workflow steps (Workflow Platform Phase 1)
 *
 * Demonstrates:
 *   • Composing a workflow whose steps reference handlers by string ref
 *     (`tool:upper`, `script:`, `noop`) instead of pre-registering JS
 *     handlers up front.
 *   • Persisting the definition through a `WorkflowDefinitionStore`
 *     (here: in-memory, but the same shape `DbWorkflowDefinitionStore`
 *     uses against `workflow_defs` in geneweave).
 *   • Wiring the seven Phase 1 resolver kinds — only `noop`, `script`
 *     and `tool` are exercised here; the rest follow the same pattern.
 *   • Per-step `inputMap` / `outputMap` to project workflow variables
 *     into the handler input shape and back.
 *
 * No DB, no LLM, no external services. Pure in-memory.
 *
 * Run: npx tsx examples/97-db-driven-workflow.ts
 */

import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  InMemoryWorkflowDefinitionStore,
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
  describeHandlerKinds,
} from '@weaveintel/workflows';
import type { WorkflowDefinition } from '@weaveintel/core';

async function main() {
  // 1. Resolver registry with the three Phase 1 resolvers we need.
  const registry = new HandlerResolverRegistry();
  registry.register(createNoopResolver());
  registry.register(createScriptResolver());
  registry.register(
    createToolResolver({
      async getTool(toolKey) {
        if (toolKey === 'upper') {
          return async (input: Record<string, unknown>) => {
            const text = String(input['text'] ?? '');
            return { upper: text.toUpperCase() };
          };
        }
        return undefined;
      },
    }),
  );

  console.log('Registered handler kinds:');
  for (const k of describeHandlerKinds(registry)) {
    console.log(`  • ${k.kind} — ${k.description ?? '(no description)'}`);
  }

  // 2. Workflow definition. Each step's `handler` is a string ref the
  //    registry knows how to resolve. `inputMap` projects whole-run
  //    variables ($) into the handler input; `outputMap` projects the
  //    handler result back into named variables.
  const def: WorkflowDefinition = {
    id: 'demo-wf-1',
    name: 'Demo: tool + script pipeline',
    version: '1.0',
    entryStepId: 'capitalize',
    steps: [
      {
        id: 'capitalize',
        name: 'Capitalize',
        type: 'deterministic',
        handler: 'tool:upper',
        inputMap: { text: 'message' },
        outputMap: { capitalized: 'upper' },
        next: 'count',
      },
      {
        id: 'count',
        name: 'Count',
        type: 'deterministic',
        handler: 'script:',
        config: {
          // The script resolver evaluates `script` (or the `script:` ref
          // suffix) as a JS function body with access to `variables`
          // and `config`. Must `return` a value.
          script: 'return variables.capitalized.length;',
        },
        outputMap: { length: '$' },
        next: 'done',
      },
      {
        id: 'done',
        name: 'Done',
        type: 'deterministic',
        handler: 'noop',
      },
    ],
  };

  // 3. Persist via the definition store (in-memory here; in geneweave
  //    this is `DbWorkflowDefinitionStore` over `workflow_defs`).
  const store = new InMemoryWorkflowDefinitionStore();
  await store.save(def);

  // 4. Engine resolves handlers from the registry; definitions from the
  //    store. No JS handler registration required.
  const engine = new DefaultWorkflowEngine({
    resolverRegistry: registry,
    definitionStore: store,
  });

  // 5. Start the run.
  const run = await engine.startRun(def.id, { message: 'hello workflows' });

  console.log('\nRun status:', run.status);
  console.log('Variables:');
  for (const [k, v] of Object.entries(run.state.variables)) {
    console.log(`  ${k} = ${JSON.stringify(v)}`);
  }
  console.log('Steps executed:', run.state.completedSteps);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * @weaveintel/workflows — handler-kind-registry.ts
 *
 * Exposes the catalog of handler "kinds" (`tool`, `prompt`, `agent`, `mcp`,
 * `script`, `subworkflow`, `noop`, plus any custom resolvers an app
 * registers) for admin UIs. This is the workflow analogue of the Tool
 * Platform's `BUILTIN_TOOLS` list synced into `tool_catalog`.
 *
 * The intent is that geneweave (or any other host) calls
 * `syncHandlerKindsToDb(db, registry)` at startup to upsert one row per
 * registered kind into a `workflow_handler_kinds` table, which then powers
 * the admin UI's "kind" picker without hardcoded enums.
 */
import type { HandlerResolver, HandlerResolverRegistry } from './handler-resolver.js';

export interface HandlerKindDescriptor {
  kind: string;
  description: string | undefined;
  configSchema: Record<string, unknown> | undefined;
}

export function describeHandlerKinds(
  registry: HandlerResolverRegistry,
): HandlerKindDescriptor[] {
  return registry.list().map(describeResolver);
}

export function describeResolver(resolver: HandlerResolver): HandlerKindDescriptor {
  return {
    kind: resolver.kind,
    description: resolver.description,
    configSchema: resolver.configSchema,
  };
}

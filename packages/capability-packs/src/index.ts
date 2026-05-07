/**
 * @weaveintel/capability-packs
 *
 * Capability packs are operator-shippable bundles of DB rows that compose a
 * complete capability (a workflow + its handler kinds + its tools + its
 * triggers + its prompts, etc.) into a single JSON manifest that can be
 * exported from one weaveintel instance and installed into another.
 *
 * The package is intentionally agnostic about which row shapes exist — apps
 * declare their content kinds via the `PackInstallAdapter` they pass to the
 * installer. This keeps the package free of a hardcoded coupling to any
 * specific app schema.
 */

export * from './manifest.js';
export * from './validator.js';
export * from './installer.js';
export * from './version-resolver.js';

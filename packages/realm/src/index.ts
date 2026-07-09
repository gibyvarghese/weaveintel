// SPDX-License-Identifier: MIT
/**
 * @weaveintel/realm — resolve the effective configuration for a tenant across a global→tenant
 * hierarchy, with provenance and git-style drift (Phase 1), plus a version log and a package-upgrade
 * reconcile engine so shipped defaults and operator edits never clobber each other (Phase 2).
 */
export * from './realm-record.js';
export * from './context.js';
export * from './resolve.js';
export * from './realm-store.js';
export * from './realm-store-sql.js';
export * from './realm-contract.js';
export * from './realm-version.js';
export * from './realm-version-sql.js';
export * from './reconcile.js';
export * from './realm-state.js';
export * from './realm-state-sql.js';

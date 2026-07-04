// SPDX-License-Identifier: MIT
/**
 * @weaveintel/identity/oauth — OAuth 2.0 provider integration for Google, GitHub, Microsoft, Apple, Facebook
 */

export * from './oauth.js';
export {
  type AsyncOAuthStateStore,
  type DurableOAuthStateStoreOptions,
  createDurableOAuthStateStore,
} from './durable.js';

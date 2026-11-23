// SPDX-License-Identifier: MIT
/**
 * @weaveintel/connect — connector framework building blocks.
 *
 * Subpaths:
 *   `@weaveintel/connect/credentials`  credential kinds, appliers (attach, sign, refresh), the single-flight token cache
 *   `@weaveintel/connect/runner`       the generic operation runner: request from mapping rows, paging, outcomes
 *   `@weaveintel/connect/inbound`      verifier presets for inbound deliveries, the replay cache
 *   `@weaveintel/connect/replay`       record-and-replay exchanges with secret and personal-data scrubbing (tests)
 *   `@weaveintel/connect/sources`      source adapters on the runner (OData; REST is the runner itself)
 *   `@weaveintel/connect/remote`       one pinned MCP tool or A2A agent skill, called through the caller's door
 */
export * from './types.js'

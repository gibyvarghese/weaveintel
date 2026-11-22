/**
 * @weaveintel/connect — connector framework building blocks.
 *
 * Subpaths:
 *   `@weaveintel/connect/credentials`  credential kinds, appliers (attach, sign, refresh), the single-flight token cache
 *   `@weaveintel/connect/runner`       the generic operation runner: request from mapping rows, paging, outcomes
 *   `@weaveintel/connect/inbound`      verifier presets for inbound deliveries, the replay cache
 *   `@weaveintel/connect/replay`       record-and-replay exchanges with secret and personal-data scrubbing (tests)
 */
export * from './types.js'

/**
 * Example 116 — @weaveintel/plugins end-to-end (no API keys, in-memory only).
 *
 * PROBLEM THIS PACKAGE SOLVES
 * ----------------------------
 * Production AI platforms need a safe, discoverable way to extend their
 * capabilities at runtime without redeploying the host application.
 * @weaveintel/plugins provides that foundation:
 *
 *   - **Manifest** describes WHAT a plugin is: its identity, trust level,
 *     versioning constraints, and the capabilities it contributes.
 *   - **Registry** tracks WHICH plugins are installed and manages their active
 *     state so the host knows which capabilities are live at any moment.
 *   - **Lifecycle** orchestrates WHEN plugin code runs across init → start →
 *     stop → destroy phases, with priority ordering for deterministic hook
 *     execution.
 *   - **Compatibility** enforces WHETHER a plugin can run on the current host
 *     version and checks that its declared dependencies are satisfied.
 *   - **Installer** provides the SAFE entry point for installing plugins from
 *     local/private/public sources, delegating to the registry and wrapping
 *     errors so batch installs never crash the host process.
 *
 * COVERED IN THIS EXAMPLE
 * -----------------------
 *   1. createPluginManifest + validateManifest — valid and invalid manifests
 *   2. createPluginRegistry — install, search, get, activate, deactivate,
 *      enable/disable state machine, unregister
 *   3. createPluginLifecycle — register hooks with priorities, execute single
 *      plugin, executeAll, inspect hook order
 *   4. checkCompatibility — core version pass/fail, missing dependencies
 *   5. createPluginInstaller — single install, batch install, error propagation
 *
 * Run: `npx tsx examples/116-plugins.ts`
 */

import assert from 'node:assert/strict';
import {
  // Manifest
  createPluginManifest,
  validateManifest,
  type PluginManifest,
  // Registry
  createPluginRegistry,
  type InstalledPlugin,
  // Lifecycle
  createPluginLifecycle,
  type LifecyclePhase,
  // Compatibility
  checkCompatibility,
  // Installer
  createPluginInstaller,
} from '@weaveintel/plugins';

// ── Presentation helpers ──────────────────────────────────────────────────────

const PASS = '[32m✓[0m';
const FAIL = '[31m✗[0m';

function section(title: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

function ok(label: string): void {
  console.log(`  ${PASS} ${label}`);
}

// ── Shared fixture manifests ──────────────────────────────────────────────────

/**
 * A fully valid "official" tool-provider plugin.
 * Demonstrates the complete shape that createPluginManifest accepts.
 */
const webSearchManifest: PluginManifest = createPluginManifest({
  id: 'plugin-web-search',
  name: 'Web Search',
  version: '1.2.0',
  description: 'Provides real-time web search results via a tool capability.',
  author: 'WeaveIntel',
  license: 'MIT',
  homepage: 'https://weaveintel.dev/plugins/web-search',
  trust: 'official',   // highest trust level — ships with the platform
  minCoreVersion: '1.0.0',
  maxCoreVersion: '2.99.99',
  // Optional arrays default to [] when omitted:
  capabilities: [{ type: 'tool', name: 'web_search', description: 'Searches the web and returns results.' }],
  tags: ['search', 'retrieval', 'utility'],
});

/**
 * A community plugin that depends on web-search being installed first.
 * Trust level "community" signals it passed review but is not first-party.
 */
const summariserManifest: PluginManifest = createPluginManifest({
  id: 'plugin-summariser',
  name: 'Summariser',
  version: '0.5.1',
  description: 'Condenses web-search results into a short paragraph.',
  author: 'community@example.com',
  license: 'Apache-2.0',
  homepage: 'https://example.com/summariser',
  trust: 'community',
  capabilities: [{ type: 'tool', name: 'summarise', description: 'Summarises retrieved content.' }],
  minCoreVersion: '1.0.0',
  maxCoreVersion: null,          // null means "any version ≥ min"
  dependencies: ['plugin-web-search'],
  tags: ['nlp', 'summarisation'],
});

/**
 * A guardrail plugin without tags or deps — tests the optional-arrays default.
 */
const guardrailManifest: PluginManifest = createPluginManifest({
  id: 'plugin-pii-guardrail',
  name: 'PII Guardrail',
  version: '2.0.0',
  description: 'Redacts PII from model outputs before delivery.',
  author: 'WeaveIntel',
  license: 'MIT',
  homepage: 'https://weaveintel.dev/plugins/pii-guardrail',
  trust: 'official',
  capabilities: [{ type: 'guardrail', name: 'pii_redact', description: 'Strips PII.' }],
  minCoreVersion: '1.5.0',
  maxCoreVersion: null,
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n@weaveintel/plugins — full lifecycle example\n');

  // ════════════════════════════════════════════════════════════════════════════
  // 1. createPluginManifest + validateManifest
  // ════════════════════════════════════════════════════════════════════════════
  section('1. createPluginManifest + validateManifest');

  // 1a. Validate a well-formed manifest — expects zero errors.
  // validateManifest checks the required string fields: id, name, version,
  // author, minCoreVersion.  An empty errors array means the manifest is safe
  // to install.
  const validErrors = validateManifest(webSearchManifest);
  assert.equal(validErrors.length, 0, 'Valid manifest should have no errors');
  ok(`Valid manifest "${webSearchManifest.name}" passes validation (0 errors)`);

  // 1b. Construct an intentionally broken manifest to show what validateManifest
  // catches.  We force-cast so TypeScript doesn't prevent the bad shape.
  const brokenManifest = createPluginManifest({
    id: '',               // missing id
    name: 'Broken',
    version: '',          // missing version
    description: 'Bad plugin',
    author: '',           // missing author
    license: 'MIT',
    homepage: '',
    trust: 'private',
    minCoreVersion: '',   // missing minCoreVersion
    maxCoreVersion: null,
  });
  const brokenErrors = validateManifest(brokenManifest);
  // We expect 4 errors (id, version, author, minCoreVersion).
  assert.ok(brokenErrors.length >= 4, `Expected ≥4 errors, got ${brokenErrors.length}`);
  ok(`Broken manifest catches ${brokenErrors.length} validation error(s):`);
  brokenErrors.forEach((e) => console.log(`      ${FAIL} ${e}`));

  // 1c. Verify optional arrays default correctly.
  // createPluginManifest fills in empty arrays for capabilities, dependencies,
  // and tags when those fields are absent in the input.
  assert.deepEqual([...guardrailManifest.dependencies], [], 'dependencies defaults to []');
  assert.deepEqual([...guardrailManifest.tags], [], 'tags defaults to []');
  ok('Optional arrays (dependencies, tags) default to [] when omitted');

  // ════════════════════════════════════════════════════════════════════════════
  // 2. createPluginRegistry — state machine
  // ════════════════════════════════════════════════════════════════════════════
  section('2. createPluginRegistry — install / search / activate / deactivate / unregister');

  // createPluginRegistry returns a pure in-memory map.  There is no global
  // singleton — each call creates an isolated registry suitable for multi-
  // tenant or test scenarios.
  const registry = createPluginRegistry();

  // 2a. Install three plugins.  After install the state is 'installed', not yet
  //     'active'.  activatedAt is null until activate() is called.
  const installedWebSearch: InstalledPlugin = registry.install(webSearchManifest);
  const installedSummariser: InstalledPlugin = registry.install(summariserManifest);
  const installedGuardrail: InstalledPlugin = registry.install(guardrailManifest);

  assert.equal(installedWebSearch.state, 'installed');
  assert.equal(installedWebSearch.activatedAt, null);
  ok(`Installed "${webSearchManifest.name}" → state="${installedWebSearch.state}", activatedAt=null`);
  ok(`Installed "${summariserManifest.name}" → state="${installedSummariser.state}"`);
  ok(`Installed "${guardrailManifest.name}" → state="${installedGuardrail.state}"`);

  // 2b. list() with no filter should return all three plugins.
  const all = registry.list();
  assert.equal(all.length, 3);
  ok(`list() returns ${all.length} plugins`);

  // 2c. list() with a trust filter — only 'official' plugins.
  const officialOnly = registry.list({ trust: 'official' });
  assert.equal(officialOnly.length, 2);  // web-search + guardrail
  ok(`list({ trust:'official' }) returns ${officialOnly.length} plugins`);

  // 2d. list() with a capability type filter — only 'guardrail' capability.
  const guardrailsOnly = registry.list({ capability: 'guardrail' });
  assert.equal(guardrailsOnly.length, 1);
  assert.equal(guardrailsOnly[0]!.manifest.id, 'plugin-pii-guardrail');
  ok(`list({ capability:'guardrail' }) returns 1 plugin: "${guardrailsOnly[0]!.manifest.name}"`);

  // 2e. list() with a keyword query — searches name + description.
  const searchResults = registry.list({ query: 'web' });
  assert.ok(searchResults.some((p) => p.manifest.id === 'plugin-web-search'));
  ok(`list({ query:'web' }) finds "${searchResults[0]!.manifest.name}"`);

  // 2f. get() retrieves a plugin by exact id.
  const fetched = registry.get('plugin-summariser');
  assert.ok(fetched !== undefined);
  assert.equal(fetched!.manifest.version, '0.5.1');
  ok(`get('plugin-summariser') version="${fetched!.manifest.version}"`);

  // 2g. activate() transitions state from 'installed' → 'active' and records
  //     the activation timestamp.
  const activated = registry.activate('plugin-web-search');
  assert.ok(activated !== undefined);
  assert.equal(activated!.state, 'active');
  assert.ok(activated!.activatedAt !== null, 'activatedAt should be set after activate()');
  assert.equal(registry.isActive('plugin-web-search'), true);
  ok(`activate('plugin-web-search') → state="${activated!.state}", isActive=true`);

  // 2h. deactivate() transitions state from 'active' → 'disabled'.
  const deactivated = registry.deactivate('plugin-web-search');
  assert.equal(deactivated!.state, 'disabled');
  assert.equal(registry.isActive('plugin-web-search'), false);
  ok(`deactivate('plugin-web-search') → state="${deactivated!.state}", isActive=false`);

  // 2i. uninstall() removes the plugin from the registry entirely.
  const removed = registry.uninstall('plugin-pii-guardrail');
  assert.equal(removed, true);
  assert.equal(registry.get('plugin-pii-guardrail'), undefined);
  ok(`uninstall('plugin-pii-guardrail') → removed=true, get() now returns undefined`);

  // 2j. uninstall() returns false when the id is not in the registry.
  const removedAgain = registry.uninstall('plugin-pii-guardrail');
  assert.equal(removedAgain, false);
  ok(`uninstall('plugin-pii-guardrail') second time → removed=false (not found)`);

  // ════════════════════════════════════════════════════════════════════════════
  // 3. createPluginLifecycle — hook registration and ordered execution
  // ════════════════════════════════════════════════════════════════════════════
  section('3. createPluginLifecycle — register / execute / executeAll / hook order');

  // createPluginLifecycle maintains a per-plugin array of hooks sorted by
  // priority (ascending — lowest priority number runs first).
  const lifecycle = createPluginLifecycle();

  // Capture the order in which hooks fire.
  const executionLog: string[] = [];

  // 3a. Register hooks for 'plugin-web-search' across three lifecycle phases.
  //     Priority 0 runs before priority 10 within the same phase.
  lifecycle.register('plugin-web-search', 'init', () => {
    executionLog.push('web-search:init:p0');
  }, 0);

  lifecycle.register('plugin-web-search', 'init', () => {
    executionLog.push('web-search:init:p10');
  }, 10);   // higher priority number, runs later

  lifecycle.register('plugin-web-search', 'start', async () => {
    // Async hooks are awaited in sequence.
    await Promise.resolve();
    executionLog.push('web-search:start:p0');
  }, 0);

  lifecycle.register('plugin-web-search', 'stop', () => {
    executionLog.push('web-search:stop:p0');
  }, 0);

  // 3b. Register a hook for the summariser plugin on 'init'.
  lifecycle.register('plugin-summariser', 'init', () => {
    executionLog.push('summariser:init:p0');
  }, 0);

  // 3c. getHooks() shows the registered hooks for a plugin in priority order.
  const webSearchHooks = lifecycle.getHooks('plugin-web-search');
  // 2 init hooks (p0, p10) + 1 start hook + 1 stop hook = 4 total
  assert.equal(webSearchHooks.length, 4);
  // getHooks() returns all phases sorted by priority; confirm all four phases present
  const phases = webSearchHooks.map((h) => h.phase) as LifecyclePhase[];
  ok(`web-search has ${webSearchHooks.length} registered hooks: ${phases.join(', ')}`);

  // 3d. execute() runs only the hooks for one plugin and one phase.
  //     This lets the host start plugins one-by-one in dependency order.
  await lifecycle.execute('plugin-web-search', 'init');
  assert.deepEqual(
    executionLog,
    ['web-search:init:p0', 'web-search:init:p10'],
    'init hooks fired in priority order',
  );
  ok(`execute('plugin-web-search', 'init') fired ${executionLog.length} hooks in priority order`);
  ok(`  hook order: ${executionLog.join(' → ')}`);

  // 3e. executeAll() iterates every registered plugin and runs their hooks for
  //     the given phase.  Useful for broadcasting a lifecycle event platform-wide.
  executionLog.length = 0;  // reset log
  await lifecycle.executeAll('init');
  // Both plugins have 'init' hooks; summariser was registered after web-search.
  assert.ok(executionLog.includes('web-search:init:p0'));
  assert.ok(executionLog.includes('summariser:init:p0'));
  ok(`executeAll('init') fired hooks for all plugins: ${executionLog.join(' → ')}`);

  // 3f. clear() removes all hooks for a plugin — useful when uninstalling.
  lifecycle.clear('plugin-web-search');
  const clearedHooks = lifecycle.getHooks('plugin-web-search');
  assert.equal(clearedHooks.length, 0);
  ok(`clear('plugin-web-search') → 0 hooks remain`);

  // ════════════════════════════════════════════════════════════════════════════
  // 4. checkCompatibility — core version and dependency resolution
  // ════════════════════════════════════════════════════════════════════════════
  section('4. checkCompatibility — version ranges and dependency checks');

  // checkCompatibility compares the host's core version string against the
  // plugin's minCoreVersion/maxCoreVersion range and checks that every declared
  // dependency id is present in the installedPlugins list.

  // 4a. Compatible: core version in range, dependency satisfied.
  const compatResult = checkCompatibility(
    summariserManifest,
    '1.8.0',                       // host core version — within 1.0.0..∞
    ['plugin-web-search'],         // installed plugin ids
  );
  assert.equal(compatResult.compatible, true);
  assert.equal(compatResult.coreVersionOk, true);
  assert.deepEqual([...compatResult.dependenciesMet], ['plugin-web-search']);
  assert.deepEqual([...compatResult.dependenciesMissing], []);
  ok(`checkCompatibility(summariser, '1.8.0', ['plugin-web-search']) → compatible=${compatResult.compatible}`);
  ok(`  dependenciesMet: [${compatResult.dependenciesMet.join(', ')}]`);

  // 4b. Incompatible: core version too low.
  // guardrailManifest requires minCoreVersion '1.5.0' — running on '1.2.0' fails.
  const tooOldResult = checkCompatibility(guardrailManifest, '1.2.0', []);
  assert.equal(tooOldResult.compatible, false);
  assert.equal(tooOldResult.coreVersionOk, false);
  ok(`checkCompatibility(guardrail, '1.2.0', []) → compatible=${tooOldResult.compatible} (version too old)`);
  ok(`  warning: "${tooOldResult.warnings[0]}"`);

  // 4c. Incompatible: dependency missing.
  // summariserManifest depends on 'plugin-web-search' which is absent.
  const missingDepResult = checkCompatibility(summariserManifest, '2.0.0', []);
  assert.equal(missingDepResult.compatible, false);
  assert.deepEqual([...missingDepResult.dependenciesMissing], ['plugin-web-search']);
  ok(`checkCompatibility(summariser, '2.0.0', []) → compatible=${missingDepResult.compatible} (missing dep)`);
  ok(`  dependenciesMissing: [${missingDepResult.dependenciesMissing.join(', ')}]`);
  ok(`  warning: "${missingDepResult.warnings[0]}"`);

  // 4d. Compatible: within an explicit maxCoreVersion ceiling.
  // webSearchManifest allows up to '2.99.99'.
  const withinCeilingResult = checkCompatibility(webSearchManifest, '2.5.0', []);
  assert.equal(withinCeilingResult.compatible, true);
  ok(`checkCompatibility(web-search, '2.5.0', []) → compatible=${withinCeilingResult.compatible} (within ceiling)`);

  // 4e. Incompatible: exceeds maxCoreVersion ceiling.
  const exceedsCeilingResult = checkCompatibility(webSearchManifest, '3.0.0', []);
  assert.equal(exceedsCeilingResult.compatible, false);
  ok(`checkCompatibility(web-search, '3.0.0', []) → compatible=${exceedsCeilingResult.compatible} (exceeds ceiling)`);

  // ════════════════════════════════════════════════════════════════════════════
  // 5. createPluginInstaller — safe install with error capture
  // ════════════════════════════════════════════════════════════════════════════
  section('5. createPluginInstaller — single install, batch install, error capture');

  // createPluginInstaller wraps the registry's install() with a try/catch so
  // one bad plugin in a batch never prevents the others from installing.
  // It also carries the InstallSource ('local' | 'private' | 'public') so audit
  // logs can track provenance.
  const freshRegistry = createPluginRegistry();
  const installer = createPluginInstaller(freshRegistry);

  // 5a. Single install from 'local' source — should succeed.
  const singleResult = installer.install(webSearchManifest, 'local');
  assert.equal(singleResult.success, true);
  assert.equal(singleResult.source, 'local');
  assert.ok(singleResult.plugin !== null);
  assert.equal(singleResult.pluginId, 'plugin-web-search');
  ok(`install(webSearch, 'local') → success=${singleResult.success}, state="${singleResult.plugin!.state}"`);

  // 5b. Install the same plugin again — the registry Map.set() replaces the
  //     existing entry, so the installer still reports success.
  const duplicateResult = installer.install(webSearchManifest, 'local');
  assert.equal(duplicateResult.success, true);
  ok(`Duplicate install → success=${duplicateResult.success} (registry upsert, no crash)`);

  // 5c. Batch install — installs multiple plugins in one call and returns an
  //     ordered array of InstallResult objects.
  const batchResults = installer.installBatch(
    [summariserManifest, guardrailManifest],
    'public',
  );
  assert.equal(batchResults.length, 2);
  assert.equal(batchResults[0]!.pluginId, 'plugin-summariser');
  assert.equal(batchResults[1]!.pluginId, 'plugin-pii-guardrail');
  assert.ok(batchResults.every((r) => r.success === true));
  ok(`installBatch([summariser, guardrail], 'public') → ${batchResults.length} results, all successful`);

  // 5d. Verify the fresh registry now contains all three plugins.
  const allInstalled = freshRegistry.list();
  assert.equal(allInstalled.length, 3);
  ok(`freshRegistry.list() → ${allInstalled.length} plugins installed`);

  // 5e. Uninstall via installer — delegates directly to registry.uninstall().
  const uninstallOk = installer.uninstall('plugin-pii-guardrail');
  assert.equal(uninstallOk, true);
  assert.equal(freshRegistry.list().length, 2);
  ok(`installer.uninstall('plugin-pii-guardrail') → removed=true, registry now has ${freshRegistry.list().length} plugins`);

  // ════════════════════════════════════════════════════════════════════════════
  // Done
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  All @weaveintel/plugins assertions passed.');
  console.log(`${'═'.repeat(60)}\n`);
}

// Run and exit with code 1 on any unexpected error so CI picks it up.
main().catch((err: unknown) => {
  console.error('\n[FATAL]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});

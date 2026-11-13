// SPDX-License-Identifier: MIT
/**
 * The capability probe and the device state.
 *
 * The probe only looks for globals (`typeof`); it never calls `availability()` or `create()`, so it can never start
 * a download. Its summary is a hint the issuing server may use to order a chain, never a fact it allows anything on.
 * It carries no content and nothing that identifies the person.
 */

import type { EngineClass, Shell } from './constants.js';

/** Which of Chrome's built-in AI globals exist. */
export interface ChromeBuiltinFeatures {
  readonly summarizer: boolean;
  readonly languageDetector: boolean;
  readonly translator: boolean;
  readonly languageModel: boolean;
}

export interface CapabilitySummary {
  readonly shell: Shell;
  /** Local engine classes this device could plausibly run (by feature presence only). */
  readonly engineClasses: readonly EngineClass[];
  readonly chromeBuiltin: ChromeBuiltinFeatures;
  readonly webgpu: boolean;
  readonly wasm: boolean;
  readonly online: boolean;
  /** `navigator.deviceMemory` rounded as the browser reports it, when present. */
  readonly deviceMemoryGb?: number;
}

/** What the device looks like now, for the walker's device-policy checks. Every field is a hint. */
export interface DeviceState {
  readonly shell: Shell;
  readonly online: boolean;
  /** On a metered connection (cellular or data saver). Unknown means not metered. */
  readonly metered?: boolean;
  /** 0 to 100. Unknown means no battery rule applies. */
  readonly batteryPct?: number;
  readonly charging?: boolean;
  /** Megabytes of local models already stored on this device for this host. */
  readonly downloadedMb?: number;
}

/** The tenant's device rules, as the host reads them from its policy. */
export interface DevicePolicy {
  /** Megabytes of local models a device may hold in all. 0 forbids downloads. */
  readonly downloadBudgetMb: number;
  /** Downloads only on an unmetered connection. */
  readonly requireUnmetered: boolean;
  /** No local step below this battery level unless charging. 0 turns the rule off. */
  readonly minBatteryPct: number;
  /** Local steps that can run offline may do so. */
  readonly allowOffline: boolean;
}

/** The safest policy: no downloads, unmetered only, 20% battery floor, nothing offline. */
export const DEFAULT_DEVICE_POLICY: DevicePolicy = Object.freeze({
  downloadBudgetMb: 0,
  requireUnmetered: true,
  minBatteryPct: 20,
  allowOffline: false,
});

type Bag = Record<string, unknown>;

function bag(v: unknown): Bag | undefined {
  return (typeof v === 'object' || typeof v === 'function') && v !== null ? (v as Bag) : undefined;
}

function present(v: unknown): boolean {
  return (typeof v === 'object' || typeof v === 'function') && v !== null;
}

/** Look up Chrome's built-in AI globals. Presence only. */
export function detectChromeBuiltin(globals: object = globalThis): ChromeBuiltinFeatures {
  const g = globals as Bag;
  return {
    summarizer: present(g['Summarizer']),
    languageDetector: present(g['LanguageDetector']),
    translator: present(g['Translator']),
    languageModel: present(g['LanguageModel']),
  };
}

/** Summarise what this device could run. Synchronous, presence only, never triggers a model. */
export function probeCapabilities(
  opts: { readonly globals?: object; readonly shell?: Shell } = {},
): CapabilitySummary {
  const g = (opts.globals ?? globalThis) as Bag;
  const nav = bag(g['navigator']);
  const chromeBuiltin = detectChromeBuiltin(g);
  const wasm = present(g['WebAssembly']);
  const webgpu = present(nav?.['gpu']);
  const engineClasses: EngineClass[] = [];
  if (Object.values(chromeBuiltin).some(Boolean)) engineClasses.push('chrome-builtin');
  if (wasm) engineClasses.push('browser-wasm');
  if (webgpu) engineClasses.push('browser-webgpu');
  const summary: { -readonly [K in keyof CapabilitySummary]: CapabilitySummary[K] } = {
    shell: opts.shell ?? 'web',
    engineClasses,
    chromeBuiltin,
    webgpu,
    wasm,
    online: nav?.['onLine'] !== false,
  };
  const memory = nav?.['deviceMemory'];
  if (typeof memory === 'number' && Number.isFinite(memory)) summary.deviceMemoryGb = memory;
  return summary;
}

/** Read the device state from the browser (battery and connection are best-effort hints). */
export async function readDeviceState(
  opts: { readonly globals?: object; readonly shell?: Shell; readonly downloadedMb?: number } = {},
): Promise<DeviceState> {
  const g = (opts.globals ?? globalThis) as Bag;
  const nav = bag(g['navigator']);
  const state: { -readonly [K in keyof DeviceState]: DeviceState[K] } = {
    shell: opts.shell ?? 'web',
    online: nav?.['onLine'] !== false,
  };
  const connection = bag(nav?.['connection']);
  if (connection) {
    state.metered = connection['saveData'] === true || connection['type'] === 'cellular';
  }
  const getBattery = nav?.['getBattery'];
  if (typeof getBattery === 'function') {
    try {
      const battery = bag(await (getBattery as () => Promise<unknown>).call(nav));
      const level = battery?.['level'];
      if (typeof level === 'number' && Number.isFinite(level))
        state.batteryPct = Math.round(level * 100);
      if (typeof battery?.['charging'] === 'boolean') state.charging = battery['charging'];
    } catch {
      // A browser may refuse the battery API; the battery rule then does not apply.
    }
  }
  if (typeof opts.downloadedMb === 'number') state.downloadedMb = opts.downloadedMb;
  return state;
}

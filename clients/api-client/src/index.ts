/**
 * @geneweave/api-client — typed client for the geneWeave /api/me surface.
 *
 * Wraps @weaveintel/client's run client with bearer-token + CSRF injection
 * from a pluggable TokenStore, and exposes zod-validated typed methods for the
 * verified mobile surface (runs, catalog, tasks, reminders, memories, devices,
 * notification prefs/actions, conversations). The full client is built in M2.
 *
 * M0 ships only the scaffold: it builds via `tsc -b`, proves the dependency
 * wiring to @weaveintel/client and zod resolves, and has a green test — so the
 * client pipeline is verified end-to-end before M2 fills it in. No React or
 * React Native imports ever (this package stays runtime-agnostic).
 */

import { z } from 'zod';
import { sseTransport } from '@weaveintel/client';

/** Schema version of the client surface; M2 consumers pin against this. */
export const API_CLIENT_SCHEMA_VERSION = 1 as const;

/**
 * Pluggable, async token storage. The mobile app backs this with
 * `expo-secure-store`; tests and Node clients can back it with memory. The
 * real client (M2) reads the bearer token + CSRF token through this and
 * triggers a single refresh on 401.
 */
export interface TokenStore {
  get(): Promise<{ token: string; csrfToken: string } | null>;
  set(value: { token: string; csrfToken: string }): Promise<void>;
  clear(): Promise<void>;
}

/** Connection config for the client (M2 expands this). */
export const HostConfigSchema = z.object({
  /** Base origin of the geneWeave server, e.g. `https://api.example.com`. */
  host: z.string().url(),
});
export type HostConfig = z.infer<typeof HostConfigSchema>;

/**
 * M0 wiring smoke check: confirms the @weaveintel/client transport factory is
 * importable from this package. Replaced by `createGeneweaveClient` in M2.
 *
 * @internal
 */
export const __sseTransportRef: typeof sseTransport = sseTransport;

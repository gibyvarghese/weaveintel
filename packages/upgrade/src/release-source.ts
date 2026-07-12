// SPDX-License-Identifier: MIT
/**
 * Where a client discovers a release manifest.
 *
 * The manifest format is source-agnostic, so the SAME client (UpdateChecker) works over any `ReleaseSource`.
 * Two are shipped: a public GitHub Releases source and an authenticated one for a private repo. The HTTP
 * getter is INJECTED — the consuming app wires it to `@weaveintel/resilience` (rate-limit + circuit-breaker
 * + retry) — so this package pulls in no HTTP dependency, calls no raw `fetch`, and is trivially testable
 * against a mock getter.
 *
 * Token hygiene is a hard rule here: the authenticated source's token is read from an injected provider,
 * placed only in the `Authorization` header, and NEVER logged or included in a thrown error — errors carry
 * the URL and status, never the headers.
 */
import { parseManifest, type UpgradeManifest } from './manifest.js';

/** A minimal HTTP GET result — only what a manifest fetch needs. */
export interface HttpResponse {
  readonly status: number;
  readonly text: string;
}
/**
 * An injected HTTP GET. The app wires this to its resilient/hardened fetch; tests wire a stub. Must resolve
 * (not reject) for ordinary HTTP errors so status handling stays in one place; may reject on transport failure.
 * @param url the absolute URL to GET.
 * @param headers request headers (may include a secret `Authorization` — implementations MUST NOT log it).
 */
export type HttpGetter = (url: string, headers?: Readonly<Record<string, string>>) => Promise<HttpResponse>;

/** Discovers the latest release manifest. */
export interface ReleaseSource {
  /**
   * Fetch + schema-validate the latest release's manifest.
   * @returns the parsed manifest, or null when the source has no release / no manifest asset. Signature,
   *   freshness, and edition are NOT checked here — that's the UpdateChecker's job. Throws on a malformed
   *   manifest (schema violation) or an unexpected HTTP error.
   */
  latest(): Promise<UpgradeManifest | null>;
}

/** Options shared by the GitHub sources. */
export interface GitHubReleaseSourceOptions {
  /** `owner/repo`. */
  readonly repo: string;
  /** The manifest asset's file name on the release. Defaults to `manifest.json`. */
  readonly assetName?: string;
  /** The injected HTTP getter (app: resilience-wrapped; tests: a stub). */
  readonly http: HttpGetter;
  /** GitHub API base (override for GitHub Enterprise). Defaults to the public API. */
  readonly apiBase?: string;
  /**
   * Optional bearer-token provider for a PRIVATE repo. When present, requests carry `Authorization: Bearer
   * <token>` and the asset is downloaded via the authenticated API path. The token is fetched per call and
   * never retained, logged, or surfaced in errors.
   */
  readonly tokenProvider?: () => Promise<string>;
}

const GITHUB_API = 'https://api.github.com';

/** A GitHub release asset (only the fields we use). */
interface GhAsset { name: string; url: string; browser_download_url: string }

/** Build the request headers, adding the (secret) Authorization only when a token provider is configured. */
async function headersFor(opts: GitHubReleaseSourceOptions, accept: string): Promise<Record<string, string>> {
  const h: Record<string, string> = { Accept: accept, 'User-Agent': 'weaveintel-upgrade' };
  if (opts.tokenProvider) h['Authorization'] = `Bearer ${await opts.tokenProvider()}`;
  return h;
}

/** GET, resolving text on 2xx, null on 404, and throwing a header-free error otherwise. */
async function getOrThrow(http: HttpGetter, url: string, headers: Record<string, string>): Promise<string | null> {
  const res = await http(url, headers);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    // Deliberately no headers in the message — the Authorization token must never leak into logs/errors.
    throw new Error(`release source HTTP ${res.status} for ${url}`);
  }
  return res.text;
}

/**
 * A `ReleaseSource` over GitHub Releases. Public by default; supply `tokenProvider` for a private repo (the
 * `AuthenticatedGitHubReleaseSource` helper does exactly that).
 *
 * @param opts repo, asset name, injected HTTP, optional API base + token provider.
 * @returns a ReleaseSource whose `latest()` fetches `releases/latest`, finds the manifest asset, downloads
 *   it, and schema-validates it.
 */
export function createGitHubReleaseSource(opts: GitHubReleaseSourceOptions): ReleaseSource {
  const apiBase = (opts.apiBase ?? GITHUB_API).replace(/\/$/, '');
  const assetName = opts.assetName ?? 'manifest.json';
  return {
    async latest(): Promise<UpgradeManifest | null> {
      const relText = await getOrThrow(http(opts), `${apiBase}/repos/${opts.repo}/releases/latest`, await headersFor(opts, 'application/vnd.github+json'));
      if (relText === null) return null; // no releases yet
      let release: { assets?: GhAsset[] };
      try { release = JSON.parse(relText) as { assets?: GhAsset[] }; } catch { throw new Error('release source returned invalid JSON for latest release'); }
      const asset = (release.assets ?? []).find((a) => a.name === assetName);
      if (!asset) return null; // release has no manifest asset
      // Public assets download from browser_download_url (no auth); private assets from the API `url` with
      // Accept: application/octet-stream + Authorization.
      const authed = !!opts.tokenProvider;
      const dlUrl = authed ? asset.url : asset.browser_download_url;
      const manifestText = await getOrThrow(http(opts), dlUrl, await headersFor(opts, authed ? 'application/octet-stream' : 'application/octet-stream'));
      if (manifestText === null) return null;
      let json: unknown;
      try { json = JSON.parse(manifestText); } catch { throw new Error('release source returned invalid JSON for the manifest asset'); }
      return parseManifest(json); // schema validation at the boundary
    },
  };
}

/** Extract the injected http (kept as a tiny helper so `latest()` reads cleanly). */
function http(opts: GitHubReleaseSourceOptions): HttpGetter { return opts.http; }

/**
 * A `ReleaseSource` over a PRIVATE GitHub repo. Identical to {@link createGitHubReleaseSource} but requires
 * a `tokenProvider` (the app supplies one backed by its encrypted credential vault — never an env-var
 * plaintext). The token is used only in the Authorization header and never logged or surfaced in errors.
 *
 * @param opts the GitHub source options WITH a required `tokenProvider`.
 * @returns an authenticated ReleaseSource.
 */
export function createAuthenticatedGitHubReleaseSource(
  opts: GitHubReleaseSourceOptions & { tokenProvider: () => Promise<string> },
): ReleaseSource {
  return createGitHubReleaseSource(opts);
}

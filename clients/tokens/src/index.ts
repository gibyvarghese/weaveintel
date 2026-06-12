/**
 * @geneweave/tokens — geneWeave mobile brand design tokens.
 *
 * Framework-agnostic, zero runtime dependencies (no React import). The full
 * brand system — dark/light palettes with verified WCAG-AA contrast,
 * typography scale (Fraunces / Plus Jakarta Sans / DM Mono), 4-pt spacing,
 * radii, elevation, motion, and the weave-shimmer spec — is filled in by M1.
 *
 * M0 ships only the scaffold: the package builds via `tsc -b`, exports a
 * stable schema-version marker, and has a green test so the design-token
 * pipeline is wired end-to-end before M1 populates it.
 */

/**
 * Schema version for the exported token shape. Bumped when the token contract
 * changes in a way consumers must react to. Consumers (api-client, mobile)
 * pin against this so a token reshape surfaces as a typed, reviewable change.
 */
export const TOKENS_SCHEMA_VERSION = 1 as const;

/** Base spacing unit (points). The 4-pt grid M1 builds the spacing scale on. */
export const SPACING_BASE_UNIT = 4 as const;

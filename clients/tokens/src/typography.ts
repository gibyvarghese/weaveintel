/**
 * typography.ts — the type system.
 *
 * Font families are expressed as names only (no font files, no React Native
 * `expo-font` loading here — the mobile app loads them in M3). The type scale
 * is a set of named, role-based text styles with size / line-height / weight,
 * each referencing one of the three families.
 */

/** Font role -> family name. An app supplies its own brand fonts with this shape. */
export interface FontFamilies {
  /** Display / headings. */
  display: string;
  /** Body / UI text. */
  body: string;
  /** Metadata / code / keys / IDs. */
  mono: string;
  /** Handwriting (e.g. a Notes "Creative" mode: titles, diagram labels, doodles). */
  hand: string;
}

/**
 * NEUTRAL default families — platform system-font stacks, so the engine renders sensibly with no
 * brand fonts installed. Apps override with their own faces (see a consuming app's brand fonts).
 */
export const fontFamilies: FontFamilies = {
  display: 'system-ui',
  body: 'system-ui',
  mono: 'ui-monospace',
  hand: 'cursive',
};

/** Named font weights mapped to numeric values. */
export interface FontWeights {
  regular: 400;
  medium: 500;
  semibold: 600;
  bold: 700;
}

export const fontWeights: FontWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
};

/** A single resolved text style. */
export interface TextStyleToken {
  family: keyof FontFamilies;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
}

/** Role-based text styles consumed by mobile renderers. */
export interface TypeScale {
  displayLarge: TextStyleToken;
  displayMedium: TextStyleToken;
  title: TextStyleToken;
  headline: TextStyleToken;
  body: TextStyleToken;
  bodySmall: TextStyleToken;
  label: TextStyleToken;
  caption: TextStyleToken;
  mono: TextStyleToken;
}

export const typeScale: TypeScale = {
  displayLarge: { family: 'display', fontSize: 34, lineHeight: 40, fontWeight: fontWeights.bold },
  displayMedium: { family: 'display', fontSize: 28, lineHeight: 34, fontWeight: fontWeights.bold },
  title: { family: 'display', fontSize: 22, lineHeight: 28, fontWeight: fontWeights.semibold },
  headline: { family: 'body', fontSize: 18, lineHeight: 24, fontWeight: fontWeights.semibold },
  body: { family: 'body', fontSize: 16, lineHeight: 24, fontWeight: fontWeights.regular },
  bodySmall: { family: 'body', fontSize: 14, lineHeight: 20, fontWeight: fontWeights.regular },
  label: { family: 'body', fontSize: 13, lineHeight: 16, fontWeight: fontWeights.medium },
  caption: { family: 'body', fontSize: 12, lineHeight: 16, fontWeight: fontWeights.regular },
  mono: { family: 'mono', fontSize: 13, lineHeight: 20, fontWeight: fontWeights.regular },
};

/** Aggregate typography tokens. */
export interface TypographyTokens {
  families: FontFamilies;
  weights: FontWeights;
  scale: TypeScale;
}

export const typography: TypographyTokens = {
  families: fontFamilies,
  weights: fontWeights,
  scale: typeScale,
};

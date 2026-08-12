/**
 * Design tokens for the Club70 mobile app, re-synced to the finished member
 * web client (member-web/src/theme/tokens.ts, itself derived from the Figma
 * member app variables): dark-green surfaces, a lime accent, Manrope for
 * display type and Inter for body. The two clients read as one product.
 *
 * Style with these tokens only; never hard-code a color, radius, or family.
 * The `colors` object keeps the historical alias keys (background, sand, ...)
 * pointed at the web palette so the existing RN components keep compiling.
 */

/** The raw web-derived palette (member-web colors, ported 1:1). */
const palette = {
  bg: '#1e2a20',
  bgDeep: '#16211a',
  bgElevated: '#2b3a2c',
  surfaceOverlay: '#3d5641',
  surfaceMuted: '#80b691',
  border: '#3d5641',
  borderActive: '#80b691',
  white: '#ffffff',
  textMuted: '#aeb79e',
  textSubtle: '#628768',
  textOnAccent: '#1e2a20',
  textDark: '#202020',
  accent: '#ecfeaa',
  accentHover: '#bece85',
  accentSoft: '#f4ffce',
  success: '#bece85',
  danger: '#dca183',
  dangerStrong: '#e8b49a',
} as const;

export const colors = {
  // ── Surfaces ──
  bg: palette.bg,
  background: palette.bg, // alias (existing screens)
  backgroundDeep: palette.bgDeep, // alias: dark text on the lime accent
  bgElevated: palette.bgElevated,
  backgroundElevated: palette.bgElevated, // alias
  backgroundMuted: '#233127', // image/skeleton fallbacks
  surface: palette.bgElevated, // alias
  surfaceCard: palette.bgElevated,
  surfaceAlt: palette.surfaceOverlay, // alias
  surfaceOverlay: palette.surfaceOverlay,
  surfaceMuted: palette.surfaceMuted,
  overlay: 'rgba(12, 18, 13, 0.66)', // modal scrim

  // ── Borders ──
  border: palette.border,
  borderActive: palette.borderActive,

  // ── Text ──
  text: palette.white,
  textMuted: palette.textMuted,
  textSubtle: palette.textSubtle,
  textLink: palette.borderActive,
  textOnAccent: palette.textOnAccent,
  textDark: palette.textDark,

  // ── Accent ──
  accent: palette.accent,
  accentStrong: palette.accentSoft, // alias
  accentMuted: palette.accentHover, // alias
  accentHover: palette.accentHover,

  // ── Warm tones (folded into the green system for one-product parity) ──
  sand: palette.surfaceMuted, // alias
  sandMuted: palette.textSubtle, // alias

  // ── Status ──
  success: palette.success,
  danger: palette.danger,
  dangerStrong: palette.dangerStrong,
} as const;

/**
 * Font family tokens. Each weight is a distinct static family from the
 * @expo-google-fonts packages, so set `fontFamily` explicitly instead of
 * relying on `fontWeight` (custom fonts do not synthesize weight in RN).
 */
export const fonts = {
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemibold: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
  display: 'Manrope_600SemiBold',
  displaySemibold: 'Manrope_600SemiBold',
  displayBold: 'Manrope_700Bold',
  displayHeavy: 'Manrope_800ExtraBold',
} as const;

/** The map passed to expo-font's useFonts at the app root. */
export const fontAssets = {
  Inter_400Regular: require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
  Inter_500Medium: require('@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
  Inter_600SemiBold: require('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
  Inter_700Bold: require('@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf'),
  Manrope_600SemiBold: require('@expo-google-fonts/manrope/600SemiBold/Manrope_600SemiBold.ttf'),
  Manrope_700Bold: require('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf'),
  Manrope_800ExtraBold: require('@expo-google-fonts/manrope/800ExtraBold/Manrope_800ExtraBold.ttf'),
} as const;

export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

/** Corner radii, re-synced to the web scale (sm 8 / md 12 / lg 16 / xl 24). */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const shadows = {
  soft: {
    shadowColor: '#000000',
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  sheet: {
    shadowColor: '#000000',
    shadowOpacity: 0.34,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -8 },
    elevation: 16,
  },
} as const;

/**
 * Shared text presets (family + size + line height) so headings and body
 * copy stay consistent. Compose with a color from `colors` at the call site.
 */
export const typography = {
  display: { fontFamily: fonts.displayHeavy, fontSize: 30, lineHeight: 36 },
  h1: { fontFamily: fonts.displayBold, fontSize: 26, lineHeight: 32 },
  h2: { fontFamily: fonts.displayBold, fontSize: 20, lineHeight: 26 },
  h3: { fontFamily: fonts.displaySemibold, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  bodyStrong: { fontFamily: fonts.bodySemibold, fontSize: 15, lineHeight: 21 },
  label: { fontFamily: fonts.bodySemibold, fontSize: 12, lineHeight: 16, letterSpacing: 0.8 },
  caption: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16 },
} as const;

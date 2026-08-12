/**
 * Typed mirror of src/theme/tokens.css for the rare places that need token
 * values in JS (Stripe Elements appearance, canvas drawing, inline SVG).
 * CSS should always use the custom properties, never these constants.
 *
 * Derived from the Figma member app variables; see tokens.css for the
 * variable-by-variable mapping.
 */

export const colors = {
  bg: '#1e2a20',
  bgElevated: '#2b3a2c',
  surfaceCard: '#2b3a2c',
  surfaceOverlay: '#3d5641',
  surfaceMuted: '#80b691',
  border: '#3d5641',
  borderActive: '#80b691',
  text: '#ffffff',
  textMuted: '#aeb79e',
  textSubtle: '#628768',
  textLink: '#80b691',
  textOnAccent: '#1e2a20',
  textDark: '#202020',
  accent: '#ecfeaa',
  accentHover: '#bece85',
  success: '#bece85',
  danger: '#dca183',
  dangerStrong: '#e8b49a',
} as const;

export const fonts = {
  display: "'Manrope Variable', 'Manrope', system-ui, sans-serif",
  body: "'Inter Variable', 'Inter', system-ui, sans-serif",
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/**
 * Responsive breakpoints (px, min-width). Media queries must use these
 * values literally; keep in sync with the comment block in tokens.css.
 * - sm: large phones
 * - md: the shell switches from bottom tab bar to sidebar
 * - lg: multi-column page layouts
 */
export const breakpoints = {
  sm: 480,
  md: 768,
  lg: 1024,
} as const;

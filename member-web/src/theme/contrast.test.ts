/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WCAG contrast guards for token pairings that reviews have caught failing.
 * CSS never executes in jsdom (and vitest maps *.module.css to the class
 * proxy, so ?raw cannot read it), so these read the stylesheet source from
 * disk (cwd is member-web/), resolve the token a rule actually uses, and
 * compute the real ratio; regressing to a failing token breaks the test,
 * not just the review.
 */

const tokensCss = readFileSync(resolve('src/theme/tokens.css'), 'utf8');
const choosePlanCss = readFileSync(
  resolve('src/pages/onboarding/ChoosePlanPage.module.css'),
  'utf8',
);

function token(name: string): string {
  const match = tokensCss.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Token ${name} not found in tokens.css`);
  return match[1];
}

/** WCAG 2.x relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

/** The color token a CSS-module rule sets, e.g. colorToken(css, '.signOut'). */
function colorToken(css: string, selector: string): string {
  const escaped = selector.replace(/[.:\\]/g, (char) => `\\${char}`);
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  const name = block?.match(/(?:^|[^-])color:\s*var\((--[\w-]+)\)/)?.[1];
  if (!name) throw new Error(`No color token found for ${selector}`);
  return name;
}

describe('ChoosePlanPage sign out control (14px normal text on bg/default)', () => {
  it('meets WCAG AA (4.5:1) at rest', () => {
    const used = colorToken(choosePlanCss, '.signOut');
    expect(contrast(token(used), token('--color-bg'))).toBeGreaterThanOrEqual(4.5);
  });

  it('meets WCAG AA (4.5:1) on hover', () => {
    const used = colorToken(choosePlanCss, '.signOut:hover');
    expect(contrast(token(used), token('--color-bg'))).toBeGreaterThanOrEqual(4.5);
  });
});

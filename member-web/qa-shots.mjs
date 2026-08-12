import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QA_BASE ?? 'http://localhost:3942';
const EMAIL = 'alice@example.com';
const PASSWORD = 'Club70demo!';
const OUT = '/tmp/qa';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'tablet', width: 834, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
];

// [route, label, waitFor?]
const ROUTES = [
  ['/', 'home'],
  ['/reserve', 'reserve'],
  ['/clubs', 'clubs'],
  ['/account', 'account'],
  ['/account/billing', 'billing'],
  ['/account/preferences', 'preferences'],
];

const browser = await chromium.launch();

// Log in once to capture the session cookie.
const login = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const lp = await login.newPage();
await lp.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
await lp.screenshot({ path: `${OUT}/desktop-signin.png`, fullPage: true });
await lp.locator('input[type="email"]').first().fill(EMAIL);
await lp.locator('input[type="password"]').first().fill(PASSWORD);
await lp.locator('button[type="submit"]').first().click();
await lp.waitForURL((u) => new URL(u).pathname === '/' || new URL(u).pathname.startsWith('/onboarding'), { timeout: 15000 }).catch(() => {});
await lp.waitForTimeout(1500);
const state = await login.storageState();
await login.close();

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, storageState: state });
  const page = await ctx.newPage();
  for (const [route, label] of ROUTES) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${OUT}/${vp.name}-${label}.png`, fullPage: true });
      process.stdout.write(`${vp.name}/${label} `);
    } catch (e) {
      process.stdout.write(`[FAIL ${vp.name}/${label}: ${e.message}] `);
    }
  }
  await ctx.close();
}
console.log('\ndone');
await browser.close();

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = 'http://localhost:3942';
const OUT = '/tmp/qa';
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [
  { name: 'w1920', width: 1920, height: 1080 },
  { name: 'w2560', width: 2560, height: 1330 },
];
const ROUTES = [['/', 'home'], ['/reserve', 'reserve'], ['/account', 'account'], ['/clubs', 'clubs']];
const browser = await chromium.launch();
const login = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const lp = await login.newPage();
await lp.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
await lp.locator('input[type="email"]').first().fill('alice@example.com');
await lp.locator('input[type="password"]').first().fill('Club70demo!');
await lp.locator('button[type="submit"]').first().click();
await lp.waitForURL((u) => new URL(u).pathname === '/', { timeout: 15000 }).catch(() => {});
await lp.waitForTimeout(1200);
const state = await login.storageState();
await login.close();
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, storageState: state });
  const page = await ctx.newPage();
  for (const [route, label] of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(800);
    // viewport-only screenshot (not fullPage) to see the actual framing incl. dead space
    await page.screenshot({ path: `${OUT}/${vp.name}-${label}.png` });
    process.stdout.write(`${vp.name}/${label} `);
  }
  await ctx.close();
}
console.log('\ndone');
await browser.close();

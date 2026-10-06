// Снимок страницы: node tests/shot.mjs <page-id> <out.png> [width] [height] [demo|nodemo] [js-to-eval]
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [page_ = 'dashboard', out = 'shot.png', w = '1440', h = '900', demo = 'demo', script = ''] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.addInitScript((p) => { try { localStorage.setItem('vikhr30.page', JSON.stringify(p)); } catch {} }, page_);
await page.goto('file://' + path.resolve(process.env.HTML || 'dist/Vikhr30-EFI.html'));
if (demo === 'demo') { await page.getByRole('button', { name: 'Демо', exact: true }).click(); await page.waitForTimeout(1500); }
if (script) { const r = await page.evaluate(script); if (r !== undefined) console.log('eval:', JSON.stringify(r)); }
await page.waitForTimeout(script ? 2500 : 800);
await page.screenshot({ path: out });
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();

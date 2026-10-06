// node svg2png.mjs in.svg out.png [width] [clipX clipY clipW clipH (в пикселях SVG)]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [inp, out, scale = '1', cx, cy, cw, ch] = process.argv.slice(2);
const svg = fs.readFileSync(inp, 'utf8');
const m = svg.match(/width="([\d.]+)" height="([\d.]+)"/);
const w = Math.ceil(+m[1]), h = Math.ceil(+m[2]);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: +scale })).newPage();
await page.setContent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`);
await page.screenshot({ path: out, clip: cx !== undefined ? { x: +cx, y: +cy, width: +cw, height: +ch } : { x: 0, y: 0, width: w, height: h } });
await browser.close();

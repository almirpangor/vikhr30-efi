// Обход всех страниц: снимки и сбор ошибок консоли. [HTML=dist/файл.html] node tests/all.mjs <outDir> [width] [height]
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [out = '.', w = '1440', h = '900'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: +w, height: +h } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.goto('file://' + path.resolve(process.env.HTML || 'dist/Vikhr30-EFI.html'));
const nav = async (title) => { await page.locator('.nav button[title="' + title + '"]').click(); await page.waitForTimeout(1200); };
const pages = [['Приборы', 'dashboard'], ['Двигатель 3D', 'engine'], ['Диагностика', 'diag'], ['Карта топлива', 'fuel'], ['Карта зажигания', 'ign'], ['Параметры', 'params'], ['Схема', 'scheme2d'], ['3D-схема', 'scheme'], ['Тест устройств', 'tests'], ['Комплектующие', 'bom'], ['Настройка по шагам', 'guide'], ['Журнал', 'log']];
for (const [t, id] of pages) { await nav(t); await page.screenshot({ path: `${out}/all-${w}-off-${id}.png` }); }
await page.getByRole('button', { name: 'Демо', exact: true }).click();
await page.waitForTimeout(1500);
await page.locator('.demo-panel button').first().click();
await page.locator('.demo-panel input').fill('45');
await page.waitForTimeout(3000);
for (const [t, id] of pages) {
  await nav(t);
  if (id === 'scheme') { await page.locator('text=COIL1−').first().click().catch(() => {}); await page.waitForTimeout(1500); }
  await page.screenshot({ path: `${out}/all-${w}-run-${id}.png` });
}
console.log(errors.length ? 'CONSOLE ERRORS:\n' + [...new Set(errors)].join('\n') : 'no console errors');
await browser.close();

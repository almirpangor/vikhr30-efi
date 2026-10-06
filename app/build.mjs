// Сборка: один самодостаточный HTML-файл без внешних зависимостей.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const esbuild = require('esbuild');
const dev = process.argv.includes('--dev');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outFile = outArg ? outArg.slice(6) : 'dist/Vikhr30-EFI.html';
const res = await esbuild.build({
  entryPoints: ['src/main.tsx'], bundle: true, write: false, outdir: 'out', format: 'iife', target: 'es2022',
  minify: !dev, sourcemap: dev ? 'inline' : false, jsx: 'automatic', loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  nodePaths: ['/opt/npm-tools/node_modules'], logLevel: 'warning', legalComments: 'none',
});
let js = '', css = '';
for (const f of res.outputFiles) { if (f.path.endsWith('.js')) js = f.text; else if (f.path.endsWith('.css')) css = f.text; }
const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вихрь-30 EFI — настройка</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js.replace(/<\/script/g, '<\\/script')}</script>
</body>
</html>
`;
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(outFile, html);
console.log(outFile, (html.length / 1024).toFixed(0) + ' КБ');

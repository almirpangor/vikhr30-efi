# Вихрь-30 EFI 2.0 — правила для исполнителей

Проект: новая программа настройки блока впрыска лодочного мотора «Вихрь-30» (2-тактный, 2 цилиндра в ряд,
водяное охлаждение, маховик с венцом 36-1, одна форсунка в дроссельном узле, две катушки, шаговый РХХ).
Пользователь — русскоязычный самодельщик. ВЕСЬ текст интерфейса — на русском, без англицизмов там, где есть русское слово.
Старая программа (для справки по текстам и функциям): `/tmp/claude-0/-home-claude/52f09a10-6dfb-5424-aedf-6ee0be8dd7d6/scratchpad/src/`
(`windows/src/VikhrTuner.cpp`, `SCHEMATICS_RU.md`, `README_RU.md`, `firmware/src/main.c`).

## Среда (важно)
- Сети нет: npm/CDN недоступны. Никаких новых зависимостей. Есть только React 19 (без @types — см. `src/react-shim.d.ts`),
  esbuild и TypeScript. 3D — только собственный движок `src/gl/*` (three.js НЕТ).
- Сборка в свой файл (чтобы не мешать другим):  `node build.mjs --out=dist/<твоё-имя>.html`
- Проверка типов: `tsc -p .` — исправляй ошибки в СВОИХ файлах; чужие файлы могут быть временно сломаны — игнорируй.
- Снимок экрана (обязательно смотреть глазами через Read на PNG):
  `HTML=dist/<твоё-имя>.html node tests/shot.mjs <page-id> <out.png> [ширина=1440] [высота=900] [demo|nodemo] ["js для page.evaluate"]`
  page-id: dashboard, engine, diag, fuel, ign, params, scheme, tests, bom, guide, log.
  В режиме demo подключается эмулятор ECU. Управлять им из js: кнопки в шапке «Завести», ползунок «Газ» —
  например `"document.querySelectorAll('.demo-panel button')[0].click()"` (завести), ползунок:
  `"(()=>{const r=document.querySelector('.demo-panel input');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(r,'60');r.dispatchEvent(new Event('input',{bubbles:true}));})()"`.
  Скрипт печатает ошибки консоли — их должно быть ноль. PNG сохраняй в `/tmp/claude-0/-home-claude/52f09a10-6dfb-5424-aedf-6ee0be8dd7d6/scratchpad/`.
- Проверяй при 1440×900 и 1100×700. Ничего не должно обрезаться и наезжать.

## Что нельзя трогать
`src/core/*`, `src/gl/*`, `src/App.tsx`, `src/styles.css`, `src/ui/kit.tsx`, `build.mjs`, `tests/*` — общие. НЕ редактировать.
Если в общем коде не хватает чего-то или найдена ошибка — НЕ чини сам, а опиши в итоговом отчёте (файл, что нужно).
Свои стили — в отдельном css-файле рядом со страницей (`src/pages/<Имя>.css`, `import './<Имя>.css'`), классы с префиксом страницы.
Пиши только в файлы, перечисленные в твоём задании.

## Общий код, которым пользоваться
- `src/core/store.ts`: `useApp(sel)` — подписка на состояние (`telemetry`, `live`, `status`, `fuel`, `ign`, `ecuFuel`, `ecuIgn`,
  `params`, `ecuParams`, `log`, `busy`, `testMessage`, `selectedNet`, `unsaved`, `mapsLoaded`…); `getState()` — без подписки
  (в кадре 3D-анимации читать `getState().telemetry` и `getState().live`, НЕ через React);
  действия: `readAll, writeMaps, writeParams, saveFlash, loadDefaults, homeIac, clearFaults, runTest, stopTests, editMaps, undo, redo,
  canUndo, canRedo, revertMaps, setParam, revertParams, validateParams, canMutate, selectNet, setPage, toggleRecording, downloadText,
  historySeries, historyMeta, load, save (настройки в localStorage), toast`.
- `src/core/types.ts`: `Telemetry` (единицы: tps10 — 0,1 %, map10 — 0,1 кПа, cht10/iat10 — 0,1 °C, batteryMv, advance10 — 0,1°, pwUs — мкс,
  duty10 — 0,1 %), `RPM_BINS`, `LOAD_BINS`, `PARAMS`, `FAULTS`, `ACTUATOR_TESTS`, пределы ячеек.
- `src/core/calc.ts`: `lookupMap, workPoint, fuelFlowMlMin, parseMapCsv, mapToCsv, clamp…`.
- `src/core/hardware.ts`: `BOM, BLOCKS, NETS, probeNet(id, telemetry, dwell) → Probe` (ожидаемые напряжения и осциллограммы), `bomTotal`.
- `src/ui/kit.tsx`: `PageHead, Seg, Viewport3D, confirmDialog, fmt (число с запятой), DASH`.
- `src/gl/viewer.ts`: `Viewer` (сцена `viewer.root`, камера `viewer.cam {target,yaw,pitch,dist}`, `flyTo`, `onFrame(dt,t)`, `onPick`, `onHover`,
  `project(p)` для HTML-подписей, `clip` — плоскость разреза, `invalidate(node)`), `Node3` (geom, mat, local-матрица, children, pickable,
  highlight 0..1, label, data, visible), `MAT` — готовые материалы, `Material {color, metal, rough, emissive, opacity, unlit, noClip}`.
- `src/gl/geometry.ts`: `box, cylinder, tubeY, lathe, sphere, torus, tube(path), smoothPath, extrude(выпуклый контур), roundedRect, hexPrism,
  merge, placed, transform`. `src/gl/math.ts`: `M` (trs, rotX/Y/Z, translation, mul, chain, point), `V`.
  Склеивай мелкие детали одного материала через `merge` — меньше вызовов отрисовки. Целиться в ≤ 300 узлов с геометрией на сцену.
- Стили: переменные и классы из `src/styles.css` (`.card, .btn(.primary/.danger/.sm/.on/.ghost), .seg, .chip, .tag, .banner, .tbl, .input, .num,
  .grid, .row, .page, .page.fill, .viewport3d, .label3d, .empty, .kbd`), цвета `var(--ok|--warn|--danger|--nodata|--accent|--muted…)`.

## Требования к качеству
- Нет связи (`!live`) → значения показывать как «—» серым, анимацию останавливать. Не выдумывать данные.
- Опасные действия — через `confirmDialog`. Действия записи недоступны, пока `canMutate()` возвращает причину (показывать её).
- Клавиатура: все кнопки достижимы Tab, видимый фокус. `prefers-reduced-motion` уважать в CSS-анимациях.
- Никаких `alert/prompt`. Никаких заглушек «в разработке» в готовой работе.
- Цвет — только по смыслу: зелёный норма, жёлтый предупреждение, красный авария, серый нет данных.
- Итоговый отчёт: что сделано, какие снимки проверены (пути к PNG), что НЕ удалось или вызывает сомнения, просьбы к общему коду.
  Пиши честно: «не проверено» лучше, чем «должно работать».

// Вихрь-30 EFI — оболочка настольного приложения (Electron).
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

const SELFTEST = process.argv.includes('--selftest');
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function portTitle(p) {
  const name = p.displayName || p.portName || 'порт';
  const id = p.vendorId ? ` (USB ${p.vendorId}:${p.productId})` : '';
  return p.portName && name !== p.portName ? `${p.portName} — ${name}${id}` : `${name}${id}`;
}

function setupSerial(ses) {
  // Программа сама показывает список COM-портов (в браузере это делает его встроенное окно).
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (SELFTEST) { console.log('SELFTEST serial ports: ' + portList.length); callback(''); return; }
    if (!portList.length) {
      dialog.showMessageBox(win, { type: 'warning', title: 'COM-порты', message: 'COM-порты не найдены', detail: 'Подключите USB-UART или выполните сопряжение с Bluetooth-модулем HC-06 в настройках Windows (появится «Стандартный последовательный порт по Bluetooth»), затем повторите.', buttons: ['Понятно'] }).then(() => callback(''));
      return;
    }
    const ports = portList.slice(0, 12);
    dialog.showMessageBox(win, {
      type: 'question', title: 'Подключение ECU', message: 'Выберите COM-порт блока управления',
      detail: 'Скорость 115200 бод. Для Bluetooth у HC-06 обычно два порта — нужен «исходящий».',
      buttons: [...ports.map(portTitle), 'Отмена'], cancelId: ports.length, defaultId: 0, noLink: true,
    }).then((r) => callback(r.response < ports.length ? ports[r.response].portId : ''));
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'serial' || permission === 'clipboard-sanitized-write' || permission === 'clipboard-read');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');
}

function buildMenu() {
  const tpl = [
    { label: 'Файл', submenu: [
      { label: 'Печать…', accelerator: 'Ctrl+P', click: () => win && win.webContents.print() },
      { type: 'separator' },
      { label: 'Выход', role: 'quit' },
    ] },
    { label: 'Вид', submenu: [
      { label: 'Во весь экран', role: 'togglefullscreen', accelerator: 'F11' },
      { label: 'Крупнее', role: 'zoomIn', accelerator: 'Ctrl+=' },
      { label: 'Мельче', role: 'zoomOut', accelerator: 'Ctrl+-' },
      { label: 'Обычный размер', role: 'resetZoom', accelerator: 'Ctrl+0' },
      { type: 'separator' },
      { label: 'Перезапустить окно', role: 'reload', accelerator: 'Ctrl+R' },
      { label: 'Средства отладки', role: 'toggleDevTools', accelerator: 'F12' },
    ] },
    { label: 'Справка', submenu: [
      { label: 'Папка с прошивками', click: () => shell.openPath(path.join(process.resourcesPath, 'firmware')) },
      { label: 'О программе', click: () => dialog.showMessageBox(win, { type: 'info', title: 'О программе', message: 'Вихрь-30 EFI 2.0', detail: `Настройка блока впрыска «Вихрь-30» (STM32F103).\nПрошивки: v0.8 и v0.9.\nElectron ${process.versions.electron}, Chromium ${process.versions.chrome}.`, buttons: ['Закрыть'] }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, show: false,
    backgroundColor: '#0a0f15', title: 'Вихрь-30 EFI', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  setupSerial(win.webContents.session);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'Vikhr30-EFI.html'));
  if (SELFTEST) selftest().catch((e) => { console.log('SELFTEST FAIL ' + e); app.exit(1); });
}

async function selftest() {
  const wc = win.webContents, errors = [];
  wc.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await new Promise((r) => wc.once('did-finish-load', r));
  const js = (code, gesture = false) => wc.executeJavaScript(code, gesture);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.serialApi = await js(`'serial' in navigator`);
  out.webgl2 = await js(`!!document.createElement('canvas').getContext('webgl2')`);
  out.requestPort = await js(`navigator.serial.requestPort().then(() => 'port', (e) => e.name)`, true);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Демо').click()`);
  await sleep(2500);
  await js(`document.querySelector('.demo-panel button').click()`);
  await sleep(3500);
  out.status = await js(`document.querySelector('.top-chips .chip').textContent`);
  out.rpm = await js(`Number(document.querySelector('.top-chips .chip b').textContent)`);
  for (const title of ['Двигатель 3D', 'Схема', '3D-схема', 'Карта топлива']) {
    await js(`document.querySelector('.nav button[title="${title}"]').click()`);
    await sleep(1500);
  }
  out.storage = await js(`(() => { try { localStorage.setItem('vikhr30.selftest', '1'); return localStorage.getItem('vikhr30.selftest'); } catch (e) { return String(e); } })()`);
  await js(`document.querySelector('.nav button[title="Двигатель 3D"]').click()`);
  await sleep(2500);
  const img = await wc.capturePage();
  const shot = process.env.SELFTEST_SHOT;
  if (shot) fs.writeFileSync(shot, img.toPNG());
  out.errors = errors;
  console.log('SELFTEST ' + JSON.stringify(out));
  app.exit(out.serialApi && out.webgl2 && out.rpm > 300 && !errors.length ? 0 : 1);
}

app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on('window-all-closed', () => app.quit());

'use strict';

/** 5003 受限态截图自检：确认提示条与「校准」按钮排版 */
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const api = require('./src/api');

const WIDTH = 344;
const HEIGHT = 320;

const note = api.buildLocalNote(96, 3720, 200);
const account = {
  id: 'a1', uid: '100000001', server: 'cn_gf01', nickname: '示例旅行者',
  label: '示例旅行者 · 100000001', loginMethod: 'qr',
  hasCookie: true, hasCredential: true, lastSyncAt: Date.now() - 3600_000,
  resin: 96, maxResin: 200, note, error: '米游社已限制本机读取实时便笺（5003）', errorAt: Date.now(),
};

const config = {
  source: 'mihoyo', maxResin: 200, notifyAt: 190, syncInterval: 300,
  uid: '100000001', server: 'cn_gf01', customUrl: '', alwaysOnTop: true,
  deskPin: false, theme: 'gold', autoStart: false, hasCookie: true,
  hasCredential: true, loginMethod: 'qr', accountLabel: account.label, uiScale: 1,
  activeAccountId: 'a1', accounts: [account], note,
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: WIDTH, height: HEIGHT, frame: false, resizable: false,
    backgroundColor: '#10141c',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });

  const status = {
    kind: 'error',
    text: '米游社限制本机读取（5003）· 请手动校准',
    blocked: true,
  };
  ipcMain.handle('state:get', () => ({ config, note, status }));
  ipcMain.handle('config:set', (_, patch) => Object.assign(config, patch));
  ipcMain.handle('sync:now', () => ({ ok: false, blocked: true }));
  ipcMain.handle('window:height', () => 0);
  for (const ch of ['note:calibrate', 'qr:start', 'qr:cancel', 'config:save', 'account:update',
    'account:remove', 'verify:start', 'window:action', 'window:surface', 'window:drag-start',
    'window:drag-move', 'window:drag-end', 'note:calibrate-many']) {
    ipcMain.handle(ch, () => ({ ok: true }));
  }

  await win.loadFile(path.join(__dirname, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1400));
  const image = await win.webContents.capturePage();
  const out = path.join(__dirname, 'shot-blocked.png');
  require('node:fs').writeFileSync(out, image.toPNG());
  console.log(`SHOT=${out}`);
  app.exit(0);
});

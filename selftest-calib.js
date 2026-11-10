'use strict';

/**
 * 校准 / 层级自检：
 * 1. 多账号时点卡片上的 ✎ 能打开校准浮层，且默认带出该账号当前树脂
 * 2. 保存后只改被校准的那个账号，别的账号不受影响
 * 3. 单账号时底部「手动校准」也能打开，保存后主界面数值立刻变
 * 4. 打开任何浮层都会通知主进程进入交互态（window:surface true），关闭后回落
 * 5. 钉在桌面时标题栏拖动走 window:drag-* 通道，窗口真的会移动
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const api = require('./src/api');

const WIDTH = 344;
const HEIGHT = 292;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const extra = { task: '2/4', expedition: '3/5', discount: '1/3' };

function makeAccount(id, nickname, uid, resin, extraData) {
  const note = api.buildLocalNote(resin, 137, 200);
  if (extraData) note.extra = extraData;
  return {
    id, uid, server: 'cn_gf01', nickname,
    label: `${nickname} · ${uid}`, loginMethod: 'qr',
    hasCookie: true, hasCredential: true,
    lastSyncAt: Date.now(), resin, maxResin: 200, note, error: '',
  };
}

const all = [
  makeAccount('a1', '示例旅行者', '100000001', 148, extra),
  makeAccount('a2', '旅行者', '100000002', 62),
  makeAccount('a3', '小号', '100000003', 191),
];

const config = {
  source: 'mihoyo', maxResin: 200, notifyAt: 190, syncInterval: 300,
  uid: '100000001', server: 'cn_gf01', customUrl: '', alwaysOnTop: false,
  deskPin: false, theme: 'gold', autoStart: false,
  hasCookie: true, hasCredential: true,
  loginMethod: 'qr', accountLabel: all[0].label, uiScale: 1,
  activeAccountId: 'a1', accounts: all.map((a) => ({ ...a })),
};

const surfaces = [];
const drags = [];
let win = null;
let dragState = null;

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    x: 80,
    y: 80,
    frame: false,
    resizable: false,
    backgroundColor: '#10141c',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ipcMain.handle('state:get', () => ({
    config,
    note: config.accounts[0].note,
    status: { kind: 'ok', text: '已同步 3 个账号' },
  }));
  ipcMain.handle('config:set', (_, patch) => Object.assign(config, patch));
  ipcMain.handle('sync:now', () => ({ ok: true }));
  ipcMain.handle('account:remove', () => config);
  ipcMain.handle('account:update', () => config);
  ipcMain.handle('account:logout', () => config);
  ipcMain.handle('roles:fetch', () => ({ ok: true, roles: [] }));
  ipcMain.handle('qr:start', () => ({ ok: true }));
  ipcMain.handle('qr:cancel', () => ({ ok: true }));
  ipcMain.handle('verify:start', () => ({ ok: true }));
  ipcMain.handle('scale:set', (_, v) => ({ ok: true, uiScale: v }));

  // 与真实主进程同语义：按 accountId 写入，只影响该账号
  ipcMain.handle('note:calibrate', (_, payload = {}) => {
    const note = api.buildLocalNote(payload.resin, payload.nextInSeconds, 200);
    const acc = payload.accountId
      ? config.accounts.find((a) => a.id === payload.accountId)
      : null;
    if (acc) {
      acc.note = note;
      acc.resin = note.currentResin;
      acc.lastSyncAt = Date.now();
    } else {
      config.note = note;
    }
    return { note, config: { ...config, note: acc ? acc.note : note } };
  });

  ipcMain.on('window:surface', (_, value) => { surfaces.push(Boolean(value)); });

  ipcMain.on('window:drag-start', (_, p) => {
    const b = win.getBounds();
    dragState = { sx: p.x, sy: p.y, wx: b.x, wy: b.y, w: b.width, h: b.height };
    drags.push(`start ${p.x},${p.y}`);
  });
  ipcMain.on('window:drag-move', (_, p) => {
    if (!dragState) return;
    const x = dragState.wx + (p.x - dragState.sx);
    const y = dragState.wy + (p.y - dragState.sy);
    win.setBounds({ x, y, width: dragState.w, height: dragState.h });
    drags.push(`move ${x},${y}`);
  });
  ipcMain.on('window:drag-end', () => { dragState = null; drags.push('end'); });

  ipcMain.on('window:fit-height', (_, h) => {
    const height = Math.max(200, Math.round(Number(h) || HEIGHT));
    const b = win.getBounds();
    if (Math.abs(b.height - height) <= 1) return;
    win.setBounds({ x: b.x, y: b.y, width: WIDTH, height });
  });

  win.webContents.on('console-message', (...args) => {
    const text = args.map((a) => {
      try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); } catch (_) { return '?'; }
    }).join(' | ');
    if (/Uncaught|TypeError|ReferenceError/.test(text)) console.log('RENDERER_ERROR:', text);
  });

  await win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setZoomFactor(1);
  await wait(600);

  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, name), image.toPNG());
    return `${image.getSize().width}x${image.getSize().height}`;
  };

  const result = { ok: true, steps: {} };
  const fail = (why) => { result.ok = false; (result.fail ||= []).push(why); };

  // ---- 1. 多账号：点第二个账号的 ✎ ----
  await js(`document.querySelectorAll('.ac-card')[1].querySelector('.ac-calib').click()`);
  await wait(320);
  const opened = await js(`({
    hidden: document.getElementById('calibSheet').hidden,
    title: document.getElementById('calibTitle').textContent,
    resin: document.getElementById('inCalibResin').value,
    accounts: document.querySelectorAll('.calib-account').length,
    active: (document.querySelector('.calib-account.active') || {}).textContent || '',
  })`);
  result.steps.opened = opened;
  if (opened.hidden) fail('calib sheet did not open');
  if (!/旅行者/.test(opened.title)) fail('title did not follow the clicked account');
  if (String(opened.resin) !== '62') fail(`prefill resin=${opened.resin}, expected 62`);
  if (opened.accounts !== 3) fail(`account chips=${opened.accounts}, expected 3`);
  await shot('shot-calib-multi.png');

  // ---- 2. 保存 132：只改 a2 ----
  await js(`(() => {
    document.getElementById('inCalibResin').value = '132';
    document.getElementById('btnCalibSave').click();
  })()`);
  await wait(420);
  const afterSave = await js(`(() => {
    const cards = [...document.querySelectorAll('.ac-card')];
    return {
      hidden: document.getElementById('calibSheet').hidden,
      values: cards.map((c) => c.querySelector('.ac-resin b').textContent),
    };
  })()`);
  result.steps.afterSave = afterSave;
  const a2Resin = config.accounts.find((a) => a.id === 'a2').resin;
  if (!afterSave.hidden) fail('calib sheet stayed open after save');
  if (Number(a2Resin) !== 132) fail(`store a2 resin=${a2Resin}, expected 132`);
  if (afterSave.values[1] !== '132') fail(`card2 shows ${afterSave.values[1]}, expected 132`);
  if (afterSave.values[0] === '132') fail('calibration leaked into another account');
  await shot('shot-calib-after-save.png');

  // ---- 3. 单账号：底部「手动校准」 ----
  config.accounts = all.slice(0, 1);
  config.activeAccountId = 'a1';
  win.webContents.send('config:update', { ...config, note: all[0].note });
  await wait(420);
  await js(`document.getElementById('btnCalibrate').click()`);
  await wait(320);
  const soloOpen = await js(`({
    hidden: document.getElementById('calibSheet').hidden,
    title: document.getElementById('calibTitle').textContent,
    chips: document.querySelectorAll('.calib-chip').length,
  })`);
  result.steps.soloOpen = soloOpen;
  if (soloOpen.hidden) fail('solo calibrate did nothing');
  if (!/^校准 ·/.test(soloOpen.title)) fail(`solo title=${soloOpen.title}`);
  await js(`(() => {
    document.getElementById('inCalibResin').value = '96';
    document.getElementById('btnCalibSave').click();
  })()`);
  await wait(420);
  const soloAfter = await js(`document.getElementById('resinValue').textContent`);
  result.steps.soloAfter = soloAfter;
  if (soloAfter !== '96') fail(`solo main shows ${soloAfter}, expected 96`);
  await shot('shot-calib-solo.png');

  // ---- 4. surface 通道 ----
  result.steps.surfaces = surfaces.slice();
  if (!surfaces.includes(true)) fail('never signalled interactive surface');
  if (surfaces[surfaces.length - 1] !== false) fail('surface did not fall back to false');

  // ---- 5. 钉住后的手动拖动 ----
  config.accounts = all.map((a) => ({ ...a }));
  config.deskPin = true;
  win.webContents.send('config:update', config);
  await wait(420);
  const startBounds = win.getBounds();
  await js(`(() => {
    const handle = document.getElementById('dragHandle');
    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1,
      screenX: x, screenY: y, clientX: 10, clientY: 10,
    });
    handle.dispatchEvent(mk('pointerdown', 500, 400));
    handle.dispatchEvent(mk('pointermove', 560, 450));
    handle.dispatchEvent(mk('pointerup', 560, 450));
  })()`);
  await wait(320);
  const endBounds = win.getBounds();
  result.steps.drag = { start: startBounds, end: endBounds, events: drags.slice(0, 6) };
  if (!drags.length) fail('drag channel unused while pinned');
  if (endBounds.x === startBounds.x && endBounds.y === startBounds.y) fail('window did not move');
  await shot('shot-calib-pinned.png');

  console.log('CALIB_SELFTEST=' + JSON.stringify(result));
  win.destroy();
  app.exit(result.ok ? 0 : 1);
}).catch((error) => {
  console.error('CALIB_FAILED', error);
  app.exit(1);
});

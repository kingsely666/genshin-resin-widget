'use strict';

/**
 * 截图自检：用真实 index.html + preload 桥，模拟 1 / 2 / 3 个账号的界面，
 * 并按渲染层上报的高度真实调整窗口，最后各存一张 PNG 供人工核对排版。
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const api = require('./src/api');

const WIDTH = 344;
const HEIGHT = 292;

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
  uid: '100000001', server: 'cn_gf01', customUrl: '', alwaysOnTop: true,
  deskPin: false, theme: 'gold',
  autoStart: false, hasCookie: true, hasCredential: true,
  loginMethod: 'qr', accountLabel: all[0].label, uiScale: 1,
  activeAccountId: 'a1', accounts: all,
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    resizable: false,
    backgroundColor: '#10141c',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ipcMain.handle('state:get', () => ({ config, note: config.accounts[0].note, status: { kind: 'ok', text: '已同步 3 个账号' } }));
  ipcMain.handle('config:set', (_, patch) => Object.assign(config, patch));
  ipcMain.handle('sync:now', () => ({ ok: true }));
  ipcMain.handle('account:switch', (_, id) => {
    config.activeAccountId = id;
    const acc = config.accounts.find((a) => a.id === id);
    return { ...config, note: acc ? acc.note : null };
  });
  ipcMain.handle('account:remove', () => config);
  ipcMain.handle('account:update', () => config);
  ipcMain.handle('account:logout', () => config);
  ipcMain.handle('roles:fetch', () => ({ ok: true, roles: [] }));
  ipcMain.handle('qr:start', () => ({ ok: true }));
  ipcMain.handle('qr:cancel', () => ({ ok: true }));
  ipcMain.handle('verify:start', () => ({ ok: true }));
  ipcMain.handle('note:calibrate', (_, p) => {
    const note = api.buildLocalNote(p.resin, p.nextInSeconds, 200);
    return { note, config: { ...config, note } };
  });
  ipcMain.handle('scale:set', (_, v) => ({ ok: true, uiScale: v }));
  // 关键：渲染层实测的内容高度直接应用到窗口
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
  // 之前跑过缩放自检，Chromium 会按来源记住 zoom，这里强制回到 100%
  win.webContents.setZoomFactor(1);
  await new Promise((r) => setTimeout(r, 400));
  win.webContents.setZoomFactor(1);
  await new Promise((r) => setTimeout(r, 500));

  const diag = await win.webContents.executeJavaScript(`(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), fs: getComputedStyle(el).fontSize };
    };
    return {
      iw: window.innerWidth,
      ih: window.innerHeight,
      dpr: devicePixelRatio,
      docScale: document.documentElement.style.zoom || getComputedStyle(document.documentElement).zoom,
      iw2: innerWidth,
      body: r('#mainBody'),
      brand: r('.brand'),
      brandText: r('.brand-text'),
      status: r('.status-text'),
      actions: r('.window-actions'),
      card: r('.ac-card'),
      meta: r('.ac-meta'),
      full: r('.ac-full'),
      extra: r('.ac-extra'),
      list: r('#multiList'),
      viewH: r('#viewMain').h,
    };
  })()`);
  console.log('DIAG=' + JSON.stringify(diag));

  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, name), image.toPNG());
    const b = win.getBounds();
    const live = await win.webContents.executeJavaScript('({ iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio })');
    console.log(`${name} -> bounds ${b.width}x${b.height} content ${JSON.stringify(win.getContentSize())} css ${JSON.stringify(live)} zoom ${win.webContents.getZoomFactor()} png ${image.getSize().width}x${image.getSize().height}`);
  };

  await shot('shot-multi.png');

  // 各配色方案各来一张，方便一眼看出区别
  for (const theme of ['frost', 'jade', 'sakura', 'violet', 'graphite']) {
    config.theme = theme;
    win.webContents.send('config:update', config);
    await new Promise((r) => setTimeout(r, 320));
    await shot(`shot-theme-${theme}.png`);
  }
  config.theme = 'gold';
  win.webContents.send('config:update', config);
  await new Promise((r) => setTimeout(r, 320));

  // 两个账号
  config.accounts = all.slice(0, 2);
  win.webContents.send('config:update', config);
  await new Promise((r) => setTimeout(r, 600));
  await shot('shot-two.png');

  // 单账号
  config.accounts = all.slice(0, 1);
  config.activeAccountId = 'a1';
  win.webContents.send('config:update', { ...config, note: all[0].note });
  await new Promise((r) => setTimeout(r, 600));
  await shot('shot-solo.png');

  // 设置页：确认新增的配色选择与桌面固定开关排版正常
  config.accounts = all;
  config.source = 'mihoyo';
  win.webContents.send('config:update', config);
  await new Promise((r) => setTimeout(r, 360));
  await win.webContents.executeJavaScript(`document.getElementById('btnSettings').click()`);
  await new Promise((r) => setTimeout(r, 500));
  await shot('shot-settings.png');
  await win.webContents.executeJavaScript(`
    const body = document.querySelector('.settings-body');
    const themeRow = document.getElementById('themeRow');
    if (body && themeRow) body.scrollTop = themeRow.offsetTop - 40;
  `);
  await new Promise((r) => setTimeout(r, 400));
  await shot('shot-settings-theme.png');
  await win.webContents.executeJavaScript(`document.getElementById('btnBack').click()`);
  await new Promise((r) => setTimeout(r, 400));

  // 风控态：标题栏「风控中」+ 提示条，供人工核对排版
  win.webContents.send('status:update', {
    kind: 'error',
    text: '米游社返回 1034，需要完成人机验证',
    needVerify: true,
  });
  await new Promise((r) => setTimeout(r, 560));
  await shot('shot-risk.png');

  // 对外用的成品图（README 引用这些文件名）
  const publish = {
    '界面预览-金曜.png': 'shot-multi.png',
    '界面预览-翠玉.png': 'shot-theme-jade.png',
    '界面预览-晨霜.png': 'shot-theme-frost.png',
    '设置页预览.png': 'shot-settings.png',
    '风控状态界面.png': 'shot-risk.png',
  };
  for (const [to, from] of Object.entries(publish)) {
    fs.copyFileSync(path.join(__dirname, from), path.join(__dirname, to));
  }
  console.log('README_SHOTS=' + Object.keys(publish).join(' | '));

  app.exit(0);
}).catch((error) => {
  console.error('SHOT_FAILED', error);
  app.exit(1);
});

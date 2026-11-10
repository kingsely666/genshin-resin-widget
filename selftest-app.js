'use strict';

/** 集成自检：真实 index.html + preload 桥 + 模拟主进程 IPC（含扫码、多账号、缩放） */
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const api = require('./src/api');

const note = api.buildLocalNote(148, 137, 200);

const accounts = [
  {
    id: 'acc-main', uid: '100000001', server: 'cn_gf01', nickname: '示例旅行者',
    label: '示例旅行者 · 100000001', loginMethod: 'qr', hasCookie: true, hasCredential: true,
    lastSyncAt: Date.now(), resin: 148, maxResin: 200,
    note: api.buildLocalNote(148, 137, 200),
    extra: { task: '2/4', expedition: '3/5', discount: '1/3' },
  },
  {
    id: 'acc-alt', uid: '100000002', server: 'cn_gf01', nickname: '小号',
    label: '小号 · 100000002', loginMethod: 'qr', hasCookie: true, hasCredential: true,
    lastSyncAt: Date.now() - 7200 * 1000, resin: 30, maxResin: 200,
    note: api.buildLocalNote(30, 302, 200),
  },
];
accounts[0].note.extra = accounts[0].extra;

const config = {
  source: 'local', maxResin: 200, notifyAt: 190, syncInterval: 300,
  uid: '', server: 'cn_gf01', customUrl: '', alwaysOnTop: true,
  deskPin: false, theme: 'gold',
  autoStart: false, hasCookie: false, hasCredential: false,
  loginMethod: '', accountLabel: '', uiScale: 1,
  activeAccountId: 'acc-main', accounts,
};

const FAKE_QR = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#fff"/><rect x="10" y="10" width="40" height="40" fill="#1b202b"/><rect x="70" y="70" width="40" height="40" fill="#1b202b"/></svg>'
);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 344,
    height: 292,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ipcMain.handle('state:get', () => ({ config, note, status: { kind: 'local', text: '本地推算' } }));
  ipcMain.handle('config:set', (_, patch) => Object.assign(config, patch));
  ipcMain.handle('sync:now', () => ({ ok: true }));
  ipcMain.handle('note:calibrate', (_, p) => api.buildLocalNote(p.resin, p.nextInSeconds, 200));
  ipcMain.handle('roles:fetch', () => ({ ok: true, roles: [] }));
  ipcMain.handle('qr:start', () => {
    setTimeout(() => win.webContents.send('qr:update', {
      phase: 'created',
      text: '请用米游社 App 扫一扫',
      qrDataUrl: FAKE_QR,
      mode: 'app',
    }), 20);
    return { ok: true, mode: 'app' };
  });
  ipcMain.handle('qr:cancel', () => {
    win.webContents.send('qr:update', { phase: 'idle', text: '' });
    return { ok: true };
  });
  ipcMain.handle('account:logout', () => config);
  ipcMain.handle('verify:start', () => ({ ok: true, message: '已打开验证窗口，请完成滑块验证' }));

  ipcMain.handle('account:switch', (_, id) => {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return config;
    config.activeAccountId = id;
    config.source = 'mihoyo';
    config.hasCookie = true;
    config.accountLabel = acc.label;
    const nextNote = api.buildLocalNote(acc.resin, 137, acc.maxResin);
    setTimeout(() => win.webContents.send('note:update', nextNote), 10);
    return { ...config, note: nextNote };
  });

  ipcMain.handle('account:remove', (_, id) => {
    config.accounts = accounts.filter((a) => a.id !== id);
    if (config.activeAccountId === id) {
      config.activeAccountId = config.accounts[0] ? config.accounts[0].id : '';
    }
    return config;
  });

  ipcMain.handle('account:update', (_, payload) => {
    const acc = accounts.find((a) => a.id === payload.id);
    if (acc) Object.assign(acc, payload.patch || {});
    return config;
  });

  ipcMain.handle('scale:set', (_, value) => {
    const n = Math.max(0.7, Math.min(1.8, Number(value) || 1));
    config.uiScale = Math.round(n * 100) / 100;
    return { ok: true, uiScale: config.uiScale };
  });

  win.webContents.on('console-message', (...args) => {
    const text = args.map((a) => {
      try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); } catch (_) { return '?'; }
    }).join(' | ');
    if (/Uncaught|TypeError|ReferenceError/.test(text)) console.log('RENDERER_ERROR:', text);
  });

  await win.loadFile(path.join(__dirname, 'src', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 700));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const g = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = {
      hasBridge: typeof window.resinWidget === 'object' && typeof window.resinWidget.getState === 'function',
      hasQrApi: typeof window.resinWidget.qrStart === 'function' && typeof window.resinWidget.onQrUpdate === 'function',
      hasVerifyApi: typeof window.resinWidget.verifyStart === 'function' && typeof window.resinWidget.onToast === 'function',
      hasAccountApi: typeof window.resinWidget.removeAccount === 'function'
        && typeof window.resinWidget.setScale === 'function'
        && typeof window.resinWidget.windowAction === 'function',
      hasNoSwitchApi: typeof window.resinWidget.switchAccount === 'undefined',
      oldWindowWidget: window.widget ? window.widget.tagName : null,
      resin: g('resinValue').textContent,
      max: g('resinMax').textContent,
      full: g('fullCountdown').textContent,
      next: g('nextCountdown').textContent,
      status: g('statusText').textContent,
    };

    // 账号面板
    g('btnAccounts').click();
    const sheetOpen = !g('accountsSheet').hidden;
    const accountRows = g('accountListSheet').querySelectorAll('.acct-row').length;
    const accountBadge = g('accountCount').textContent;
    g('btnAccountsClose').click();
    const sheetClosed = g('accountsSheet').hidden;

    // 设置与数据源
    g('btnSettings').click();
    const settingsOpen = !g('viewSettings').hidden;
    document.querySelector('[data-source="mihoyo"]').click();
    const mihoyoPanelOpen = !g('panelMihoyo').hidden;
    const accountSectionShown = !g('accountSection').hidden;

    // 扫码
    g('btnQrLogin').click();
    await wait(250);
    const qrOpen = !g('qrOverlay').hidden;
    const qrHasImage = Boolean(g('qrImage').getAttribute('src'));
    const qrModeText = g('qrMode').textContent;
    g('btnQrCancel').click();
    await wait(60);
    const qrClosed = g('qrOverlay').hidden;

    // 配色：6 个方案，点一下就换色
    const themeDots = document.querySelectorAll('.theme-dot').length;
    document.querySelector('.theme-dot[data-theme="frost"]').click();
    await wait(150);
    const themeApplied = document.documentElement.dataset.theme;
    const themeActiveDot = document.querySelector('.theme-dot.active')
      ? document.querySelector('.theme-dot.active').dataset.theme : '';

    // 保存并同步 → 主界面变成账号并列卡片
    g('btnSave').click();
    await wait(420);
    const cards = Array.from(g('multiList').querySelectorAll('.ac-card'));
    const multiVisible = !g('multiList').hidden && g('soloCard').hidden;
    const cardCount = cards.length;
    const cardResins = cards.map((c) => c.querySelector('.ac-resin b').textContent);
    const cardNames = cards.map((c) => c.querySelector('.ac-name').textContent);
    const cardHasExtra = Boolean(cards[0] && !cards[0].querySelector('.ac-extra').hidden);
    const cardFull = cards[0] ? cards[0].querySelector('.ac-full b').textContent : '';
    const classesBefore = cards.map((c) => c.className).join('|');
    if (cards[0]) cards[0].click();
    await wait(160);
    const classesAfter = cards.map((c) => c.className).join('|');
    const activeCards = g('multiList').querySelectorAll('.ac-card.is-active').length;
    const pinOnAfterClick = g('btnPin').classList.contains('on');
    const pinSwitchExists = Boolean(g('inDeskPin'));

    // 切回本地推算（保存后才真正生效），再校准一次
    g('btnSettings').click();
    document.querySelector('[data-source="local"]').click();
    g('btnSave').click();
    await wait(420);
    const soloVisible = !g('soloCard').hidden && g('multiList').hidden;
    g('btnSettings').click();
    g('inResin').value = '60';
    g('btnApplyCalibrate').click();
    await wait(200);
    const afterCalibrate = g('resinValue').textContent;

    // 缩放
    g('btnSettings').click();
    g('inScale').value = '125';
    g('inScale').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(380);
    const scaleText = g('btnScaleReset').textContent;

    g('btnVerifySettings').click();
    await wait(120);
    const verifyToast = g('toast').textContent;
    g('btnBack').click();
    await wait(180);
    return {
      before, sheetOpen, accountRows, accountBadge, sheetClosed,
      settingsOpen, mihoyoPanelOpen, accountSectionShown,
      qrOpen, qrHasImage, qrModeText, qrClosed,
      themeDots, themeApplied, themeActiveDot,
      afterCalibrate, scaleText, verifyToast,
      multiVisible, cardCount, cardResins, cardNames, cardHasExtra, cardFull,
      classesBefore, classesAfter, activeCards, pinOnAfterClick, pinSwitchExists, soloVisible,
    };
  })()`);

  const b = result.before;

  // 真实窗口层验证：resizable:false 时 setBounds 仍应生效，zoom 与窗口同步
  win.setBounds({ width: 430, height: 365 });
  win.webContents.setZoomFactor(1.25);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const bounds = win.getBounds();
  const zoom = win.webContents.getZoomFactor();
  const scaleOk = Math.abs(bounds.width - 430) <= 1
    && Math.abs(bounds.height - 365) <= 1
    && Math.abs(zoom - 1.25) < 0.01;

  const ok = b.hasBridge
    && b.hasQrApi
    && b.hasVerifyApi
    && b.hasAccountApi
    && b.hasNoSwitchApi
    && /验证窗口/.test(result.verifyToast)
    && b.resin === '148'
    && b.max === '200'
    && b.status === '本地推算'
    && /^\d{2}:\d{2}:\d{2}$/.test(b.full)
    && /^\d{2}:\d{2}$/.test(b.next)
    && result.sheetOpen
    && result.accountRows >= 2
    && result.accountBadge === '2'
    && result.sheetClosed
    && result.settingsOpen
    && result.mihoyoPanelOpen
    && result.accountSectionShown
    && result.qrOpen
    && result.qrHasImage
    && /App 通道/.test(result.qrModeText)
    && result.qrClosed
    && result.themeDots === 6
    && result.themeApplied === 'frost'
    && result.themeActiveDot === 'frost'
    && result.multiVisible
    && result.cardCount === 2
    && result.cardResins.includes('30')
    && result.cardNames.some((n) => /示例旅行者|小号/.test(n))
    && result.cardHasExtra
    && /^\d{2}:\d{2}:\d{2}$/.test(result.cardFull)
    && result.classesBefore === result.classesAfter
    && result.activeCards === 0
    && result.pinOnAfterClick === false
    && result.pinSwitchExists
    && result.soloVisible
    && result.afterCalibrate === '60'
    && result.scaleText === '125%'
    && scaleOk;

  console.log('APP_SELFTEST=' + JSON.stringify({
    ok, scaleOk, windowBounds: bounds, zoom, ...result,
  }));
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error('APP_SELFTEST_FAILED', error);
  app.exit(1);
});

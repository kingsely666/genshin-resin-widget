'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { execFile } = require('node:child_process');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  Notification,
  screen,
} = require('electron');

const { Store, clampScale } = require('./store');
const api = require('./api');
const qrlogin = require('./qrlogin');
const devicefp = require('./devicefp');

// assets 在打包后位于 resources/assets（PowerShell 无法执行 asar 内的脚本），
// 开发时仍是项目根目录下的 assets。
const ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '..', 'assets');

// 打包后 app.getName() 取 productName（中文），存档目录会跟着变；固定住，避免用户登录态丢失。
if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'genshin-resin-widget'));
  } catch (_) { /* 极早期调用失败时走默认路径 */ }
}

const BASE_W = 344;
const BASE_H = 292;
const MIN_H = 180;
const MAX_H = 900;
const QR_TTL_MS = 180000;
const MIN_SYNC_INTERVAL = 180; // 秒：请求过密会触发米游社风控
const ACCOUNT_SYNC_GAP = 700; // 多账号逐个同步的间隔，避免瞬时请求过密

let store;
let win = null;
let tray = null;
let quitting = false;
let syncTimer = null;
let syncFailures = 0;
let lastStatus = { kind: 'idle', text: '' };
let qrSession = null;
let qrTimer = null;
let qrBusy = false;
let verifyWin = null;
let currentVerification = null;
let verificationAccountId = '';
let suppressMoveSave = false;
// 验证页用本地 http 承载：file:// 的 Origin 是 null，极验会按非常规来源降级处理，
// 导致滑块本地能过、服务端却不认（retcode -1）。
let verifyServer = null;
let verifyPort = 0;
// 被 1034 风控的账号进入冷却，避免定时同步反复冲撞让对方把风险等级越推越高
const riskHold = new Map(); // accountId -> 解除时间戳
const RISK_HOLD_MS = 30 * 60 * 1000;
// 主界面内容高度（逻辑像素）：单账号 292，多账号由渲染层实测后下发
let logicalHeight = BASE_H;
let syncBusy = false;
// 桌面钉住的当前状态：pin 是否已生效、是否有命令在执行、是否被临时提到前台
const deskLayer = { pin: false, busy: false, pending: false, suspended: false, deferred: false, toastOnPin: false };
// 设置页 / 任意浮层打开时窗口必须能拿到键盘焦点，此时不能挂在桌面层
let surfaceInteractive = false;
// 手动拖动的起点快照（钉在桌面后系统标题栏拖动会失效，改由渲染层驱动）
let dragState = null;

const RESIN_SECONDS = api.RESIN_SECONDS;

// RESIN_WIDGET_NO_LOCK 给自检用：允许和用户正在使用的实例并存
const skipLock = process.env.RESIN_WIDGET_NO_LOCK === '1';
if (!skipLock && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
  app.on('window-all-closed', () => { /* 窗口隐藏到托盘，保持常驻 */ });
  app.on('will-quit', () => {
    if (verifyServer) {
      try { verifyServer.close(); } catch (_) { /* ignore */ }
      verifyServer = null;
    }
  });
  app.on('activate', () => showWindow());
}

function start() {
  store = new Store();
  createWindow();
  createTray();
  registerIPC();
  applyConfig();
  emitNote(store.noteSnapshot);
  emitStatus(store.noteSnapshot
    ? { kind: store.config.source === 'local' ? 'local' : 'ok', text: store.config.source === 'local' ? '本地推算' : '已同步' }
    : { kind: 'uncalibrated', text: '待校准' });
  setInterval(checkOverflow, 30000);
  if (store.config.source === 'custom'
    || (store.config.source === 'mihoyo' && loggedAccounts().length)) {
    syncNow(false);
  }
}

function createWindow() {
  const cfg = store.config;
  const scale = clampScale(cfg.uiScale);
  logicalHeight = clamp(Number(cfg.uiHeight) || BASE_H, MIN_H, MAX_H);
  const width = Math.round(BASE_W * scale);
  const height = Math.round(logicalHeight * scale);
  const area = screen.getPrimaryDisplay().workArea;
  const x = Number.isFinite(cfg.winX) ? cfg.winX : area.x + area.width - width - 36;
  const y = Number.isFinite(cfg.winY) ? cfg.winY : area.y + 80;

  win = new BrowserWindow({
    width,
    height,
    x: clamp(x, area.x, area.x + area.width - width),
    y: clamp(y, area.y, area.y + area.height - height),
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: Boolean(cfg.alwaysOnTop) && !cfg.deskPin,
    // 自检脚本会用环境变量改标题，避免和正在使用的实例混在一起
    title: process.env.RESIN_WIDGET_TITLE || '原粹树脂',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.setAlwaysOnTop(Boolean(cfg.alwaysOnTop) && !cfg.deskPin, 'floating');
  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.setZoomFactor(clampScale(store.config.uiScale));
    emitConfig();
    emitNote(store.noteSnapshot);
    // 上次退出时是钉在桌面的，重新挂回桌面层
    if (store.config.deskPin) setTimeout(() => { syncWindowLayer(); }, 300);
  });
  // 接管 Ctrl +/-/0，避免 Chromium 默认缩放把内容缩放但与窗口尺寸脱节
  win.webContents.on('before-input-event', (event, input) => {
    if (!input.control || input.type !== 'keyDown') return;
    const key = input.key;
    if (key !== '=' && key !== '+' && key !== '-' && key !== '0') return;
    event.preventDefault();
    const current = clampScale(store.config.uiScale);
    changeScale(key === '0' ? 1 : current + (key === '-' ? -0.05 : 0.05));
  });
  win.on('moved', () => {
    if (suppressMoveSave) return;
    const b = win.getBounds();
    store.patch({ winX: b.x, winY: b.y });
  });
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

/**
 * 界面缩放：窗口尺寸与页面 zoom 同步变化，布局仍是 344x292 逻辑像素，
 * 所以放大只是整体等比变大，不会挤压或截断内容。
 */
function applyScale(value) {
  if (!win || win.isDestroyed()) return clampScale(value);
  const scale = clampScale(value);
  const bounds = win.getBounds();
  const width = Math.round(BASE_W * scale);
  const height = Math.round(logicalHeight * scale);
  const area = screen.getDisplayMatching(bounds).workArea;

  // 默认贴在屏幕右侧，缩放时保持右边缘不动，视觉上像原地放大
  const keepRight = (area.x + area.width) - (bounds.x + bounds.width) < 80;
  let x = keepRight ? bounds.x + bounds.width - width : bounds.x;
  let y = bounds.y;
  x = clamp(x, area.x, area.x + area.width - width);
  y = clamp(y, area.y, area.y + area.height - height);

  suppressMoveSave = true;
  win.setBounds({ x, y, width, height });
  if (win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.setZoomFactor(scale);
  }
  setTimeout(() => { suppressMoveSave = false; }, 120);

  store.patch({ uiScale: scale, winX: x, winY: y });
  return scale;
}

/**
 * 主界面高度自适应：渲染层实测内容高度后回调这里。
 * 宽度固定（344 逻辑像素），只改高度，保持顶边不动、必要时向上回缩避免出屏。
 */
function fitHeight(value) {
  const target = clamp(Math.round(Number(value) || BASE_H), MIN_H, MAX_H);
  if (!win || win.isDestroyed()) {
    logicalHeight = target;
    return target;
  }
  const scale = clampScale(store.config.uiScale);
  const width = Math.round(BASE_W * scale);
  const height = Math.round(target * scale);
  const bounds = win.getBounds();
  logicalHeight = target;
  if (Math.abs(bounds.width - width) <= 1 && Math.abs(bounds.height - height) <= 1) {
    return target;
  }
  const area = screen.getDisplayMatching(bounds).workArea;
  const x = clamp(bounds.x, area.x, area.x + area.width - width);
  const y = clamp(bounds.y, area.y, area.y + area.height - height);

  suppressMoveSave = true;
  win.setBounds({ x, y, width, height });
  setTimeout(() => { suppressMoveSave = false; }, 120);
  store.patch({ uiHeight: target, winX: x, winY: y });
  return target;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

/* ---------------- 固定在桌面 ---------------- */
/** 取窗口句柄（Windows 下 Electron 给的是原生 HWND 缓冲区） */
function hwndOf(target) {
  try {
    const buf = target.getNativeWindowHandle();
    if (!buf || !buf.length) return '';
    return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
  } catch (_) {
    return '';
  }
}

/**
 * 调用 PowerShell 把窗口挂到桌面（Progman）下：
 * 挂进去之后窗口就停在桌面层：浮在壁纸与桌面图标之上，但在所有普通窗口之下。
 * 也就是「不会被最大化的程序挡住，也不会挡住别人」。
 */
function runDeskPin(action) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, message: '仅 Windows 支持钉在桌面' });
      return;
    }
    if (!win || win.isDestroyed()) {
      resolve({ ok: false, message: '窗口不可用' });
      return;
    }
    const hwnd = hwndOf(win);
    if (!hwnd) {
      resolve({ ok: false, message: '取不到窗口句柄' });
      return;
    }
    const script = path.join(ASSETS_DIR, 'deskpin.ps1');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, message: '缺少桌面固定脚本' });
      return;
    }
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Hwnd', hwnd, '-Action', action,
      ],
      { windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (!error && out.startsWith('OK')) {
          resolve({ ok: true, message: out });
        } else {
          resolve({
            ok: false,
            message: out || String(stderr || '').trim() || (error && error.message) || '执行失败',
          });
        }
      },
    );
  });
}

/** 窗口层级只在真正需要时切换，避免每次改配置都拉一次 PowerShell */
async function syncWindowLayer() {
  if (!win || win.isDestroyed()) return;
  const wantPin = Boolean(store.config.deskPin);
  if (!wantPin) {
    deskLayer.suspended = false;
    deskLayer.deferred = false;
  }
  // 设置页 / 浮层打开时先浮到普通窗口层：挂在桌面层的子窗口收不到键盘焦点，
  // 输入框点了也打不出字。回到主界面再钉回去。
  if (wantPin && surfaceInteractive) {
    deskLayer.deferred = true;
    win.setAlwaysOnTop(true, 'floating');
    return;
  }
  if (deskLayer.suspended) {
    // 被临时提到前台（例如从托盘打开设置），此时不要把它拉回桌面层
    win.setAlwaysOnTop(true, 'floating');
    return;
  }
  if (wantPin === deskLayer.pin) {
    win.setAlwaysOnTop(!wantPin && Boolean(store.config.alwaysOnTop), 'floating');
    return;
  }
  if (deskLayer.busy) {
    deskLayer.pending = true;
    return;
  }
  deskLayer.busy = true;
  try {
    const result = await runDeskPin(wantPin ? 'pin' : 'unpin');
    if (result.ok) {
      deskLayer.pin = wantPin;
      win.setAlwaysOnTop(!wantPin && Boolean(store.config.alwaysOnTop), 'floating');
      if (wantPin) moveIntoPrimaryDisplay();
      logDiag(`deskpin ${wantPin ? 'pin' : 'unpin'} ok ${result.message}`);
      if (deskLayer.toastOnPin) {
        deskLayer.toastOnPin = false;
        emitToast(wantPin
          ? '已固定在桌面：会藏在普通窗口下面，点托盘图标即可唤出'
          : '已取消桌面固定');
      }
    } else if (wantPin) {
      // 系统不支持（远程桌面、部分安全软件拦截）时退回普通置顶窗，别让用户以为开了
      store.patch({ deskPin: false, alwaysOnTop: true });
      win.setAlwaysOnTop(true, 'floating');
      logDiag(`deskpin failed: ${result.message}`);
      emitToast('当前系统不支持钉在桌面，已改为置顶显示');
      emitConfig();
    } else {
      logDiag(`deskpin unpin failed: ${result.message}`);
    }
    rebuildTray();
  } finally {
    deskLayer.busy = false;
    if (deskLayer.pending) {
      deskLayer.pending = false;
      setTimeout(syncWindowLayer, 60);
    }
  }
}

/** 钉在桌面时窗口在桌面层，从托盘唤出 / 打开设置要临时把它提到前台 */
async function suspendDeskPin(reason) {
  if (!store.config.deskPin || deskLayer.suspended) {
    if (win && !win.isDestroyed()) showWindow();
    return true;
  }
  deskLayer.suspended = true;
  if (deskLayer.pin) {
    const result = await runDeskPin('unpin');
    if (result.ok) deskLayer.pin = false;
  }
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(true, 'floating');
    showWindow();
  }
  if (reason) emitToast(reason);
  return true;
}

/** 回到主界面后重新钉回桌面 */
async function resumeDeskPin() {
  if (!deskLayer.suspended && !deskLayer.deferred) return;
  deskLayer.suspended = false;
  deskLayer.deferred = false;
  if (!store.config.deskPin) {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(Boolean(store.config.alwaysOnTop), 'floating');
    return;
  }
  await syncWindowLayer();
}

/**
 * 界面是否处于「需要键盘 / 鼠标交互」的状态（设置页或任意浮层）。
 * 钉在桌面时窗口是 Progman 的子窗口：鼠标能点，但拿不到焦点，输入框打不出字，
 * 而且始终在所有普通窗口之下。所以一进设置页就临时浮到前台，回主界面再钉回去。
 * 切换要串行执行：快速开关面板时不能并行拉起多个 PowerShell 去抢层级。
 */
let surfaceChain = Promise.resolve();

async function applySurface(next) {
  if (!win || win.isDestroyed()) {
    if (!next) {
      deskLayer.suspended = false;
      deskLayer.deferred = false;
    }
    return;
  }

  if (next) {
    await suspendDeskPin('');
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(true, 'floating');
    win.moveTop();
    win.focus();
    return;
  }

  await resumeDeskPin();
  if (!store.config.deskPin && win && !win.isDestroyed()) {
    win.setAlwaysOnTop(Boolean(store.config.alwaysOnTop), 'floating');
  }
}

function setSurface(interactive) {
  const next = Boolean(interactive);
  if (next === surfaceInteractive) return surfaceChain;
  surfaceInteractive = next;
  surfaceChain = surfaceChain.then(() => applySurface(next)).catch((error) => {
    logDiag(`surface switch failed: ${error && error.message}`);
  });
  return surfaceChain;
}

/** 钉在桌面后窗口只属于主屏桌面层，把超出工作区的窗口拉回来 */
function moveIntoPrimaryDisplay() {
  if (!win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const b = win.getBounds();
  const x = clamp(b.x, area.x, Math.max(area.x, area.x + area.width - b.width));
  const y = clamp(b.y, area.y, Math.max(area.y, area.y + area.height - b.height));
  if (x === b.x && y === b.y) return;
  suppressMoveSave = true;
  win.setBounds({ x, y, width: b.width, height: b.height });
  setTimeout(() => { suppressMoveSave = false; }, 120);
  store.patch({ winX: x, winY: y });
}

function loadTrayImage() {
  const iconPath = path.join(ASSETS_DIR, 'tray.png');
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  );
}

function createTray() {
  tray = new Tray(loadTrayImage());
  tray.setToolTip('原粹树脂 · 桌面小组件');
  rebuildTray();
  tray.on('click', () => openFromTray(''));
  tray.on('double-click', () => openFromTray(''));
}

function rebuildTray() {
  if (!tray) return;
  const cfg = store.config;
  const accounts = store.publicConfig.accounts || [];

  const accountItems = accounts.length
    ? accounts.map((a) => ({
      label: `${a.label}${a.resin != null ? `  ·  ${a.resin}/${a.maxResin}` : ''}${a.error ? '  ·  同步异常' : ''}`,
      click: () => openFromTray('accounts'),
    }))
    : [{ label: '暂无账号，先扫码登录', enabled: false }];

  const scaleSteps = [80, 90, 100, 110, 125, 150, 175];
  const currentScale = Math.round(clampScale(cfg.uiScale) * 100);

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '原粹树脂 · 桌面小组件', enabled: false },
    { label: '显示 / 隐藏', click: () => (win.isVisible() ? win.hide() : openFromTray('')) },
    { label: '立即同步', click: () => syncNow(true) },
    { label: '尝试滑块验证（多为无效）', click: () => { startVerification(); } },
    { type: 'separator' },
    {
      label: '账号',
      submenu: [
        ...accountItems,
        { type: 'separator' },
        { label: '添加账号（扫码登录）', click: () => openFromTray('qr') },
        { label: '管理账号', click: () => openFromTray('accounts') },
      ],
    },
    {
      label: `界面缩放（${currentScale}%）`,
      submenu: scaleSteps.map((p) => ({
        label: `${p}%`,
        type: 'radio',
        checked: currentScale === p,
        click: () => changeScale(p / 100),
      })),
    },
    { label: '设置', click: () => openFromTray('settings') },
    { type: 'separator' },
    {
      label: '固定在桌面（壁纸层，不挡其它程序）',
      type: 'checkbox',
      checked: Boolean(cfg.deskPin),
      click: (item) => {
        store.patch({ deskPin: item.checked });
        applyConfig();
        emitConfig();
        emitToast(item.checked ? '已固定在桌面' : '已取消桌面固定');
      },
    },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: Boolean(cfg.alwaysOnTop) && !cfg.deskPin,
      click: (item) => {
        store.patch({ alwaysOnTop: item.checked });
        applyConfig();
        emitConfig();
        emitToast(item.checked ? '已置顶显示' : '已取消置顶');
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: Boolean(cfg.autoStart),
      click: (item) => {
        store.patch({ autoStart: item.checked });
        setAutoStart(item.checked);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

/** 桌面固定与始终置顶互斥：开一个自动关另一个 */
function toggleLayer(kind) {
  const cfg = store.config;
  if (kind === 'deskPin') {
    const next = !cfg.deskPin;
    store.patch({ deskPin: next });
    deskLayer.toastOnPin = true;
    emitToast(next
      ? (surfaceInteractive ? '已设为固定在桌面，回到主界面后生效' : '正在固定到桌面…')
      : '正在取消桌面固定…');
  } else {
    const next = !(cfg.alwaysOnTop && !cfg.deskPin);
    store.patch({ alwaysOnTop: next });
    emitToast(next ? '已置顶显示' : '已取消置顶');
  }
  applyConfig();
  emitConfig();
  return store.publicConfig;
}

function changeScale(value) {
  const applied = applyScale(value);
  emitConfig();
  emitToast(`界面缩放 ${Math.round(applied * 100)}%`);
  return applied;
}

function setAutoStart(enabled) {
  try {
    const opts = { openAtLogin: Boolean(enabled), path: process.execPath };
    // 打包后 exe 自己就是入口；只有开发时（electron.exe）才需要传应用目录当参数
    if (!app.isPackaged) opts.args = [app.getAppPath()];
    app.setLoginItemSettings(opts);
  } catch (_) {
    /* 某些环境不支持开机自启 */
  }
}

function showWindow() {
  if (!win) return;
  if (!win.isVisible()) win.show();
  win.focus();
}

/** 托盘里的每个入口：钉在桌面时先把窗口提到前台，再切到对应界面 */
const TRAY_CHANNELS = { settings: 'ui:settings', accounts: 'ui:accounts', qr: 'ui:qr' };

function openFromTray(target) {
  if (!win || win.isDestroyed()) return;
  const send = () => {
    const channel = TRAY_CHANNELS[target];
    if (!channel || !win || win.isDestroyed()) return;
    win.webContents.send(channel);
  };
  if (store.config.deskPin && !deskLayer.suspended) {
    suspendDeskPin('已临时提到前台，回到主界面后会自动恢复桌面固定').then(send);
    return;
  }
  showWindow();
  send();
}

function emitNote(note) {
  if (win && !win.isDestroyed()) win.webContents.send('note:update', note);
}

function emitStatus(status) {
  lastStatus = status;
  if (win && !win.isDestroyed()) win.webContents.send('status:update', status);
}

function emitToast(message) {
  if (win && !win.isDestroyed()) win.webContents.send('ui:toast', message);
}

function emitQr(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('qr:update', payload);
}

/** 只记录错误码与文案，绝不写入 Cookie / token */
function logDiag(line) {
  try {
    const file = path.join(app.getPath('userData'), 'diagnose.log');
    let old = '';
    try {
      if (fs.existsSync(file) && fs.statSync(file).size < 65536) old = fs.readFileSync(file, 'utf8');
    } catch (_) { /* ignore */ }
    fs.writeFileSync(file, `${old}[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (_) { /* ignore */ }
}

function effectiveInterval() {
  const base = Math.max(MIN_SYNC_INTERVAL, Number(store.config.syncInterval) || 300);
  return Math.min(3600, base * Math.min(8, 2 ** syncFailures));
}

function rescheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  if (store.config.source === 'local') return;
  syncTimer = setInterval(() => syncNow(false), effectiveInterval() * 1000);
}

/**
 * 风控冷却。
 * 触发 1034 后如果还按原间隔请求，会被判定为持续异常，风险等级只会更高；
 * 这里让该账号安静一段时间，等自然冷却。
 */
function holdAccount(id) {
  if (!id) return;
  riskHold.set(id, Date.now() + RISK_HOLD_MS);
  logDiag(`account ${id} in risk hold for ${Math.round(RISK_HOLD_MS / 60000)}min`);
}

function applyConfig() {
  const cfg = store.config;
  if (win && !win.isDestroyed()) {
    syncWindowLayer();
    const scale = clampScale(cfg.uiScale);
    const bounds = win.getBounds();
    const widthMatched = Math.abs(bounds.width - Math.round(BASE_W * scale)) <= 1;
    const heightMatched = Math.abs(bounds.height - Math.round(logicalHeight * scale)) <= 1;
    if (!widthMatched || !heightMatched) applyScale(scale);
  }
  setAutoStart(cfg.autoStart);
  rebuildTray();
  rescheduleSync();
}

function emitConfig() {
  if (win && !win.isDestroyed()) win.webContents.send('config:update', store.publicConfig);
}

/** 确保国服请求带官方签发的设备指纹（缺失会 5003） */
async function ensureDeviceFp() {
  let priv = store.privateConfig;
  if (priv.deviceFp || api.isOversea(priv.server)) return priv;
  const fp = await devicefp.acquireDeviceFp(priv);
  store.setDeviceFp(fp);
  logDiag(`device_fp acquired fromServer=${fp.fromServer} code=${fp.code}`);
  return store.privateConfig;
}

/** 同步前补齐指纹；失败时按错误码刷新指纹 / 自动续期 */
async function fetchNoteWithRefresh() {
  let priv = await ensureDeviceFp();
  const hooks = {
    onTrace: (traceId) => store.setTraceId(traceId),
    onChallengeUsed: () => store.consumeChallenge(),
  };
  try {
    return await api.fetchNote(priv, hooks);
  } catch (error) {
    if (error.needFpRefresh) {
      // 5003：重新申请一枚指纹并立即重试一次；通常随后转为 1034（需验证）
      store.clearDeviceFp();
      const fp = await devicefp.acquireDeviceFp(priv);
      store.setDeviceFp(fp);
      logDiag('device_fp refreshed after 5003');
      try {
        return await api.fetchNote(store.privateConfig, hooks);
      } catch (second) {
        if (second.needFpRefresh) {
          // 设备标识可能已被标记：换一枚 deviceId 重新申请指纹，最后再试一次
          store.resetDevice();
          const rotated = await devicefp.acquireDeviceFp(store.privateConfig);
          store.setDeviceFp(rotated);
          logDiag('device identity rotated after repeated 5003');
          try {
            return await api.fetchNote(store.privateConfig, hooks);
          } catch (third) {
            if (third.needFpRefresh) {
              // 账号级临时风控：指纹已合规但仍被挡，给出可操作提示并开放验证入口
              const err = new Error('米游社设备风控（5003）：账号可能被临时限制，请点「验证当前用户」，或稍后再试 / 在米游社 App 打开一次实时便笺');
              err.retcode = 5003;
              err.needVerify = true;
              throw err;
            }
            throw third;
          }
        }
        throw second;
      }
    }
    if (api.isAuthError(error.retcode) && priv.credential?.stoken) {
      const refreshed = await qrlogin.refreshCredential(priv.credential, priv.deviceId);
      store.setCredential(refreshed);
      return api.fetchNote(store.privateConfig, hooks);
    }
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 已登录（保存了凭证）的账号，按列表顺序逐个同步 */
function loggedAccounts() {
  return store.accounts.filter((a) => a.cookieSealed);
}

/**
 * 以某个账号为上下文读一次便笺。
 * 设备指纹 / 验证令牌 / stoken 续期都挂在 activeAccount 上，
 * 因此这里临时切换当前账号，结束后立即还原（调用方保证串行）。
 */
async function fetchNoteFor(account) {
  const previous = store.activeId;
  store.setActiveId(account.id);
  try {
    return await fetchNoteWithRefresh();
  } finally {
    store.setActiveId(previous);
  }
}

async function doSync(userInitiated) {
  const cfg = store.config;

  if (cfg.source === 'local') {
    emitNote(store.noteSnapshot);
    emitStatus(store.noteSnapshot
      ? { kind: 'local', text: '本地推算' }
      : { kind: 'uncalibrated', text: '待校准' });
    return { ok: true };
  }

  if (cfg.source === 'custom') {
    emitStatus({ kind: 'syncing', text: '同步中…' });
    try {
      const note = await api.fetchCustom(store.privateConfig);
      store.setNote(note);
      emitNote(note);
      emitStatus({ kind: 'ok', text: `已同步 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` });
      if (syncFailures) { syncFailures = 0; rescheduleSync(); }
      return { ok: true };
    } catch (error) {
      logDiag(`custom sync failed message=${error.message}`);
      emitStatus({ kind: 'error', text: error.message || '同步失败' });
      if (!userInitiated && syncFailures < 3) { syncFailures += 1; rescheduleSync(); }
      if (store.noteSnapshot) emitNote(store.noteSnapshot);
      return { ok: false, message: error.message };
    }
  }

  const accounts = loggedAccounts();
  if (!accounts.length) {
    emitStatus({ kind: 'error', text: '请先扫码登录米游社' });
    return { ok: false, message: '请先扫码登录米游社' };
  }

  // 多账号：全部同步，任何一个失败都不影响其它账号的展示
  let okCount = 0;
  let lastError = null;
  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];
    const name = account.nickname || account.label || `账号 ${i + 1}`;
    // 冷却中的账号跳过自动同步；用户手动点「立即同步」仍然放行，避免被卡死
    const holdUntil = riskHold.get(account.id) || 0;
    if (!userInitiated && holdUntil > Date.now()) {
      okCount += 1;
      continue;
    }
    emitStatus({
      kind: 'syncing',
      text: accounts.length > 1 ? `同步中 ${i + 1}/${accounts.length} · ${name}` : '同步中…',
    });
    try {
      const note = await fetchNoteFor(account);
      store.setNoteFor(account.id, note);
      riskHold.delete(account.id);
      okCount += 1;
    } catch (error) {
      lastError = lastError || error;
      store.setSyncError(account.id, error.message || '同步失败');
      if (error.needVerify) holdAccount(account.id);
      logDiag(`sync account=${account.uid || account.id} failed retcode=${error.retcode ?? '-'} message=${error.message}`);
    }
    if (i < accounts.length - 1) await delay(ACCOUNT_SYNC_GAP);
  }

  emitConfig();
  emitNote(store.noteSnapshot);

  if (okCount === accounts.length) {
    emitStatus({
      kind: 'ok',
      text: accounts.length > 1
        ? `已同步 ${accounts.length} 个账号`
        : `已同步 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
    });
    if (syncFailures) { syncFailures = 0; rescheduleSync(); }
    return { ok: true };
  }

  const message = lastError?.message || '同步失败';
  emitStatus({
    kind: 'error',
    text: okCount ? `已同步 ${okCount}/${accounts.length}，部分账号失败` : message,
    needVerify: Boolean(lastError?.needVerify),
    risk: Boolean(lastError?.risk),
  });
  if (!userInitiated && syncFailures < 3) { syncFailures += 1; rescheduleSync(); }
  return { ok: false, message, needVerify: Boolean(lastError?.needVerify) };
}

async function syncNow(userInitiated) {
  if (syncBusy) return { ok: false, busy: true, message: '正在同步中，请稍候' };
  syncBusy = true;
  try {
    return await doSync(userInitiated);
  } finally {
    syncBusy = false;
  }
}

/**
 * 只同步指定账号。
 * 验证成功后用：此时其它账号可能仍在风控中，一起撞一遍只会加重风险。
 */
async function syncAccountNow(id) {
  const account = (id && store.accountById(id)) || store.activeAccount;
  if (!account) return { ok: false, message: '账号不存在' };
  if (syncBusy) return { ok: false, busy: true, message: '正在同步中' };
  syncBusy = true;
  try {
    emitStatus({ kind: 'syncing', text: '同步中…' });
    const note = await fetchNoteFor(account);
    store.setNoteFor(account.id, note);
    riskHold.delete(account.id);
    emitConfig();
    emitNote(store.noteSnapshot);
    emitStatus({ kind: 'ok', text: '已验证并同步' });
    return { ok: true };
  } catch (error) {
    logDiag(`post-verify sync failed retcode=${error.retcode ?? '-'} ${error.message}`);
    store.setSyncError(account.id, error.message || '同步失败');
    if (error.needVerify) holdAccount(account.id);
    emitConfig();
    emitStatus({ kind: 'error', text: error.message || '同步失败', needVerify: Boolean(error.needVerify) });
    return { ok: false, message: error.message };
  } finally {
    syncBusy = false;
  }
}

/* ---------------- 扫码登录会话 ---------------- */
function stopQrPolling() {
  if (qrTimer) {
    clearInterval(qrTimer);
    qrTimer = null;
  }
  qrSession = null;
}

async function startQrLogin() {
  stopQrPolling();
  emitQr({ phase: 'loading', text: '正在生成二维码…' });
  try {
    const session = await qrlogin.createSession();
    const qrDataUrl = await qrlogin.makeQRDataURL(session.url);
    qrSession = { ...session, startedAt: Date.now() };
    emitQr({
      phase: 'created',
      text: session.mode === 'app'
        ? '请用米游社 App 扫一扫'
        : '请用米游社 App 扫一扫（兼容通道）',
      qrDataUrl,
      mode: session.mode,
      fallbackReason: session.fallbackReason || '',
    });
    qrTimer = setInterval(() => { pollQr(); }, 2000);
    return { ok: true, mode: session.mode };
  } catch (error) {
    emitQr({ phase: 'error', text: error.message });
    return { ok: false, message: error.message };
  }
}

async function pollQr() {
  if (!qrSession || qrBusy) return;
  qrBusy = true;
  try {
    if (Date.now() - qrSession.startedAt > QR_TTL_MS) {
      stopQrPolling();
      emitQr({ phase: 'expired', text: '二维码已过期，请点「刷新二维码」' });
      return;
    }
    const result = await qrlogin.checkSession(qrSession);
    if (result.status === 'Init') return;
    if (result.status === 'Scanned') {
      emitQr({ phase: 'scanned', text: '已扫描，请在手机上点「确认登录」' });
      return;
    }
    if (result.status === 'Confirmed') {
      stopQrPolling();
      await finishLogin(result.credential);
      return;
    }
    if (result.status === 'Expired' || result.status === 'Canceled') {
      stopQrPolling();
      emitQr({ phase: 'expired', text: result.message || '二维码已失效' });
      return;
    }
    stopQrPolling();
    emitQr({ phase: 'error', text: result.message || '扫码状态异常' });
  } catch (error) {
    // 单次网络抖动不终止会话
    emitQr({ phase: 'polling-error', text: `等待扫码…（${error.message}）` });
  } finally {
    qrBusy = false;
  }
}

async function finishLogin(credential) {
  emitQr({ phase: 'working', text: '登录成功，正在读取角色…' });
  let role = null;
  let rolesError = '';
  try {
    // 新凭证还没写入账号，先用临时配置读一次角色
    const roles = await api.fetchRoles({ ...store.privateConfig, cookie: credential.cookie });
    if (roles.length) role = roles[0];
    else rolesError = '未找到原神角色，可在设置里手动填写 UID';
  } catch (error) {
    rolesError = `角色读取失败：${error.message}`;
  }

  store.upsertAccount({
    uid: role ? String(role.uid) : '',
    server: role?.server || 'cn_gf01',
    nickname: role?.nickname || '',
    label: role ? `${role.nickname || '旅行者'} · ${role.uid}` : '',
  }, credential);

  applyConfig();
  emitConfig();
  emitQr({
    phase: 'done',
    text: rolesError || '登录成功，正在同步体力…',
    accountLabel: store.publicConfig.accountLabel || '米游社账号',
  });
  await syncNow(true);
}

/* ---------------- 人机验证（1034 风控） ---------------- */
/**
 * 用本地 http 承载验证页。
 * 直接 loadFile 时页面 Origin 为 null，极验会当作非常规来源降级，
 * 表现为「滑块本地通过、服务端却拒绝」。走 127.0.0.1 后 Origin/Referer 都是正常站点。
 */
function ensureVerifyServer() {
  if (verifyServer && verifyServer.listening && verifyPort) return Promise.resolve(verifyPort);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname = '/';
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch (_) { /* 非法 URL 按 404 处理 */ }
      let file = '';
      if (pathname === '/' || pathname === '/verify.html') {
        file = path.join(__dirname, 'verify.html');
      } else if (pathname.startsWith('/assets/')) {
        // 只取文件名，避免 ../ 穿越
        file = path.join(ASSETS_DIR, path.basename(pathname));
      }
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : file.endsWith('.css') ? 'text/css; charset=utf-8'
          : 'text/html; charset=utf-8';
      try {
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(file));
      } catch (_) {
        res.writeHead(500);
        res.end('read error');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      verifyServer = server;
      verifyPort = server.address().port;
      resolve(verifyPort);
    });
  });
}

async function requestVerification() {
  const priv = await ensureDeviceFp();
  // trace 有有效期。先真实发一次请求换一张新鲜的，避免拿几分钟前的票据去做验证。
  let traceId = priv.traceId || '';
  try {
    let fresh = '';
    await api.fetchNote(priv, { onTrace: (t) => { fresh = t; } });
    if (fresh) {
      traceId = fresh;
      store.setTraceId(fresh);
      logDiag('verification trace refreshed');
    }
  } catch (_) {
    // 1034 是预期结果，只要 trace 已回调即可；其它错误也不阻塞验证流程
  }
  const verification = await api.createVerification(priv, traceId);
  verificationAccountId = store.activeId || '';
  const acc = store.accountById(verificationAccountId) || store.activeAccount;
  const accountLabel = acc ? (acc.label || acc.nickname || acc.uid || '') : '';
  return { ...verification, traceId, accountLabel };
}

function startVerification() {
  if (verifyWin && !verifyWin.isDestroyed()) {
    verifyWin.focus();
    return Promise.resolve({ ok: true, message: '验证窗口已打开' });
  }
  return (async () => {
    const priv = store.privateConfig;
    if (!priv.cookie || priv.source === 'custom') return { ok: false, message: '请先扫码登录米游社' };
    try {
      const verification = await requestVerification();
      logDiag(`verification challenge created success=${verification.success} newCaptcha=${verification.new_captcha} trace=${verification.traceId ? 'yes' : 'no'}`);
      await openVerifyWindow(verification);
      return { ok: true, message: '已打开验证窗口，请完成滑块验证' };
    } catch (error) {
      logDiag(`verification create failed: ${error.message}`);
      return { ok: false, message: `验证申请失败：${error.message}` };
    }
  })();
}

async function openVerifyWindow(verification) {
  currentVerification = verification;
  // 同一时刻只允许一个验证窗口，先清掉上一轮注册
  ipcMain.removeHandler('verify:init:get');
  ipcMain.removeHandler('verify:retry');

  verifyWin = new BrowserWindow({
    width: 420,
    height: 400,
    title: '米游社人机验证',
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'verify-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  let settled = false;

  const onClose = () => {
    if (verifyWin && !verifyWin.isDestroyed()) verifyWin.close();
  };
  const cleanup = () => {
    ipcMain.removeListener('verify:submit', onSubmit);
    ipcMain.removeListener('verify:close', onClose);
    ipcMain.removeHandler('verify:init:get');
    ipcMain.removeHandler('verify:retry');
    currentVerification = null;
  };

  const onSubmit = async (_, geetest) => {
    if (settled) return;
    // 验证期间可能发生过自动同步，令牌必须写回真正被验证的那个账号
    if (verificationAccountId) store.setActiveId(verificationAccountId);
    const issued = currentVerification;
    const cfg = store.privateConfig;
    // 极验官方二次校验要求回传 getValidate() 的三个原始字段；
    // 但部分米游社接口要求 createVerification 下发的 challenge，故失败时自动换一种再提交一次。
    const validate = geetest.geetest_validate || geetest.validate || '';
    const seccodeRaw = geetest.geetest_seccode || geetest.seccode || '';
    // 极验二次校验的 seccode 标准格式为 validate|jordan；部分版本返回的原文缺后缀
    const seccode = seccodeRaw
      ? (seccodeRaw.includes('|jordan') ? seccodeRaw : `${seccodeRaw}|jordan`)
      : (validate ? `${validate}|jordan` : '');
    const payload = {
      geetest_challenge: geetest.geetest_challenge || geetest.challenge || '',
      geetest_validate: validate,
      geetest_seccode: seccode,
    };
    const traceId = (issued && issued.traceId) || cfg.traceId || '';
    logDiag(`verify submit fields=${Object.keys(geetest).join(',')} challengeLen=${payload.geetest_challenge.length} sameAsIssued=${payload.geetest_challenge === (issued && issued.challenge)} validateLen=${validate.length} seccodeHasJordan=${seccode.includes('|jordan')} trace=${traceId ? 'yes' : 'no'}`);
    try {
      // 同一份验证结果服务端只认一次，反复换组合提交只会把风险等级推得更高，
      // 因此这里只做一次干净提交。
      const attempt = {
        geetest_challenge: payload.geetest_challenge || (issued && issued.challenge) || '',
        geetest_validate: validate,
        geetest_seccode: seccode,
      };
      const challenge = await api.verifyVerification(cfg, attempt, traceId);
      logDiag('verify passed, challenge acquired');
      settled = true;
      cleanup();
      store.setChallenge(challenge);
      logDiag('verification passed, challenge stored');
      emitToast('验证通过，正在同步…');
      syncFailures = 0;
      riskHold.delete(verificationAccountId);
      rescheduleSync();
      const synced = await syncAccountNow(verificationAccountId);
      emitToast(synced.ok ? '已完成验证并重新同步' : '验证已通过，但同步仍失败，稍后会自动重试');
      if (verifyWin && !verifyWin.isDestroyed()) verifyWin.close();
    } catch (error) {
      logDiag(`verification submit failed: retcode=${error.retcode ?? '-'} body=${JSON.stringify(error.responseBody || {}).slice(0, 300)}`);
      const hint = Number(error.retcode) === -1
        ? '验证结果未被接受：账号当前风控等级较高。建议先在米游社 App 打开一次「实时便笺」，等几分钟后再回来验证'
        : error.message;
      emitToast(`验证未通过：${hint}`);
      // 失败时不清理监听、不关窗口，用户可直接点「重新加载验证」再试
      if (verifyWin && !verifyWin.isDestroyed()) {
        verifyWin.webContents.send('verify:failed', hint);
      }
    }
  };

  ipcMain.on('verify:submit', onSubmit);
  ipcMain.on('verify:close', onClose);
  ipcMain.handle('verify:init:get', () => currentVerification);
  ipcMain.handle('verify:retry', async () => {
    try {
      currentVerification = await requestVerification();
      logDiag(`verification challenge refreshed (retry) success=${currentVerification.success} trace=${currentVerification.traceId ? 'yes' : 'no'}`);
      if (verifyWin && !verifyWin.isDestroyed()) {
        verifyWin.webContents.send('verify:init', currentVerification);
      }
      return { ok: true };
    } catch (error) {
      logDiag(`verification retry failed: ${error.message}`);
      return { ok: false, message: error.message };
    }
  });

  verifyWin.webContents.once('did-finish-load', () => {
    if (verifyWin && !verifyWin.isDestroyed()) {
      verifyWin.webContents.send('verify:init', currentVerification);
    }
  });

  // 监听注册完再加载，避免 did-finish-load 抢先触发导致任务不下发
  try {
    const port = await ensureVerifyServer();
    await verifyWin.loadURL(`http://127.0.0.1:${port}/verify.html`);
    logDiag(`verify window loaded from local origin port=${port}`);
  } catch (error) {
    logDiag(`verify window http load failed: ${error.message}, fallback to file`);
    try { await verifyWin.loadFile(path.join(__dirname, 'verify.html')); } catch (_) { /* ignore */ }
  }

  verifyWin.on('closed', () => {
    cleanup();
    verifyWin = null;
  });
}

function currentResinOf(note) {
  if (!note) return 0;
  const elapsed = (Date.now() - note.syncedAt) / 1000;
  const remaining = Math.max(0, note.remainingSeconds - elapsed);
  if (remaining <= 0) return Math.max(note.maxResin, note.currentResin);
  return Math.max(0, note.maxResin - Math.ceil(remaining / RESIN_SECONDS));
}

function checkOverflow() {
  const cfg = store.config;
  const threshold = Number(cfg.notifyAt) || 0;
  if (!threshold) return;
  const today = new Date().toISOString().slice(0, 10);

  // 多账号：任一账号快到上限就提醒一次，同一天同一账号只提醒一次
  if (cfg.source === 'mihoyo') {
    const hits = [];
    let dirty = false;
    for (const account of loggedAccounts()) {
      if (!account.note || account.lastNotifyDate === today) continue;
      const current = currentResinOf(account.note);
      if (current < threshold) continue;
      account.lastNotifyDate = today;
      dirty = true;
      hits.push({
        name: account.nickname || account.label || '米游社账号',
        current,
        max: account.note.maxResin,
      });
    }
    if (dirty) store.persist();
    if (!hits.length) return;
    const title = hits.length > 1 ? `${hits.length} 个账号树脂快满了` : '原粹树脂快满了';
    const body = hits
      .map((h) => `${h.name}：${h.current}/${h.max}`)
      .join(' · ');
    notify(title, body);
    return;
  }

  const note = store.noteSnapshot;
  if (!note || store.data.lastNotifyDate === today) return;
  const current = currentResinOf(note);
  if (current < threshold) return;
  store.data.lastNotifyDate = today;
  store.persist();
  notify('原粹树脂快满了', `当前 ${current}/${note.maxResin}，记得上线消耗一下~`);
}

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show();
  } else if (tray && tray.displayBalloon) {
    tray.displayBalloon({ title, content: body });
  }
}

function registerIPC() {
  ipcMain.handle('state:get', () => ({
    config: store.publicConfig,
    note: store.noteSnapshot,
    status: lastStatus,
  }));

  ipcMain.handle('config:set', (_, patch) => {
    store.patch(patch || {});
    store.ensureValidSource();
    applyConfig();
    emitConfig();
    return store.publicConfig;
  });

  ipcMain.handle('account:remove', (_, id) => {
    const publicConfig = store.removeAccount(id);
    syncFailures = 0;
    applyConfig();
    emitConfig();
    emitNote(store.noteSnapshot);
    const acc = store.activeAccount;
    emitStatus(acc
      ? { kind: 'idle', text: '切换成功，正在同步…' }
      : { kind: 'idle', text: '未登录' });
    if (acc) syncNow(true);
    return publicConfig;
  });

  ipcMain.handle('account:update', (_, payload) => {
    const publicConfig = store.updateAccount(payload?.id, payload?.patch || {});
    applyConfig();
    emitConfig();
    return publicConfig;
  });

  ipcMain.handle('scale:set', (_, value) => {
    const applied = changeScale(value);
    return { ok: true, uiScale: applied };
  });

  ipcMain.handle('sync:now', () => syncNow(true));

  ipcMain.handle('roles:fetch', async () => {
    try {
      const roles = await api.fetchRoles(store.privateConfig);
      return { ok: true, roles };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('qr:start', () => startQrLogin());

  ipcMain.handle('qr:cancel', () => {
    stopQrPolling();
    emitQr({ phase: 'idle', text: '' });
    return { ok: true };
  });

  ipcMain.handle('account:logout', () => {
    const publicConfig = store.removeAccount(store.config.activeAccountId);
    syncFailures = 0;
    applyConfig();
    emitConfig();
    emitNote(store.noteSnapshot);
    emitStatus({ kind: 'idle', text: '未登录' });
    return publicConfig;
  });

  ipcMain.handle('verify:start', () => startVerification());

  ipcMain.handle('note:calibrate', (_, payload = {}) => {
    const max = Number(store.config.maxResin) || 200;
    const note = api.buildLocalNote(payload.resin, payload.nextInSeconds, max);
    const accountId = String(payload.accountId || '');
    // 多账号时按账号写入：只影响被校准的那个账号，其它账号继续各算各的
    if (accountId && store.accountById(accountId)) {
      store.setNoteFor(accountId, note);
    } else {
      store.setNote(note);
    }
    // 渲染层每个账号的数值来自 config.accounts[].note，必须一起重发，
    // 否则单账号 / 米游社模式下校准完界面还是旧值（看起来「没反应」）
    emitConfig();
    emitNote(store.noteSnapshot);
    emitStatus({ kind: 'local', text: '手动校准' });
    return { note, config: store.publicConfig };
  });

  ipcMain.on('window:fit-height', (_, height) => fitHeight(height));

  // 设置页 / 浮层打开或关闭：决定窗口是浮到前台还是回到桌面层
  ipcMain.on('window:surface', (_, interactive) => { setSurface(interactive); });

  // 钉在桌面后系统标题栏拖动失效，由渲染层发来屏幕坐标手动移动
  ipcMain.on('window:drag-start', (_, point) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    dragState = {
      sx: Number(point && point.x) || 0,
      sy: Number(point && point.y) || 0,
      wx: b.x, wy: b.y, w: b.width, h: b.height, area,
    };
  });
  ipcMain.on('window:drag-move', (_, point) => {
    if (!dragState || !win || win.isDestroyed()) return;
    const x = clamp(dragState.wx + ((Number(point && point.x) || 0) - dragState.sx),
      dragState.area.x, dragState.area.x + dragState.area.width - dragState.w);
    const y = clamp(dragState.wy + ((Number(point && point.y) || 0) - dragState.sy),
      dragState.area.y, dragState.area.y + dragState.area.height - dragState.h);
    suppressMoveSave = true;
    win.setBounds({ x, y, width: dragState.w, height: dragState.h });
  });
  ipcMain.on('window:drag-end', () => {
    if (!dragState) return;
    dragState = null;
    if (win && !win.isDestroyed()) {
      const b = win.getBounds();
      store.patch({ winX: b.x, winY: b.y });
    }
    setTimeout(() => { suppressMoveSave = false; }, 120);
  });

  // 渲染层切回主界面时，如果处于「临时提到前台」状态就重新钉回桌面
  ipcMain.on('window:view', (_, name) => {
    if (name === 'main') {
      surfaceInteractive = false;
      resumeDeskPin();
    }
  });

  ipcMain.on('window:action', (_, action) => {
    switch (action) {
      case 'hide': win.hide(); break;
      case 'quit': quitting = true; app.quit(); break;
      case 'settings': win.webContents.send('ui:settings'); break;
      case 'accounts': win.webContents.send('ui:accounts'); break;
      case 'scale-in': changeScale(clampScale(store.config.uiScale) + 0.05); break;
      case 'scale-out': changeScale(clampScale(store.config.uiScale) - 0.05); break;
      case 'scale-reset': changeScale(1); break;
      case 'refresh': syncNow(true); break;
      case 'toggle-pin': toggleLayer('deskPin'); break;
      case 'toggle-top': toggleLayer('alwaysOnTop'); break;
      default: break;
    }
  });
}

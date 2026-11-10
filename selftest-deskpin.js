'use strict';

/**
 * 桌面钉住自检：真实创建一个和小组件同规格的窗口，
 * 调用 assets/deskpin.ps1 把它挂到桌面层（Progman），
 * 验证：父窗口切换成功、钉住后仍可移动窗口、渲染没坏（capturePage 有内容），
 * 最后解除钉住并确认恢复成普通窗口。
 */
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const WIDTH = 344;
const HEIGHT = 292;
const SCRIPT = path.join(__dirname, 'assets', 'deskpin.ps1');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function run(action, hwnd) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Hwnd', hwnd, '-Action', action],
      { windowsHide: true, timeout: 40000 },
      (error, stdout, stderr) => {
        const out = String(stdout || '').trim();
        resolve({ ok: !error && out.startsWith('OK'), out: out || String(stderr || '').trim() });
      },
    );
  });
}

const num = (line, key) => {
  const m = new RegExp(`${key}=(-?\\d+)`).exec(line || '');
  return m ? Number(m[1]) : null;
};
const rectOf = (line) => {
  const m = /rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(line || '');
  return m ? m.slice(1).map(Number) : null;
};

app.on('window-all-closed', () => { /* 自检期间保持进程 */ });

app.whenReady().then(async () => {
  if (process.platform !== 'win32') {
    console.log('DESKPIN_SELFTEST=' + JSON.stringify({ ok: false, reason: 'windows-only' }));
    app.exit(0);
    return;
  }

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: 60,
    y: 60,
    frame: false,
    resizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  ipcMain.handle('state:get', () => ({
    config: { source: 'local', theme: 'gold', accounts: [], maxResin: 200 },
    note: null,
    status: { kind: 'local', text: '本地推算' },
  }));
  await win.loadFile(path.join(__dirname, 'src', 'index.html'));
  await wait(500);

  const buf = win.getNativeWindowHandle();
  const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));

  const before = await run('query', hwnd);
  const pin = await run('pin', hwnd);
  await wait(350);
  const pinned = await run('query', hwnd);

  // 钉住后按 Electron 的方式移动窗口，父窗口坐标系应与屏幕一致
  win.setBounds({ x: 300, y: 220, width: WIDTH, height: HEIGHT });
  await wait(350);
  const movedQuery = await run('query', hwnd);
  const movedRect = rectOf(movedQuery.out);
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  try { fs.writeFileSync(path.join(__dirname, 'selftest-deskpin.png'), image.toPNG()); } catch (_) { /* 仅留档 */ }

  const unpin = await run('unpin', hwnd);
  await wait(350);
  const restored = await run('query', hwnd);

  const parentOf = (line) => num(line, 'parent');
  const desktopParent = parentOf(pinned.out);
  const ok = pin.ok
    && unpin.ok
    && parentOf(before.out) !== desktopParent
    && desktopParent !== null
    && desktopParent !== 0
    && /child=True/.test(pinned.out)
    && parentOf(restored.out) === parentOf(before.out)
    && /child=False/.test(restored.out)
    && movedRect !== null
    && Math.abs(movedRect[0] - 300) <= 2
    && Math.abs(movedRect[1] - 220) <= 2
    && size.width > 0
    && size.height > 0;

  console.log('DESKPIN_SELFTEST=' + JSON.stringify({
    ok,
    hwnd,
    before: before.out,
    pin: pin.out,
    pinned: pinned.out,
    moved: movedQuery.out,
    unpin: unpin.out,
    restored: restored.out,
    shot: `${size.width}x${size.height}`,
  }));

  win.destroy();
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error('DESKPIN_FAILED', error);
  app.exit(1);
});

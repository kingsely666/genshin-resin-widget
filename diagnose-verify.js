'use strict';

/**
 * 诊断验证窗口：记录极验组件注入的 script src 与渲染结果。
 *   npm run diagnose:verify          假 gt，只验证组件链路（不触碰账号）
 *   npm run diagnose:verify -- --real 用真实账号下发 gt，确认滑块能否渲染
 * 输出只含字段名 / 长度 / 错误码，绝不打印 Cookie 或 token。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const REAL = process.argv.includes('--real');
const APP_DATA = process.env.APPDATA || app.getPath('appData');
const USER_DATA = path.join(APP_DATA, 'genshin-resin-widget');
try {
  app.setName('genshin-resin-widget');
  app.setPath('userData', USER_DATA);
} catch (_) { /* 某些版本需在 ready 前设置，失败则继续尝试 */ }

const FAKE = {
  gt: 'diagnostic_fake_gt', challenge: 'diagnostic_fake_challenge_0000',
  new_captcha: 1, success: 1,
};

function unseal(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('plain:')) return Buffer.from(value.slice(6), 'base64').toString('utf8');
  } catch (_) { /* 解密失败 */ }
  return '';
}

async function realInit() {
  const api = require('./src/api');
  const devicefp = require('./src/devicefp');
  const file = path.join(USER_DATA, 'widget-config.json');
  if (!fs.existsSync(file)) throw new Error('未找到配置，请先在桌面版扫码登录');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')).config || {};
  const cookie = unseal(data.cookieSealed);
  if (!cookie) throw new Error('凭证解密失败');
  let base = { ...data, cookie, maxResin: data.maxResin || 200 };
  if (!base.deviceFp) {
    const fp = await devicefp.acquireDeviceFp(base);
    base = {
      ...base,
      deviceFp: fp.deviceFp, fpSeed: fp.seed, fpTime: fp.time,
      deviceId: fp.deviceId || base.deviceId,
    };
  }
  const v = await api.createVerification(base, data.traceId || '');
  console.log(`DIAG_REAL_CREATE=${JSON.stringify({ gtLen: v.gt.length, challengeLen: v.challenge.length, newCaptcha: v.new_captcha })}`);
  return v;
}

app.whenReady().then(async () => {
  let initData = FAKE;
  if (REAL) {
    try {
      initData = await realInit();
    } catch (error) {
      console.log(`DIAG_REAL_FAILED=${error.message}`);
      app.exit(1);
      return;
    }
  }

  ipcMain.handle('verify:init:get', () => initData);
  ipcMain.handle('verify:retry', () => ({ ok: false, message: '诊断模式' }));

  const win = new BrowserWindow({
    width: 420, height: 400, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'verify-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(`
      window.__probe = [];
      new MutationObserver(function (muts) {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n && n.tagName === 'SCRIPT') window.__probe.push((n.src || '(inline)').slice(0, 120));
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
      void 0;
    `).catch(() => {});
  });

  await win.loadFile(path.join(__dirname, 'src', 'verify.html'));
  await new Promise((r) => setTimeout(r, REAL ? 9000 : 4000));

  const state = await win.webContents.executeJavaScript(`JSON.stringify({
    protocol: location.protocol,
    initGeetest: typeof window.initGeetest,
    status: document.getElementById('status').textContent,
    captchaChildren: document.getElementById('captcha').children.length,
    captchaHTML: document.getElementById('captcha').innerHTML.slice(0, 120),
    actionsHidden: document.getElementById('actions').hidden,
    probe: (window.__probe || []).slice(0, 6)
  })`);
  console.log(`DIAG_STATE=${state}`);
  app.exit(0);
}).catch((error) => {
  console.log(`DIAG_FAILED=${error.message}`);
  app.exit(1);
});

'use strict';

/**
 * 验证窗口自检（不依赖真实极验网络）：
 *  - preload 桥完整（getInit / onInit / submit / retry / close）
 *  - 本地极验 SDK 可用
 *  - 初始化配置强制 https:true（file:// 页面不加强制会卡死）
 *  - 滑块成功回调能触发 submit，状态文案正确流转
 *  - 无脚本错误
 */
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const INIT = {
  gt: 'FAKE_GT_FOR_SELFTEST', challenge: 'FAKE_CHALLENGE_FOR_SELFTEST',
  new_captcha: 1, success: 1,
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'verify-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  let submitted = null;
  // 让主动拉取返回空，由下面的 send 精确控制初始化时机
  ipcMain.handle('verify:init:get', () => null);
  ipcMain.handle('verify:retry', () => ({ ok: true }));
  ipcMain.on('verify:submit', (_, data) => { submitted = data; });
  win.webContents.on('console-message', (...args) => {
    const text = args.map((a) => {
      try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); } catch (_) { return '?'; }
    }).join(' | ');
    if (/Uncaught|TypeError|ReferenceError/.test(text)) errors.push(text);
  });

  await win.loadFile(path.join(__dirname, 'src', 'verify.html'));

  // 用假 captchaObj 替换极验组件，捕获传入配置并模拟滑块成功
  await win.webContents.executeJavaScript(`
    window.__geetestConfig = null;
    window.__fireSuccess = null;
    window.initGeetest = function (config, cb) {
      window.__geetestConfig = config;
      cb({
        appendTo: function () {},
        onReady: function (f) { f(); },
        onSuccess: function (f) { window.__fireSuccess = f; },
        onError: function () {},
        getValidate: function () {
          return { geetest_challenge: 'c', geetest_validate: 'v', geetest_seccode: 's' };
        }
      });
    };
    void 0;
  `);

  win.webContents.send('verify:init', INIT);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const before = await win.webContents.executeJavaScript(`({
    hasBridge: typeof window.verifyBridge === 'object'
      && ['getInit','onInit','onFailed','submit','retry','close'].every((k) => typeof window.verifyBridge[k] === 'function'),
    sdkLoaded: typeof window.initGeetest === 'function',
    localSdk: [...document.querySelectorAll('script[src]')].some((s) => /gt\\.0\\.4\\.9\\.js$/.test(s.src)),
    httpsForced: window.__geetestConfig ? window.__geetestConfig.https === true : false,
    gtPassed: window.__geetestConfig ? window.__geetestConfig.gt === 'FAKE_GT_FOR_SELFTEST' : false,
    status: document.getElementById('status').textContent,
    actionsHidden: document.getElementById('actions').hidden,
  })`);

  await win.webContents.executeJavaScript('window.__fireSuccess && window.__fireSuccess(); void 0;');
  await new Promise((resolve) => setTimeout(resolve, 200));

  const after = await win.webContents.executeJavaScript(`({
    status: document.getElementById('status').textContent,
  })`);

  // 重试：下发新的 challenge 后应重新初始化，而不是被去重逻辑挡住
  win.webContents.send('verify:init', { ...INIT, challenge: 'RETRY_CHALLENGE_FOR_SELFTEST' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const retry = await win.webContents.executeJavaScript(`({
    challenge: window.__geetestConfig ? window.__geetestConfig.challenge : null,
    status: document.getElementById('status').textContent,
    actionsHidden: document.getElementById('actions').hidden,
  })`);

  // 提交失败：窗口应保持打开并显示重试入口，而不是静默关闭
  win.webContents.send('verify:failed', '测试失败原因');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const failed = await win.webContents.executeJavaScript(`({
    status: document.getElementById('status').textContent,
    actionsHidden: document.getElementById('actions').hidden,
  })`);

  const ok = before.hasBridge
    && before.sdkLoaded
    && before.localSdk
    && before.httpsForced
    && before.gtPassed
    && /滑块/.test(before.status)
    && before.actionsHidden
    && /正在提交/.test(after.status)
    && submitted !== null
    && submitted.geetest_validate === 'v'
    && retry.challenge === 'RETRY_CHALLENGE_FOR_SELFTEST'
    && /滑块/.test(retry.status)
    && retry.actionsHidden
    && /验证未通过/.test(failed.status)
    && failed.actionsHidden === false
    && errors.length === 0;

  console.log('VERIFY_SELFTEST=' + JSON.stringify({ ok, before, after, retry, failed, submitted, errors }));
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error('VERIFY_SELFTEST_FAILED', error);
  app.exit(1);
});

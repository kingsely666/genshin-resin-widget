'use strict';

/**
 * 打包产物自检：启动 release/win-unpacked/ResinWidget.exe，
 * 用 CDP 检查渲染层是否正常、资源（assets）是否随包、图标是否生效。
 * 用法：node verify-packaged.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

// 打包目录可能是 release/（默认）或 out/（临时构建）
const BUILD_DIR = ['release', 'out']
  .map((d) => path.join(__dirname, d))
  .find((d) => fs.existsSync(path.join(d, 'win-unpacked', 'ResinWidget.exe'))) || path.join(__dirname, 'release');
const EXE = path.join(BUILD_DIR, 'win-unpacked', 'ResinWidget.exe');
const RESOURCES = path.join(BUILD_DIR, 'win-unpacked', 'resources');
const USER_DATA = path.join(os.tmpdir(), 'resin-widget-pkg-verify');
const PORT = 9444;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  return list.find((t) => t.type === 'page' && /index\.html|verify\.html/.test(t.url)) || null;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: done, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message));
        else done(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          id += 1;
          const messageId = id;
          ws.send(JSON.stringify({ id: messageId, method, params }));
          return new Promise((done, fail) => pending.set(messageId, { resolve: done, reject: fail }));
        },
        close: () => ws.close(),
      });
    });
  });
}

const evaluate = async (cdp, expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');
  return r.result.value;
};

(async () => {
  const result = { ok: false, checks: {} };
  const fail = (msg) => {
    result.ok = false;
    result.reason = msg;
    console.log('PKG=' + JSON.stringify(result, null, 2));
    process.exit(1);
  };

  if (!fs.existsSync(EXE)) fail('找不到打包产物：' + EXE);

  // 1. 静态结构：assets 必须是真实文件（PowerShell 进不了 asar）
  result.checks.asarExists = fs.existsSync(path.join(RESOURCES, 'app.asar'));
  result.checks.deskpinShipped = fs.existsSync(path.join(RESOURCES, 'assets', 'deskpin.ps1'));
  result.checks.gtShipped = fs.existsSync(path.join(RESOURCES, 'assets', 'gt.0.4.9.js'));
  result.checks.trayShipped = fs.existsSync(path.join(RESOURCES, 'assets', 'tray.png'));
  result.checks.exeBytes = fs.statSync(EXE).size;
  if (!result.checks.asarExists) fail('缺少 app.asar');
  if (!result.checks.deskpinShipped) fail('resources/assets 里没有 deskpin.ps1（桌面钉住会失效）');
  if (!result.checks.gtShipped) fail('resources/assets 里没有极验脚本');

  // 2. 真正启动打包版
  const env = { ...process.env, RESIN_WIDGET_NO_LOCK: '1', RESIN_WIDGET_TITLE: 'ResinWidgetPkgE2E' };
  // 工具环境里常带着 ELECTRON_RUN_AS_NODE，会让 exe 以 node 模式启动然后立刻退出
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
    cwd: path.dirname(EXE),
    env,
    stdio: 'ignore',
    windowsHide: false,
  });

  try {
    let target = null;
    for (let i = 0; i < 40; i += 1) {
      await wait(500);
      try {
        target = await cdpTarget();
      } catch (_) { /* devtools 还没起来 */ }
      if (target) break;
      if (app.exitCode !== null) fail('进程已退出 code=' + app.exitCode);
    }
    if (!target) fail('CDP 未就绪，页面没起来');
    result.checks.cdpReady = true;

    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    // 3. 渲染层是否真的画出来了
    const info = await evaluate(cdp, `(() => ({
      title: document.title,
      hasCard: !!document.querySelector('.ac-card, #soloCard'),
      bodyText: (document.body.innerText || '').slice(0, 160),
      cssVars: getComputedStyle(document.documentElement).getPropertyValue('--gold').trim(),
      preloadReady: typeof window.resinWidget === 'object',
      width: window.innerWidth,
      height: window.innerHeight,
      errCount: (window.__pkgErrors || []).length
    }))()`);
    Object.assign(result.checks, info);
    if (!info.hasCard) fail('主界面卡片没渲染出来');

    // 4. 主进程能力：配置读取 + assets 路径（钉桌脚本要能用真的路径打开）
    const st = await evaluate(cdp, `(async () => {
      try { const s = await window.resinWidget.getState(); return { ok: true, theme: s && s.config && s.config.theme, accounts: (s && s.config && s.config.accounts || []).length }; } catch (e) { return { ok: false, error: String(e) }; }
    })()`);
    result.checks.stateOk = Boolean(st && st.ok);
    result.checks.stateDetail = st;
    if (!st || !st.ok) fail('拿不到主进程状态：' + (st && st.error));

    // 5. 截图留证
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.join(__dirname, 'selftest-layer-shots'), { recursive: true });
    const shotPath = path.join(__dirname, 'selftest-layer-shots', 'pkg-main.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    result.checks.screenshot = shotPath;
    result.checks.hwnd = env.RESIN_WIDGET_TITLE;

    cdp.close();
    result.ok = true;
    console.log('PKG=' + JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    fail(error.message);
  } finally {
    try { app.kill(); } catch (_) { /* ignore */ }
    fs.rmSync(USER_DATA, { recursive: true, force: true });
  }
})();

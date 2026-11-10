'use strict';

/**
 * 真实进程的层级自检（端到端，CDP 驱动）：
 * 用独立的 user-data-dir 起一份真正的 src/main.js，通过 --remote-debugging-port
 * 在渲染层点按钮，再从外部用 Win32 查窗口状态，验证：
 *   钉在桌面 → 打开任何面板自动浮到前台（能输入）→ 回主界面自动钉回去 → 取消固定恢复普通窗口
 * 不碰用户自己的存档，也不需要人工点鼠标。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const electron = require('electron');

const SCRIPT = path.join(__dirname, 'assets', 'deskpin.ps1');
const SHOT_DIR = path.join(__dirname, 'selftest-layer-shots');
const USER_DATA = path.join(os.tmpdir(), 'resin-widget-layer-e2e');
const PORT = 9333;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(action, extra = []) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Action', action, ...extra],
      { windowsHide: true, timeout: 60000 },
      (error, stdout, stderr) => {
        const out = String(stdout || '').trim() || String(stderr || '').trim();
        resolve({ ok: !error && out.startsWith('OK'), out: out || (error && error.message) || '' });
      },
    );
  });
}

const findWindow = (pid) => ps('findpid', ['-Owner', String(pid)]);
const query = (hwnd) => ps('query', ['-Hwnd', hwnd]);
const field = (line, key) => {
  const m = new RegExp(`${key}=([^ ]+)`).exec(line || '');
  return m ? m[1] : null;
};

async function cdpTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  return list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || null;
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

(async () => {
  if (process.platform !== 'win32') {
    console.log('LAYER_E2E=' + JSON.stringify({ ok: false, reason: 'windows-only' }));
    return;
  }
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.RESIN_WIDGET_NO_LOCK = '1';
  const app = spawn(electron, ['src/main.js', `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`], {
    cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  });
  const appLog = [];
  app.stdout.on('data', (d) => appLog.push(String(d).trim()));
  app.stderr.on('data', (d) => appLog.push(String(d).trim()));

  const result = { ok: true, steps: [] };
  const fail = (why) => { result.ok = false; (result.fail ||= []).push(why); };
  const record = (step, out) => { result.steps.push({ step, out }); };

  try {
    let hwnd = null;
    for (let i = 0; i < 40; i += 1) {
      await wait(500);
      const r = await findWindow(app.pid);
      if (r.ok) { hwnd = field(r.out, 'hwnd'); break; }
    }
    if (!hwnd) throw new Error('找不到测试窗口 :: ' + appLog.join(' | '));
    result.hwnd = hwnd;
    await wait(1200);

    let target = null;
    for (let i = 0; i < 20; i += 1) {
      try { target = await cdpTarget(); } catch (_) { target = null; }
      if (target) break;
      await wait(500);
    }
    if (!target) throw new Error('CDP 连接不上 :: ' + appLog.join(' | '));
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const js = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
      return r.result && r.result.value;
    };
    const snap = async (name) => {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(shot.data, 'base64'));
    };

    record('boot', (await query(hwnd)).out);
    await snap('01-boot.png');

    // 冷启动没有数据会停在设置页：先回主界面
    await js(`document.getElementById('btnBack').click()`);
    await wait(900);
    record('back-to-main', (await query(hwnd)).out);
    await snap('02-main.png');

    // 点「钉」
    await js(`document.getElementById('btnPin').click()`);
    await wait(3500);
    const pinned = await query(hwnd);
    record('pinned', pinned.out);
    if (!/child=True/.test(pinned.out)) fail('点「钉」后窗口没有挂到桌面层');
    await snap('03-pinned.png');

    // 钉住后打开设置：必须浮到普通窗口层，否则输入框收不到键盘
    await js(`document.getElementById('btnSettings').click()`);
    await wait(3500);
    const floating = await query(hwnd);
    record('settings-open', floating.out);
    if (/child=True/.test(floating.out)) fail('打开设置后窗口仍挂在桌面层（无法输入）');
    if (!/topmost=True/.test(floating.out)) fail('打开设置后窗口没有提到前台');
    await snap('04-settings.png');

    // 设置页里的输入框应该真的能拿到焦点（子窗口是拿不到的）
    const focusOk = await js(`(() => {
      const input = document.getElementById('inMax');
      input.focus();
      return document.activeElement === input;
    })()`);
    record('input-focus', String(focusOk));
    if (!focusOk) fail('设置页输入框拿不到焦点');

    // 回主界面 → 自动钉回去
    await js(`document.getElementById('btnBack').click()`);
    await wait(3200);
    const backPinned = await query(hwnd);
    record('resume-pin', backPinned.out);
    if (!/child=True/.test(backPinned.out)) fail('回到主界面后没有重新钉回桌面');

    // 校准浮层：钉住状态下也要能打开、能输入、能改主界面数值
    await js(`document.getElementById('btnCalibrate').click()`);
    await wait(2400);
    record('calib-open', (await query(hwnd)).out);
    await js(`(() => {
      document.getElementById('inCalibResin').value = '77';
      document.getElementById('btnCalibSave').click();
    })()`);
    await wait(1200);
    const resinText = await js(`document.getElementById('resinValue').textContent`);
    record('resin-after-calib', resinText);
    if (resinText !== '77') fail(`校准后主界面显示 ${resinText}，期望 77`);
    await snap('05-calib.png');

    // 取消固定：必须回到普通窗口
    await js(`document.getElementById('btnPin').click()`);
    await wait(3500);
    const unpinned = await query(hwnd);
    record('unpin', unpinned.out);
    if (/child=True/.test(unpinned.out)) fail('取消固定后窗口仍挂在桌面层');

    cdp.close();
  } catch (error) {
    fail(error.message + (appLog.length ? ' :: ' + appLog.join(' | ') : ''));
  } finally {
    try { require('node:child_process').execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* ignore */ }
    await wait(400);
    console.log('LAYER_E2E=' + JSON.stringify(result));
  }
  process.exit(result.ok ? 0 : 1);
})();

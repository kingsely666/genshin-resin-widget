'use strict';
/**
 * 自检：验证页改由本地 http 承载后，极验组件是否仍能正常初始化。
 * 同时检查页面 Origin，以及极验 API 请求是否成功。
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA || '', 'genshin-resin-widget'));

const { Store } = require('./src/store');
const api = require('./src/api');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let pathname = '/';
      try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (_) { /* ignore */ }
      let file = '';
      if (pathname === '/' || pathname === '/verify.html') file = path.join(__dirname, 'src', 'verify.html');
      else if (pathname.startsWith('/assets/')) file = path.join(__dirname, 'assets', path.basename(pathname));
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
      const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

app.whenReady().then(async () => {
  const server = await startServer();
  const port = server.address().port;

  const store = new Store();
  const acc = store.accounts.find((a) => a.cookieSealed);
  if (!acc) {
    console.log(JSON.stringify({ ok: true, skipped: 'no-account' }));
    server.close();
    app.exit(0);
    return;
  }
  store.setActiveId(acc.id);
  const cfg = store.privateConfig;
  let verification = null;
  try {
    verification = await api.createVerification(cfg, cfg.traceId || '');
  } catch (error) {
    console.log(JSON.stringify({ ok: false, stage: 'create', message: error.message }));
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: 420, height: 520, show: false, frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  const netLog = [];
  session.defaultSession.webRequest.onCompleted({ urls: ['*://*.geetest.com/*', '*://*.geevisit.com/*'] }, (d) => {
    if (netLog.length < 8) netLog.push(`${d.method} ${d.statusCode} ${d.url.slice(0, 70)}`);
  });

  await win.loadURL(`http://127.0.0.1:${port}/verify.html`);
  const origin = await win.webContents.executeJavaScript('location.origin');

  const ready = await win.webContents.executeJavaScript(`new Promise(function (resolve) {
    var done = false;
    var finish = function (v) { if (!done) { done = true; resolve(v); } };
    setTimeout(function () { finish('timeout'); }, 14000);
    if (typeof window.initGeetest !== 'function') { finish('sdk-missing'); return; }
    try {
      window.initGeetest({
        gt: ${JSON.stringify(verification.gt)},
        challenge: ${JSON.stringify(verification.challenge)},
        new_captcha: true, https: true, offline: false, product: 'float', width: '100%'
      }, function (captcha) {
        captcha.appendTo('#captcha');
        captcha.onReady(function () { finish('ready'); });
        captcha.onError(function () { finish('error'); });
      });
    } catch (e) { finish('throw:' + e.message); }
  })`).catch((e) => `exec-fail:${e.message}`);

  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'selftest-verify-origin.png'), shot.toPNG());

  console.log(JSON.stringify({
    ok: ready === 'ready' && origin.startsWith('http://127.0.0.1'),
    origin, init: ready, net: netLog,
  }, null, 1));

  server.close();
  app.exit(0);
});

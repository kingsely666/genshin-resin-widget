// 用 Chromium 渲染 SVG 生成应用图标（512x512 PNG），供 electron-builder 转 ico。
// 用法：node start.js build-icon.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const OUT_DIR = path.join(__dirname, 'build');
const SIZE = 512;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  body{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center}
  svg{display:block}
</style></head><body>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#242b3a"/>
      <stop offset="55%" stop-color="#171d28"/>
      <stop offset="100%" stop-color="#0f131b"/>
    </linearGradient>
    <linearGradient id="resin" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#fbeecb"/>
      <stop offset="38%" stop-color="#f2d69b"/>
      <stop offset="72%" stop-color="#d9a95e"/>
      <stop offset="100%" stop-color="#b8843d"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e9c481" stop-opacity="0.85"/>
      <stop offset="50%" stop-color="#e9c481" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="#e9c481" stop-opacity="0.62"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.55">
      <stop offset="0" stop-color="#e9c481" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="#e9c481" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
  </defs>

  <rect x="10" y="10" width="492" height="492" rx="112" fill="url(#bg)"/>
  <rect x="10" y="10" width="492" height="492" rx="112" fill="url(#glow)"/>
  <rect x="16" y="16" width="480" height="480" rx="106" fill="none"
        stroke="url(#rim)" stroke-width="5"/>

  <g transform="translate(256 268) scale(0.845) translate(-256 -268)">
  <!-- 底部液面光弧 -->
  <path d="M150 358 A 106 60 0 0 0 362 358" fill="none" stroke="#e9c481"
        stroke-opacity="0.22" stroke-width="7" stroke-linecap="round"/>

  <!-- 树脂水滴 -->
  <g filter="url(#soft)" opacity="0.55">
    <path d="M256 106 C 316 190, 372 246, 372 306 A 116 116 0 0 1 140 306 C 140 246, 196 190, 256 106 Z"
          fill="#e9c481" opacity="0.30"/>
  </g>
  <path d="M256 106 C 316 190, 372 246, 372 306 A 116 116 0 0 1 140 306 C 140 246, 196 190, 256 106 Z"
        fill="url(#resin)"/>
  <!-- 高光 -->
  <ellipse cx="219" cy="292" rx="34" ry="52" fill="#ffffff" opacity="0.34"
           transform="rotate(-18 219 292)"/>
  <ellipse cx="300" cy="372" rx="52" ry="26" fill="#8a5f24" opacity="0.16"/>
  <!-- 顶部尖角反光 -->
  <path d="M256 128 C 240 164, 232 186, 240 200 C 250 186, 262 160, 268 138 Z"
        fill="#ffffff" opacity="0.45"/>
  </g>
</svg>
</body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  const out = path.join(OUT_DIR, 'icon.png');
  fs.writeFileSync(out, png);
  const size = img.getSize();
  console.log(JSON.stringify({ ok: true, file: out, bytes: png.length, size }, null, 2));
  win.destroy();
  app.quit();
});

app.on('window-all-closed', () => app.quit());

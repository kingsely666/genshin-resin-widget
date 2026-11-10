'use strict';

/** 无界面自检：加载预览页面，验证渲染、设置、校准、账号切换、缩放与扫码弹层 */
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

// 使用独立 userData，避免预览桥读到你之前保存的 localStorage 造成断言不稳定
app.setPath('userData', path.join(os.tmpdir(), 'genshin-resin-widget-selftest'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 344,
    height: 292,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.on('console-message', (...args) => {
    const text = args.map((a) => {
      try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); } catch (_) { return '?'; }
    }).join(' | ');
    if (/Uncaught|TypeError|ReferenceError/.test(text)) console.log('RENDERER_ERROR:', text);
  });
  await win.loadFile(path.join(__dirname, '界面预览.html'));
  // 清掉上一次自检留在 localStorage 里的预览状态，保证每次都是干净的初始场景
  await win.webContents.executeJavaScript('try { localStorage.clear(); } catch (e) {}');
  win.reload();
  await new Promise((resolve) => setTimeout(resolve, 1400));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const g = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = {
      resin: g('resinValue').textContent,
      max: g('resinMax').textContent,
      full: g('fullCountdown').textContent,
      next: g('nextCountdown').textContent,
      ringOffset: g('ringFg').style.strokeDashoffset,
      status: g('statusText').textContent,
    };

    // 账号入口：面板能打开，列出多个账号
    g('btnAccounts').click();
    const sheetOpen = !g('accountsSheet').hidden;
    const accountRows = g('accountListSheet').querySelectorAll('.acct-row').length;
    const accountBadge = g('accountCount').textContent;
    g('btnAccountsClose').click();
    const sheetClosed = g('accountsSheet').hidden;

    // 设置面板与数据源切换
    g('btnSettings').click();
    const settingsOpen = !g('viewSettings').hidden;
    document.querySelector('[data-source="mihoyo"]').click();
    const mihoyoPanelOpen = !g('panelMihoyo').hidden;
    const accountSectionShown = !g('accountSection').hidden;
    const qrButtonVisible = Boolean(g('btnQrLogin'));

    // 扫码弹层
    g('btnQrLogin').click();
    await wait(520);
    const qrOpen = !g('qrOverlay').hidden;
    const qrHasImage = Boolean(g('qrImage').getAttribute('src'));
    g('btnQrCancel').click();
    const qrClosed = g('qrOverlay').hidden;

    // 配色方案：6 个色块，点一下立即换色
    const themeDots = document.querySelectorAll('.theme-dot').length;
    document.querySelector('.theme-dot[data-theme="jade"]').click();
    await wait(120);
    const themeApplied = document.documentElement.dataset.theme;
    const themeActive = document.querySelector('.theme-dot.active')
      ? document.querySelector('.theme-dot.active').dataset.theme : '';
    document.querySelector('.theme-dot[data-theme="gold"]').click();
    await wait(120);

    // 保存 → 主界面变成账号并列卡片
    g('btnSave').click();
    await wait(420);
    const cards = Array.from(g('multiList').querySelectorAll('.ac-card'));
    const multiVisible = !g('multiList').hidden && g('soloCard').hidden;
    const cardCount = cards.length;
    const cardResins = cards.map((c) => c.querySelector('.ac-resin b').textContent);
    const classesBefore = cards.map((c) => c.className).join('|');
    if (cards[0]) cards[0].click();
    await wait(160);
    const classesAfter = cards.map((c) => c.className).join('|');
    const activeCards = g('multiList').querySelectorAll('.ac-card.is-active').length;

    // 「固定在桌面」按钮：预览里只切换状态与配置
    g('btnPin').click();
    await wait(150);
    const pinOn = g('btnPin').classList.contains('on');
    g('btnPin').click();
    await wait(150);
    const pinOff = !g('btnPin').classList.contains('on');

    // 切回本地推算再校准
    g('btnSettings').click();
    document.querySelector('[data-source="local"]').click();
    g('btnSave').click();
    await wait(420);
    const soloVisible = !g('soloCard').hidden && g('multiList').hidden;
    g('btnSettings').click();
    g('inResin').value = '60';
    g('btnApplyCalibrate').click();
    await wait(160);
    const afterCalibrate = g('resinValue').textContent;

    // 界面缩放：125% 后预览层应等比放大
    g('btnSettings').click();
    g('inScale').value = '125';
    g('inScale').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(360);
    const scaleText = g('btnScaleReset').textContent;
    const scaleTransform = getComputedStyle(g('widget')).transform;
    g('btnScaleReset').click();
    await wait(260);
    const scaleResetText = g('btnScaleReset').textContent;

    const hasVerifyButtons = Boolean(g('btnVerify') && g('btnVerifySettings') && g('riskBar'));
    g('btnVerify').click();
    await wait(60);
    const verifyToast = g('toast').textContent;
    g('btnBack').click();
    return {
      before, sheetOpen, accountRows, accountBadge, sheetClosed,
      settingsOpen, mihoyoPanelOpen, accountSectionShown, qrButtonVisible,
      qrOpen, qrHasImage, qrClosed,
      themeDots, themeApplied, themeActive,
      multiVisible, cardCount, cardResins, classesBefore, classesAfter, activeCards,
      pinOn, pinOff, soloVisible, afterCalibrate,
      scaleText, scaleTransform, scaleResetText,
      hasVerifyButtons, verifyToast,
      mainViewBack: !g('viewMain').hidden,
    };
  })()`);

  const ok = result.before.resin === '148'
    && result.before.max === '200'
    && /^\d{2}:\d{2}:\d{2}$/.test(result.before.full)
    && /^\d{2}:\d{2}$/.test(result.before.next)
    && Number(result.before.ringOffset) > 0
    && result.sheetOpen
    && result.accountRows >= 3
    && result.accountBadge === '3'
    && result.sheetClosed
    && result.settingsOpen
    && result.mihoyoPanelOpen
    && result.accountSectionShown
    && result.qrButtonVisible
    && result.qrOpen
    && result.qrHasImage
    && result.qrClosed
    && result.themeDots === 6
    && result.themeApplied === 'jade'
    && result.themeActive === 'jade'
    && result.multiVisible
    && result.cardCount === 3
    && result.cardResins.includes('62')
    && result.classesBefore === result.classesAfter
    && result.activeCards === 0
    && result.pinOn
    && result.pinOff
    && result.soloVisible
    && result.afterCalibrate === '60'
    && result.scaleText === '125%'
    && /1\.25/.test(result.scaleTransform)
    && result.scaleResetText === '100%'
    && result.hasVerifyButtons
    && /预览/.test(result.verifyToast)
    && result.mainViewBack;

  console.log('SELFTEST=' + JSON.stringify({ ok, ...result }));
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error('SELFTEST_FAILED', error);
  app.exit(1);
});

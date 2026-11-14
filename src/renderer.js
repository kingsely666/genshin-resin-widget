'use strict';

/* 界面逻辑：既可跑在 Electron 里，也可直接用浏览器打开预览 */
const hostBridge = (window.resinWidget && typeof window.resinWidget.getState === 'function')
  ? window.resinWidget
  : null;
const isPreview = hostBridge === null;
if (isPreview) document.documentElement.classList.add('preview');

const RESIN_SECONDS = 480;
const RING_CIRCUMFERENCE = 2 * Math.PI * 50;
const BASE_HEIGHT = 292;
const DEFAULT_MAX = 200;
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

const STATUS_COLORS = {
  ok: '#7fd6b0',
  local: '#e9c481',
  syncing: '#8fb8ee',
  error: '#f08a7a',
  uncalibrated: '#8f96a3',
  idle: '#8f96a3',
};

const SOURCE_LABELS = {
  local: '本地推算',
  mihoyo: '米游社同步',
  custom: '自定义接口',
};

const SOURCE_DESCS = {
  local: '零配置、零风险：填一次当前树脂，之后离线也能按每 8 分钟 1 点准确推算。',
  mihoyo: '扫码登录米游社后自动读取「实时便笺」，还能看到每日委托、探索派遣、周本折扣。',
  custom: '对接你自己的代理接口，适合已有云函数或开源实时便笺服务的场景。',
};

const THEMES = ['gold', 'frost', 'jade', 'sakura', 'violet', 'graphite'];
const THEME_DESCS = {
  gold: '金曜 · 枫丹晚霞般的暖金',
  frost: '晨霜 · 冷调冰蓝，长时间看不刺眼',
  jade: '翠玉 · 风元素的青绿',
  sakura: '樱花 · 淡粉，柔和一点',
  violet: '暮紫 · 雷元素的紫',
  graphite: '石墨 · 低调银灰，压得住深色壁纸',
};

let state = { config: null, note: null, status: { kind: 'idle', text: '' } };
let draftSource = 'local';
let toastTimer = null;
let scaleTimer = null;

/* ---------- 预览模式下的模拟桥 ---------- */
function buildLocalNote(resin, nextInSeconds, max) {
  const current = Math.max(0, Math.min(2000, Math.round(Number(resin) || 0)));
  const cap = Number(max) || 200;
  const points = Math.max(0, cap - current);
  let remaining = points * RESIN_SECONDS;
  if (points > 0 && nextInSeconds > 0 && nextInSeconds < RESIN_SECONDS) {
    remaining = (points - 1) * RESIN_SECONDS + Math.round(nextInSeconds);
  }
  return {
    currentResin: current,
    maxResin: cap,
    remainingSeconds: remaining,
    syncedAt: Date.now(),
    source: 'local',
    extra: null,
  };
}

/** 预览用的示意二维码（不可真实扫描） */
function fakeQrDataUrl() {
  const N = 25, cell = 5, padPx = 6, size = N * cell + padPx * 2;
  let seed = 20261111;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const finder = (x, y) => (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
  let rects = '';
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let on;
      if (finder(x, y)) {
        const lx = x >= N - 7 ? x - (N - 7) : x;
        const ly = y >= N - 7 ? y - (N - 7) : y;
        on = lx === 0 || lx === 6 || ly === 0 || ly === 6 || (lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4);
      } else {
        on = rnd() > 0.55;
      }
      if (on) rects += `<rect x="${padPx + x * cell}" y="${padPx + y * cell}" width="${cell}" height="${cell}"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#1b202b">${rects}</g></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// 纯浏览器打开 index.html 时用的演示数据，与任何真实账号无关
const PREVIEW_ACCOUNTS = [
  {
    id: 'preview-main', uid: '100000001', server: 'cn_gf01', nickname: '示例旅行者',
    label: '示例旅行者 · 100000001', loginMethod: 'qr', hasCookie: true, hasCredential: true,
    lastSyncAt: Date.now(), resin: 148, maxResin: 200, error: '',
    note: buildLocalNote(148, 137, 200),
  },
  {
    id: 'preview-alt', uid: '100000002', server: 'cn_gf01', nickname: '旅行者',
    label: '旅行者 · 100000002', loginMethod: 'qr', hasCookie: true, hasCredential: true,
    lastSyncAt: Date.now() - 3600 * 1000, resin: 62, maxResin: 200, error: '',
    note: buildLocalNote(62, 302, 200),
  },
  {
    id: 'preview-third', uid: '100000003', server: 'cn_gf01', nickname: '小号',
    label: '小号 · 100000003', loginMethod: 'qr', hasCookie: true, hasCredential: true,
    lastSyncAt: Date.now() - 7200 * 1000, resin: 191, maxResin: 200, error: '',
    note: buildLocalNote(191, 420, 200),
  },
];

function makePreviewBridge() {
  const KEY = 'genshin-resin-widget-preview';
  const listeners = {};
  let cfg;
  try {
    cfg = JSON.parse(localStorage.getItem(KEY)) || {};
  } catch (_) {
    cfg = {};
  }
  cfg = {
    source: 'local', maxResin: 200, notifyAt: 190, syncInterval: 300,
    server: 'cn_gf01', uid: '', customUrl: '', alwaysOnTop: true,
    deskPin: false, theme: 'gold',
    autoStart: false, hasCookie: false, hasCredential: false,
    loginMethod: '', accountLabel: '', uiScale: 1,
    activeAccountId: PREVIEW_ACCOUNTS[0].id,
    accounts: PREVIEW_ACCOUNTS.map((a) => ({ ...a })),
    ...cfg,
  };
  if (!Array.isArray(cfg.accounts) || !cfg.accounts.length) {
    cfg.accounts = PREVIEW_ACCOUNTS.map((a) => ({ ...a }));
    cfg.activeAccountId = cfg.accounts[0].id;
  }
  // 预览数据每次打开都重新计时，避免隔天看到「已回满」的假象
  cfg.accounts.forEach((acc) => {
    if (acc.resin == null) return;
    if (!acc.note || Date.now() - Number(acc.note.syncedAt || 0) > 300000) {
      acc.note = buildLocalNote(acc.resin, 137, acc.maxResin || 200);
    }
  });
  let note = buildLocalNote(148, 137, cfg.maxResin);
  const fire = (name, payload) => { if (listeners[name]) listeners[name](payload); };
  const persistPreview = () => {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) { /* file:// 下可能禁用 */ }
  };
  const activeOf = () => cfg.accounts.find((a) => a.id === cfg.activeAccountId) || null;
  const slim = () => {
    const active = activeOf();
    return {
      ...cfg,
      hasCookie: Boolean(active && active.hasCookie),
      hasCredential: Boolean(active && active.hasCredential),
      accountLabel: active ? active.label : '',
      loginMethod: active ? active.loginMethod : '',
      uid: active ? active.uid : cfg.uid,
    };
  };
  return {
    getState: async () => ({
      config: slim(),
      note,
      status: { kind: 'ok', text: '预览 · 模拟数据' },
    }),
    saveConfig: async (patch) => {
      cfg = { ...cfg, ...patch };
      persistPreview();
      return slim();
    },
    syncNow: async () => ({ ok: true }),
    calibrate: async (payload) => {
      const next = buildLocalNote(payload.resin, payload.nextInSeconds, cfg.maxResin);
      const target = payload.accountId
        ? cfg.accounts.find((a) => a.id === payload.accountId)
        : null;
      if (target) {
        target.note = next;
        target.resin = next.currentResin;
        target.lastSyncAt = Date.now();
        target.error = '';
        persistPreview();
        fire('config', slim());
      } else {
        note = next;
        fire('note', note);
      }
      return { note: next, config: slim() };
    },
    fetchRoles: async () => ({
      ok: true,
      roles: [{ uid: '100000001', server: 'cn_gf01', nickname: '旅行者（预览）', level: 60 }],
    }),
    qrStart: async () => {
      setTimeout(() => fire('qr', {
        phase: 'created',
        text: '预览模式 · 请用米游社 App 扫一扫',
        qrDataUrl: fakeQrDataUrl(),
        mode: 'preview',
      }), 350);
      return { ok: true, mode: 'preview' };
    },
    qrCancel: async () => ({ ok: true }),
    verifyStart: async () => ({ ok: false, message: '这是界面预览，运行桌面版后才能完成米游社验证' }),
    logout: async () => {
      const id = cfg.activeAccountId;
      cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
      if (!cfg.accounts.length) {
        cfg.activeAccountId = '';
        cfg.source = 'local';
      } else {
        cfg.activeAccountId = cfg.accounts[0].id;
      }
      persistPreview();
      fire('config', slim());
      return slim();
    },
    switchAccount: async (id) => {
      const acc = cfg.accounts.find((a) => a.id === id);
      if (!acc) return slim();
      cfg.activeAccountId = id;
      cfg.source = 'mihoyo';
      note = buildLocalNote(acc.resin ?? 0, 137, acc.maxResin || cfg.maxResin);
      persistPreview();
      fire('note', note);
      fire('config', slim());
      return slim();
    },    removeAccount: async (id) => {
      cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
      if (cfg.activeAccountId === id) {
        cfg.activeAccountId = cfg.accounts.length ? cfg.accounts[0].id : '';
        if (!cfg.accounts.length) cfg.source = 'local';
      }
      persistPreview();
      fire('config', slim());
      return slim();
    },
    updateAccount: async (id, patch) => {
      const acc = cfg.accounts.find((a) => a.id === id);
      if (acc) Object.assign(acc, patch);
      persistPreview();
      fire('config', slim());
      return slim();
    },
    setScale: async (value) => {
      const n = Math.max(0.7, Math.min(1.8, Number(value) || 1));
      cfg.uiScale = Math.round(n * 100) / 100;
      persistPreview();
      fire('config', slim());
      return { ok: true, uiScale: cfg.uiScale };
    },
    fitHeight: (height) => {
      const h = Math.max(200, Math.round(Number(height) || BASE_HEIGHT));
      document.documentElement.style.setProperty('--preview-height', `${h}px`);
    },
    setView: () => {},
    setSurface: () => {},
    dragStart: () => {},
    dragMove: () => {},
    dragEnd: () => {},
    windowAction: (action) => {
      if (action === 'toggle-pin') {
        cfg.deskPin = !cfg.deskPin;
        if (cfg.deskPin) cfg.alwaysOnTop = false;
        persistPreview();
        fire('config', slim());
        toast(cfg.deskPin ? '预览 · 已固定在桌面（桌面版会真正贴到壁纸层）' : '预览 · 已取消桌面固定');
        return;
      }
      if (action === 'toggle-top') {
        cfg.alwaysOnTop = !cfg.alwaysOnTop;
        if (cfg.alwaysOnTop) cfg.deskPin = false;
        persistPreview();
        fire('config', slim());
        toast(cfg.alwaysOnTop ? '预览 · 已置顶' : '预览 · 已取消置顶');
        return;
      }
      toast('这是界面预览，运行桌面版后按钮才会生效');
    },
    onNote: (cb) => { listeners.note = cb; },
    onStatus: () => {},
    onSettings: () => {},
    onConfig: (cb) => { listeners.config = cb; },
    onQrUpdate: (cb) => { listeners.qr = cb; },
    onQrRequest: () => {},
    onAccountsRequest: (cb) => { listeners.accounts = cb; },
    onToast: () => {},
  };
}

const bridge = hostBridge || makePreviewBridge();

/* ---------- 时间计算 ---------- */
function compute(note, now) {
  if (!note) return null;
  const elapsed = Math.max(0, (now - note.syncedAt) / 1000);
  const remaining = Math.max(0, note.remainingSeconds - elapsed);
  const max = Number(note.maxResin) || 200;
  const current = remaining <= 0
    ? Math.max(max, Number(note.currentResin) || 0)
    : Math.max(0, max - Math.ceil(remaining / RESIN_SECONDS));
  const nextIn = remaining <= 0 ? 0 : (Math.ceil(remaining) % RESIN_SECONDS || RESIN_SECONDS);
  return {
    current, max, remaining, nextIn,
    fullAt: new Date(now + remaining * 1000),
  };
}

function formatHMS(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function formatMS(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function formatClock(date) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400000);
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}

function parseNext(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  if (value.includes(':')) {
    const parts = value.split(':').map((n) => Number(n));
    if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* ---------- 渲染 ---------- */
let multiRefs = [];
let multiSignature = '';

function initialOf(acc) {
  const text = String(acc?.nickname || acc?.label || acc?.uid || '?').trim();
  return text.slice(0, 1) || '?';
}

function syncAgoText(acc) {
  if (!acc) return '';
  if (acc.error) return '同步异常';
  const at = Number(acc.lastSyncAt) || 0;
  if (!at) return '未同步';
  const diff = Math.max(0, Date.now() - at) / 1000;
  if (diff < 60) return '刚刚同步';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

/** 多账号：每张卡片一套独立引用，每秒只更新数值，避免整块重建 */
function buildMultiList(accounts) {
  const host = $('multiList');
  if (!host) return;
  host.textContent = '';
  multiRefs = accounts.map((acc) => {
    const card = document.createElement('article');
    card.className = 'ac-card';
    card.dataset.id = acc.id;
    card.innerHTML = [
      '<div class="ac-head">',
      '  <span class="ac-avatar"></span>',
      '  <span class="ac-id"><span class="ac-name"></span><span class="ac-uid"></span></span>',
      '  <button class="ac-calib" type="button" title="手动校准这个账号">✎</button>',
      '  <span class="ac-resin"><b>--</b><small>/200</small></span>',
      '</div>',
      '<div class="ac-bar"><i></i></div>',
      '<div class="ac-meta">',
      '  <span class="ac-full">回满 <b>--:--:--</b></span>',
      '  <span class="ac-next">下一枚 <b>--:--</b></span>',
      '  <span class="ac-extra" hidden></span>',
      '  <span class="ac-err" hidden></span>',
      '</div>',
    ].join('');
    const pick = (sel) => card.querySelector(sel);
    const calibBtn = pick('.ac-calib');
    calibBtn.onclick = (event) => {
      event.stopPropagation();
      openCalib(acc.id);
    };
    const refs = {
      id: acc.id,
      card,
      avatar: pick('.ac-avatar'),
      name: pick('.ac-name'),
      uid: pick('.ac-uid'),
      resin: pick('.ac-resin b'),
      max: pick('.ac-resin small'),
      bar: pick('.ac-bar i'),
      full: pick('.ac-full b'),
      next: pick('.ac-next b'),
      extra: pick('.ac-extra'),
      err: pick('.ac-err'),
    };
    refs.avatar.textContent = initialOf(acc);
    refs.name.textContent = acc.nickname || acc.label || '米游社账号';
    refs.uid.textContent = acc.uid ? `UID ${acc.uid}` : '未读取到 UID';
    refs.max.textContent = `/${acc.maxResin || DEFAULT_MAX}`;
    host.appendChild(card);
    return refs;
  });
}

function updateMultiList(accounts, notifyAt, now) {
  multiRefs.forEach((refs) => {
    const acc = accounts.find((a) => a.id === refs.id);
    if (!acc) return;
    const c = compute(acc.note, now);
    if (!c) {
      refs.resin.textContent = '--';
      refs.full.textContent = '--:--:--';
      refs.next.textContent = '--:--';
      refs.bar.style.width = '0%';
      refs.card.classList.remove('is-overflow');
    } else {
      refs.resin.textContent = String(c.current);
      refs.max.textContent = `/${c.max}`;
      refs.full.textContent = c.remaining > 0 ? formatHMS(c.remaining) : '已回满';
      refs.next.textContent = c.remaining > 0 ? formatMS(c.nextIn) : '—';
      refs.bar.style.width = `${Math.min(100, Math.round((c.current / c.max) * 100))}%`;
      refs.card.classList.toggle('is-overflow', c.current >= notifyAt);
    }
    const extra = acc.note?.extra;
    if (extra) {
      refs.extra.hidden = false;
      refs.extra.textContent = `委托 ${extra.task} · 派遣 ${extra.expedition} · 周本 ${extra.discount}`;
    } else {
      refs.extra.hidden = true;
    }
    refs.err.hidden = !acc.error;
    if (acc.error) refs.err.textContent = /1034/.test(acc.error) ? '待 App 处理' : '同步异常';
  });
}

/** 内容高度变化后通知主进程调整窗口，保证多账号不会被裁掉 */
let lastReportedHeight = 0;
function reportHeight() {
  const body = $('mainBody');
  const view = $('viewMain');
  if (!body || !view) return;
  const padBottom = parseFloat(getComputedStyle(view).paddingBottom) || 0;
  const target = view.hidden
    ? BASE_HEIGHT
    : Math.ceil(38 + body.offsetTop + body.offsetHeight + padBottom);
  if (Math.abs(target - lastReportedHeight) < 1) return;
  lastReportedHeight = target;
  if (bridge.fitHeight) bridge.fitHeight(target);
}

/* ---------- 配色方案 ---------- */
let currentTheme = '';
function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : 'gold';
  if (theme === currentTheme) return;
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('.theme-dot').forEach((dot) => {
    dot.classList.toggle('active', dot.dataset.theme === theme);
  });
  const desc = $('themeDesc');
  if (desc) desc.textContent = THEME_DESCS[theme] || '';
}

/** 窗口层级只在桌面/置顶两种状态间切换，界面上的勾选要跟着变 */
function syncLayerUI(cfg) {
  const pinned = Boolean(cfg.deskPin);
  const top = Boolean(cfg.alwaysOnTop) && !pinned;
  const pinBtn = $('btnPin');
  if (pinBtn) {
    pinBtn.classList.toggle('on', pinned);
    pinBtn.title = pinned ? '已固定在桌面（点击取消）' : '固定在桌面';
  }
  const pinInput = $('inDeskPin');
  if (pinInput && pinInput.checked !== pinned) pinInput.checked = pinned;
  const topInput = $('inTop');
  if (topInput && topInput.checked !== top) topInput.checked = top;
}

function render() {
  const cfg = state.config || {};
  const status = state.status || { kind: 'idle', text: '' };
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const active = accounts.find((a) => a.id === cfg.activeAccountId) || null;
  const source = cfg.source || 'local';
  const multi = source === 'mihoyo' && accounts.length > 1;
  const now = Date.now();
  const notifyAt = Number(cfg.notifyAt) || 190;

  applyTheme(cfg.theme);
  syncLayerUI(cfg);

  $('statusText').textContent = status.text || SOURCE_LABELS[source] || '—';
  $('statusDot').style.background = STATUS_COLORS[status.kind] || STATUS_COLORS.idle;
  $('statusDot').style.color = STATUS_COLORS[status.kind] || STATUS_COLORS.idle;

  const needVerify = Boolean(status.needVerify) || /1034/.test(status.text || '');
  // 5003 = 服务端设备层拒绝：滑块验证与重新登录都不能解除，只能靠本地校准兜底
  const blocked = Boolean(status.blocked) || /5003/.test(status.text || '');
  const hasRisk = status.kind === 'error'
    && (blocked || needVerify || /风控|指纹|验证/.test(status.text || ''));
  const riskMessage = status.text || '米游社接口返回异常，请稍后重试';
  $('riskTip').hidden = !hasRisk;
  $('riskBar').hidden = !hasRisk;
  if (blocked) {
    $('riskText').textContent = '⚠ 米游社已限制本机读取实时便笺（5003）。这是服务端设备校验层的拒绝，重新登录、滑块验证、换指纹都无法解除。点「手动校准」填一次当前树脂，之后按 8 分钟 1 点本地推算，倒计时与溢出提醒仍然准确。';
  } else {
    $('riskText').textContent = needVerify
      ? `⚠ ${riskMessage}。滑块验证目前多半会被服务端直接拒绝，建议先在 App 内打开一次实时便笺，再点「重新检测」。`
      : `⚠ ${riskMessage}`;
  }
  $('riskBarText').textContent = blocked
    ? '米游社限制读取 · 点「校准」填当前树脂'
    : (needVerify ? '请先在米游社 App 打开一次实时便笺' : riskMessage);
  // 标题栏空间有限，风控时用短标签，完整说明留给提示条
  if (hasRisk) $('statusText').textContent = blocked ? '受限' : (needVerify ? '风控中' : '同步异常');
  // 5003 时滑块验证没有意义，避免用户白跑一趟
  if ($('btnVerify')) $('btnVerify').hidden = blocked;
  if ($('btnVerifySettings')) $('btnVerifySettings').hidden = blocked;
  if ($('btnRiskCalib')) $('btnRiskCalib').hidden = !blocked;

  $('sourceTag').textContent = isPreview
    ? '界面预览'
    : (multi ? `${SOURCE_LABELS[source]} · ${accounts.length} 账号` : SOURCE_LABELS[source]);

  $('soloCard').hidden = multi;
  $('multiList').hidden = !multi;
  $('extraRow').hidden = multi;
  $('btnAddAccountMain').hidden = source !== 'mihoyo';
  // 手动校准是风控期间唯一稳的兜底，所有数据来源都随时可用
  $('btnCalibrate').hidden = false;
  // 钉在桌面时窗口是桌面子窗口，系统标题栏拖动会失效，切到手动拖动
  document.documentElement.dataset.pinned = cfg.deskPin ? '1' : '0';

  if (multi) {
    const signature = accounts.map((a) => a.id).join(',');
    if (signature !== multiSignature) {
      multiSignature = signature;
      buildMultiList(accounts);
    }
    updateMultiList(accounts, notifyAt, now);
  } else if (multiSignature) {
    multiSignature = '';
    multiRefs = [];
    $('multiList').textContent = '';
  }

  // 单账号用当前快照；多账号时每张卡片各用自己的快照
  const note = (source === 'mihoyo' && active) ? active.note : state.note;
  const c = compute(note, now);

  if (!multi) {
    const showHead = source === 'mihoyo' && Boolean(active);
    $('soloHead').hidden = !showHead;
    if (showHead) {
      $('soloAvatar').textContent = initialOf(active);
      $('soloName').textContent = active.nickname || active.label || '米游社账号';
      $('soloUid').textContent = active.uid ? `UID ${active.uid}` : '未读取到 UID';
      $('soloSync').textContent = syncAgoText(active);
    }
  }

  // 溢出提醒：多账号时按账号数量统计
  const notesToCheck = (source === 'mihoyo' && accounts.length)
    ? accounts.map((a) => a.note)
    : [state.note];
  const overflowCount = notesToCheck.reduce((sum, item) => {
    const itemCalc = item ? compute(item, now) : null;
    return sum + (itemCalc && itemCalc.current >= notifyAt ? 1 : 0);
  }, 0);
  $('widget').classList.toggle('is-overflow', overflowCount > 0);
  $('overflowAlert').hidden = overflowCount === 0;
  if (overflowCount) {
    $('overflowAlert').textContent = multi
      ? `⚠ ${overflowCount} 个账号树脂即将溢出，记得上线消耗`
      : '⚠ 树脂即将溢出，记得上线消耗';
  }

  if (!c) {
    if (!multi) {
      $('resinValue').textContent = '--';
      $('resinMax').textContent = cfg.maxResin || DEFAULT_MAX;
      $('fullCountdown').textContent = '--:--:--';
      $('fullClock').textContent = '请先校准';
      $('nextCountdown').textContent = '--:--';
      $('ringFg').style.strokeDashoffset = RING_CIRCUMFERENCE;
      $('extraRow').classList.add('dim');
      $('localHint').hidden = false;
    }
    reportHeight();
    return;
  }

  if (!multi) {
    $('resinValue').textContent = c.current;
    $('resinMax').textContent = c.max;
    $('fullCountdown').textContent = c.remaining > 0 ? formatHMS(c.remaining) : '已回满';
    $('fullClock').textContent = c.remaining > 0 ? formatClock(c.fullAt) : '—';
    $('nextCountdown').textContent = c.remaining > 0 ? formatMS(c.nextIn) : '—';

    const ratio = Math.min(1, c.current / c.max);
    $('ringFg').style.strokeDashoffset = (RING_CIRCUMFERENCE * (1 - ratio)).toFixed(2);

    const hasExtra = Boolean(note.extra);
    $('extraRow').classList.toggle('dim', !hasExtra);
    $('taskValue').textContent = hasExtra ? note.extra.task : '--';
    $('expeditionValue').textContent = hasExtra ? note.extra.expedition : '--';
    $('discountValue').textContent = hasExtra ? note.extra.discount : '--';

    $('localHint').hidden = source !== 'local' && hasExtra;
  } else {
    $('extraRow').classList.remove('dim');
    $('localHint').hidden = true;
  }

  reportHeight();
}

/* ---------- 多账号 ---------- */
function renderAccountList(container, accounts) {
  if (!container) return;
  container.textContent = '';
  if (!accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'acct-empty';
    empty.textContent = '还没有账号。点下方按钮扫码登录，可同时保存多个米游社账号一起显示。';
    container.appendChild(empty);
    return;
  }
  accounts.forEach((acc) => {
    const row = document.createElement('div');
    row.className = 'acct-row';
    row.dataset.accountId = acc.id;

    const avatar = document.createElement('span');
    avatar.className = 'acct-avatar';
    const initial = String(acc.nickname || acc.label || acc.uid || '?').trim().slice(0, 1);
    avatar.textContent = initial || '?';

    const info = document.createElement('span');
    info.className = 'acct-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'acct-name';
    nameEl.textContent = acc.label || acc.nickname || (acc.uid ? `账号 ${acc.uid}` : '米游社账号');
    const metaEl = document.createElement('span');
    metaEl.className = 'acct-meta';
    metaEl.textContent = acc.uid ? `UID ${acc.uid}` : '未读取到 UID';
    info.append(nameEl, metaEl);

    const resinEl = document.createElement('span');
    resinEl.className = 'acct-resin';
    resinEl.textContent = acc.resin != null ? `${acc.resin}/${acc.maxResin || 200}` : '--';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'acct-del';
    del.title = '移除该账号';
    del.textContent = '×';
    del.onclick = (event) => { event.stopPropagation(); removeAccount(acc.id); };

    row.append(avatar, info, resinEl, del);
    container.appendChild(row);
  });
}

function renderAccountUI() {
  const cfg = state.config || {};
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];

  const badge = $('accountCount');
  badge.hidden = accounts.length === 0;
  badge.textContent = String(accounts.length);

  $('accountSection').hidden = accounts.length === 0;
  $('accountTotal').textContent = accounts.length ? `${accounts.length} 个` : '';
  renderAccountList($('accountListSettings'), accounts);
  renderAccountList($('accountListSheet'), accounts);

  $('btnQrLogin').textContent = accounts.length ? '＋ 添加账号（扫码登录）' : '扫码登录米游社';
  $('btnLogout').hidden = true;
  updateAccountCard();
}

function showAccountsSheet() {
  renderAccountUI();
  $('accountsSheet').hidden = false;
  refreshSurface();
}

function hideAccountsSheet() {
  $('accountsSheet').hidden = true;
  refreshSurface();
}

/* ---------- 手动校准浮层 ---------- */
let calibAccountId = '';

/** 校准返回值兼容两种形状：{note, config} 或直接给 note */
function applyCalibrateResult(result) {
  if (!result) return null;
  const packed = result.note || result.config;
  const note = packed ? (result.note || null) : result;
  const config = result.config || null;
  if (config) state.config = { ...state.config, ...config };
  if (note) state.note = note;
  return note;
}

/** 界面是否有一层「需要键盘输入」的面板打开：决定窗口要不要浮到前台 */
let lastSurface = null;
function refreshSurface() {
  const interactive = !$('viewSettings')?.hidden
    || !$('accountsSheet')?.hidden
    || !$('qrOverlay')?.hidden
    || !$('calibSheet')?.hidden;
  document.documentElement.dataset.interactive = interactive ? '1' : '0';
  if (interactive === lastSurface) return;
  lastSurface = interactive;
  if (bridge.setSurface) bridge.setSurface(interactive);
}

function calibAccounts() {
  const cfg = state.config || {};
  return cfg.source === 'mihoyo' ? (cfg.accounts || []) : [];
}

function calibAccount() {
  return calibAccounts().find((a) => a.id === calibAccountId) || null;
}

function renderCalibAccounts() {
  const host = $('calibAccounts');
  const accounts = calibAccounts();
  host.textContent = '';
  host.hidden = accounts.length <= 1;
  if (accounts.length <= 1) return;
  accounts.forEach((acc) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'calib-account';
    btn.dataset.id = acc.id;
    btn.textContent = acc.label || acc.nickname || acc.uid || '账号';
    btn.classList.toggle('active', acc.id === calibAccountId);
    btn.onclick = () => {
      calibAccountId = acc.id;
      renderCalibAccounts();
      fillCalibValues();
      $('inCalibResin').focus();
      $('inCalibResin').select();
    };
    host.appendChild(btn);
  });
}

function renderCalibChips() {
  const host = $('calibChips');
  const cfg = state.config || {};
  const acc = calibAccount();
  const max = Number(acc?.maxResin) || Number(cfg.maxResin) || DEFAULT_MAX;
  host.textContent = '';
  [0, 20, 40, 80, 120, 160, max].forEach((value, index, list) => {
    if (list.indexOf(value) !== index) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'calib-chip';
    btn.textContent = value === max ? `满 ${max}` : String(value);
    btn.onclick = () => {
      $('inCalibResin').value = String(value);
      $('inCalibNext').value = value >= max ? '' : $('inCalibNext').value;
      $('inCalibResin').focus();
    };
    host.appendChild(btn);
  });
}

function fillCalibValues() {
  const cfg = state.config || {};
  const acc = calibAccount();
  $('calibTitle').textContent = acc
    ? `校准 · ${acc.label || acc.nickname || acc.uid || '米游社账号'}`
    : '手动校准';
  $('calibDesc').textContent = acc
    ? '按游戏内该账号的实际树脂填写。保存后先按本地推算，下次同步成功会以米游社数据为准。'
    : '按游戏内实际数值填写即可。保存后按每 8 分钟 1 点自动推算，关机重开也会接着算。';
  const note = acc ? acc.note : state.note;
  const c = compute(note, Date.now());
  $('inCalibResin').value = c ? String(c.current) : '';
  $('inCalibNext').value = '';
}

function openCalib(accountId) {
  const cfg = state.config || {};
  const accounts = calibAccounts();
  if (accounts.length) {
    const wanted = accounts.find((a) => a.id === accountId);
    const fallback = accounts.find((a) => a.id === cfg.activeAccountId) || accounts[0];
    calibAccountId = (wanted || fallback).id;
  } else {
    calibAccountId = '';
  }
  renderCalibAccounts();
  renderCalibChips();
  fillCalibValues();
  $('calibSheet').hidden = false;
  refreshSurface();
  requestAnimationFrame(() => {
    const input = $('inCalibResin');
    input.focus();
    input.select();
  });
}

function closeCalib() {
  $('calibSheet').hidden = true;
  refreshSurface();
  render();
}

async function saveCalib() {
  const raw = String($('inCalibResin').value || '').trim();
  const resin = Number(raw);
  if (!raw || !Number.isFinite(resin) || resin < 0) {
    toast('请填写当前树脂数量');
    $('inCalibResin').focus();
    return;
  }
  const acc = calibAccount();
  const result = await bridge.calibrate({
    resin,
    nextInSeconds: parseNext($('inCalibNext').value),
    accountId: acc ? acc.id : '',
  });
  applyCalibrateResult(result);
  $('calibSheet').hidden = true;
  refreshSurface();
  renderAccountUI();
  render();
  toast(acc
    ? `已校准「${acc.label || acc.nickname || acc.uid}」，之后按 8 分钟 1 点推算`
    : '已校准，之后会自动按 8 分钟 1 点增长');
}

function applyPreviewScale() {
  if (!isPreview) return;
  const scale = Number(state.config?.uiScale) || 1;
  document.documentElement.style.setProperty('--preview-scale', String(scale));
}

async function removeAccount(id) {
  const accounts = state.config?.accounts || [];
  const target = accounts.find((a) => a.id === id);
  if (!target) return;
  if (!isPreview) {
    const name = target.label || target.nickname || target.uid || '该账号';
    const confirmed = window.confirm(`移除「${name}」？\n本机保存的登录凭证会一并清除，其他账号不受影响。`);
    if (!confirmed) return;
  }
  const cfg = await bridge.removeAccount(id);
  if (!cfg) return;
  state.config = { ...state.config, ...cfg };
  state.note = cfg.note ?? null;
  const remain = (cfg.accounts || []).length;
  state.status = { kind: remain ? 'ok' : 'idle', text: remain ? '已切换账号' : '未登录' };
  render();
  renderAccountUI();
  toast(remain ? '已移除账号' : '已移除账号，可在设置里重新扫码登录');
}

/* ---------- 界面缩放 ---------- */
function updateScaleUI() {
  const scale = Number(state.config?.uiScale) || 1;
  const pct = Math.max(70, Math.min(180, Math.round(scale * 100)));
  const range = $('inScale');
  if (range) {
    range.value = String(pct);
    range.style.setProperty('--pct', `${((pct - 70) / (180 - 70)) * 100}%`);
  }
  const reset = $('btnScaleReset');
  if (reset) reset.textContent = `${pct}%`;
  applyPreviewScale();
}

async function setScale(pct) {
  const value = Math.max(0.7, Math.min(1.8, (Number(pct) || 100) / 100));
  state.config = { ...state.config, uiScale: value };
  updateScaleUI();
  const result = await bridge.setScale(value);
  if (result && result.uiScale) {
    state.config.uiScale = result.uiScale;
    updateScaleUI();
  }
}

/* ---------- 设置面板 ---------- */
function showView(name) {
  $('viewMain').hidden = name !== 'main';
  $('viewSettings').hidden = name !== 'settings';
  if (name === 'settings') updateSourcePanel();
  refreshSurface();
  lastReportedHeight = 0; // 视图切换后高度基准变化，强制重新上报
  requestAnimationFrame(reportHeight);
  if (bridge.setView) bridge.setView(name);
}

function updateSourcePanel() {
  document.querySelectorAll('.seg').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.source === draftSource);
  });
  $('panelLocal').hidden = draftSource !== 'local';
  $('panelMihoyo').hidden = draftSource !== 'mihoyo';
  $('panelCustom').hidden = draftSource !== 'custom';
  $('sourceDesc').textContent = SOURCE_DESCS[draftSource];
}

function updateAccountCard() {
  const c = state.config || {};
  const accounts = Array.isArray(c.accounts) ? c.accounts : [];
  const logged = accounts.filter((a) => a.hasCookie);

  $('accountLabel').textContent = logged.length
    ? (logged.length === 1
      ? (logged[0].label || logged[0].nickname || '已登录米游社')
      : `已登录 ${logged.length} 个米游社账号`)
    : '未登录';
  $('accountSub').textContent = logged.length
    ? '所有账号同时显示在主页，各自独立同步'
    : '扫码登录后可自动同步';
  $('btnLogout').hidden = true;
  $('cookieState').textContent = logged.length ? '已保存' : '未填写';
}

function fillSettings() {
  const c = state.config;
  draftSource = c.source || 'local';
  $('inServer').value = c.server || 'cn_gf01';
  $('inUid').value = c.uid || '';
  $('inCustomUrl').value = c.customUrl || '';
  $('inMax').value = c.maxResin || 200;
  $('inNotify').value = c.notifyAt || 190;
  $('inInterval').value = c.syncInterval || 300;
  $('inDeskPin').checked = Boolean(c.deskPin);
  $('inTop').checked = Boolean(c.alwaysOnTop) && !c.deskPin;
  $('inAutoStart').checked = Boolean(c.autoStart);
  $('inCookie').value = '';
  const current = compute(state.note, Date.now());
  $('inResin').value = current ? current.current : '';
  applyTheme(c.theme);
  renderAccountUI();
  updateScaleUI();
  updateSourcePanel();
}

function collectConfig() {
  const patch = {
    source: draftSource,
    maxResin: Math.max(1, Number($('inMax').value) || 200),
    notifyAt: Math.max(1, Number($('inNotify').value) || 190),
    syncInterval: Math.max(180, Number($('inInterval').value) || 300),
    alwaysOnTop: $('inTop').checked,
    deskPin: $('inDeskPin').checked,
    theme: currentTheme || state.config?.theme || 'gold',
    autoStart: $('inAutoStart').checked,
    server: $('inServer').value,
    uid: $('inUid').value.trim(),
    customUrl: $('inCustomUrl').value.trim(),
  };
  const cookie = $('inCookie').value.trim();
  if (cookie) patch.cookie = cookie;
  return patch;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------- 扫码登录弹层 ---------- */
function showQr() {
  $('qrOverlay').hidden = false;
  $('qrStatusText').textContent = '正在生成二维码…';
  $('qrMode').textContent = '';
  $('qrCover').hidden = true;
  $('qrImage').removeAttribute('src');
  refreshSurface();
}

function hideQr() {
  $('qrOverlay').hidden = true;
  refreshSurface();
}

async function beginQrLogin() {
  showQr();
  const result = await bridge.qrStart();
  if (result && result.ok === false) toast(result.message || '二维码生成失败');
}

function handleQrUpdate(payload) {
  if (!payload) return;
  if (payload.phase === 'idle') { hideQr(); return; }
  $('qrOverlay').hidden = false;
  refreshSurface();
  if (payload.qrDataUrl) $('qrImage').src = payload.qrDataUrl;
  if (payload.text) $('qrStatusText').textContent = payload.text;

  switch (payload.phase) {
    case 'loading':
      $('qrCover').hidden = true;
      break;
    case 'created':
      $('qrCover').hidden = true;
      $('qrMode').textContent = payload.mode === 'web'
        ? '兼容通道 · 不含 stoken，登录过期需重新扫码'
        : payload.mode === 'preview'
          ? '预览模式 · 此二维码不可扫描'
          : 'App 通道 · 支持自动续期';
      break;
    case 'scanned':
    case 'working':
    case 'polling-error':
      $('qrCover').hidden = true;
      break;
    case 'expired':
    case 'error':
      $('qrCover').hidden = false;
      $('qrCover').textContent = '请刷新二维码';
      break;
    case 'done':
      $('qrCover').hidden = true;
      renderAccountUI();
      setTimeout(() => {
        hideQr();
        toast(payload.text || '登录成功');
      }, 1000);
      break;
    default:
      break;
  }
}

/* ---------- 钉在桌面时的窗口拖动 ---------- */
/**
 * 钉到桌面后主窗口是 Progman 的子窗口，-webkit-app-region: drag 不再生效
 * （子窗口不走系统标题栏移动），所以改由渲染层发屏幕坐标、主进程 setBounds。
 * 未钉住时仍然用系统拖动，手感更顺。
 */
function bindWindowDrag() {
  const handle = $('dragHandle');
  if (!handle || !bridge.dragStart) return;
  let dragging = false;
  let pointerId = null;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (document.documentElement.dataset.pinned !== '1') return;
    if (event.target.closest('button')) return;
    dragging = true;
    pointerId = event.pointerId;
    try { handle.setPointerCapture(pointerId); } catch (_) { /* ignore */ }
    bridge.dragStart(event.screenX, event.screenY);
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    bridge.dragMove(event.screenX, event.screenY);
  });

  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    if (pointerId !== null) {
      try { handle.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
    }
    pointerId = null;
    bridge.dragEnd();
    if (event && event.type === 'pointerup') reportHeight();
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

function bindUI() {
  $('btnRefresh').onclick = async () => {
    const result = await bridge.syncNow();
    if (result && result.ok === false) toast(result.message || '同步失败');
  };
  $('btnSettings').onclick = () => {
    showView($('viewSettings').hidden ? 'settings' : 'main');
  };
  $('btnBack').onclick = () => showView('main');
  $('btnHide').onclick = () => bridge.windowAction('hide');
  $('btnPin').onclick = () => bridge.windowAction('toggle-pin');

  document.querySelectorAll('.theme-dot').forEach((dot) => {
    dot.onclick = async () => {
      const name = dot.dataset.theme;
      applyTheme(name);
      state.config = { ...state.config, theme: name };
      const cfg = await bridge.saveConfig({ theme: name });
      if (cfg) state.config = { ...state.config, ...cfg };
      const label = (THEME_DESCS[name] || '').split(' · ')[0];
      if (!isPreview) toast(`配色已切换：${label}`);
    };
  });

  // 窗口层级改动立刻生效，不用等「保存并同步」
  $('inDeskPin').onchange = async () => {
    const next = $('inDeskPin').checked;
    state.config = { ...state.config, deskPin: next, alwaysOnTop: next ? false : $('inTop').checked };
    syncLayerUI(state.config);
    const cfg = await bridge.saveConfig({ deskPin: next });
    if (cfg) state.config = { ...state.config, ...cfg };
    syncLayerUI(state.config);
    render();
  };
  $('inTop').onchange = async () => {
    const next = $('inTop').checked;
    state.config = { ...state.config, alwaysOnTop: next, deskPin: next ? false : state.config.deskPin };
    syncLayerUI(state.config);
    const cfg = await bridge.saveConfig({ alwaysOnTop: next, deskPin: next ? false : state.config.deskPin });
    if (cfg) state.config = { ...state.config, ...cfg };
    syncLayerUI(state.config);
    render();
  };
  $('btnCalibrate').onclick = () => openCalib('');
  $('btnCalibClose').onclick = () => closeCalib();
  $('btnCalibCancel').onclick = () => closeCalib();
  $('btnCalibSave').onclick = () => saveCalib();
  $('inCalibResin').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveCalib();
    if (event.key === 'Escape') closeCalib();
  });
  $('inCalibNext').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveCalib();
    if (event.key === 'Escape') closeCalib();
  });

  document.querySelectorAll('.seg').forEach((btn) => {
    btn.onclick = () => { draftSource = btn.dataset.source; updateSourcePanel(); };
  });

  $('btnApplyCalibrate').onclick = async () => {
    const resin = Number($('inResin').value);
    if (!Number.isFinite(resin) || resin < 0) return toast('请填写当前树脂数量');
    const result = await bridge.calibrate({ resin, nextInSeconds: parseNext($('inNext').value) });
    applyCalibrateResult(result);
    state.status = { kind: 'local', text: '本地推算' };
    fillSettings();
    showView('main');
    render();
    toast('已校准，之后会自动按 8 分钟 1 点增长');
  };

  $('btnFetchRoles').onclick = async () => {
    const patch = { server: $('inServer').value, uid: $('inUid').value.trim() };
    const cookie = $('inCookie').value.trim();
    if (cookie) patch.cookie = cookie;
    state.config = await bridge.saveConfig(patch);
    updateAccountCard();
    if (cookie) $('inCookie').value = '';
    const result = await bridge.fetchRoles();
    if (result.ok && result.roles && result.roles.length) {
      const role = result.roles[0];
      $('inUid').value = role.uid;
      if (role.server) $('inServer').value = role.server;
      if (state.config.activeAccountId) {
        const updated = await bridge.updateAccount(state.config.activeAccountId, {
          uid: role.uid,
          server: role.server || $('inServer').value,
        });
        if (updated) state.config = { ...state.config, ...updated };
      }
      renderAccountUI();
      toast(`找到 ${result.roles.length} 个角色，已填入 ${role.nickname || role.uid}`);
    } else {
      toast(result.message || '未找到角色，请检查 Cookie');
    }
  };

  const startVerify = async () => {
    const result = await bridge.verifyStart();
    toast(result?.message || (result?.ok === false ? '验证未启动' : '已打开验证窗口'));
  };
  $('btnVerify').onclick = startVerify;
  $('btnVerifySettings').onclick = startVerify;
  $('btnRecheck').onclick = () => {
    bridge.windowAction('refresh');
    toast('正在重新检测…');
  };
  if ($('btnRiskCalib')) {
    $('btnRiskCalib').onclick = () => openCalib(state.config?.activeAccountId || '');
  }

  $('btnQrLogin').onclick = () => beginQrLogin();
  $('btnQrClose').onclick = () => { hideQr(); bridge.qrCancel(); };
  $('btnQrCancel').onclick = () => { hideQr(); bridge.qrCancel(); };
  $('btnQrRefresh').onclick = () => beginQrLogin();

  $('btnLogout').onclick = () => removeAccount(state.config?.activeAccountId);

  $('btnAccounts').onclick = () => showAccountsSheet();
  $('btnAddAccountMain').onclick = () => beginQrLogin();
  $('btnAccountsClose').onclick = () => hideAccountsSheet();
  $('accountsSheet').onclick = (event) => {
    if (event.target === $('accountsSheet')) hideAccountsSheet();
  };
  $('btnAddAccount').onclick = () => { hideAccountsSheet(); beginQrLogin(); };

  $('inScale').oninput = () => {
    const pct = Number($('inScale').value) || 100;
    state.config = { ...state.config, uiScale: pct / 100 };
    updateScaleUI();
    clearTimeout(scaleTimer);
    scaleTimer = setTimeout(() => { setScale(pct); }, 90);
  };
  $('btnScaleReset').onclick = () => setScale(100);

  window.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const pct = Math.round((Number(state.config?.uiScale) || 1) * 20) * 5;
    setScale(pct + (event.deltaY < 0 ? 5 : -5));
  }, { passive: false });

  $('btnSave').onclick = async () => {
    const patch = collectConfig();
    state.config = await bridge.saveConfig(patch);
    // UID / 服务器属于账号，保存时同步写回当前账号
    if (state.config.activeAccountId) {
      const updated = await bridge.updateAccount(state.config.activeAccountId, {
        uid: patch.uid,
        server: patch.server,
      });
      if (updated) state.config = { ...state.config, ...updated };
    }
    renderAccountUI();
    $('inCookie').value = '';
    const result = await bridge.syncNow();
    fillSettings();
    showView('main');
    render();
    if (result && result.ok === false) toast(result.message || '同步失败，已保留上次数据');
    else toast('设置已保存');
  };
}

async function boot() {
  const snapshot = await bridge.getState();
  state.config = snapshot.config;
  state.note = snapshot.note;
  state.status = snapshot.status || { kind: 'idle', text: '' };

  bridge.onNote((note) => { state.note = note; render(); });
  bridge.onStatus((status) => { state.status = status; render(); });
  bridge.onSettings(() => { fillSettings(); showView('settings'); });
  bridge.onConfig((config) => {
    state.config = { ...state.config, ...config };
    if (!$('viewSettings').hidden) fillSettings();
    renderAccountUI();
    updateScaleUI();
    render();
  });
  bridge.onQrUpdate(handleQrUpdate);
  bridge.onQrRequest(() => beginQrLogin());
  bridge.onAccountsRequest(() => showAccountsSheet());
  bridge.onToast((message) => toast(message));

  bindUI();
  bindWindowDrag();
  fillSettings();
  renderAccountUI();
  updateScaleUI();
  if (!state.note && state.config.source === 'local' && !isPreview) showView('settings');
  render();
  requestAnimationFrame(reportHeight);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { lastReportedHeight = 0; reportHeight(); });
  }
  setInterval(render, 1000);
}

boot();

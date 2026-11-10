'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const RESIN_SECONDS = 480;

/** 全局配置（与账号无关） */
const DEFAULTS = {
  source: 'local', // local | mihoyo | custom
  maxResin: 200,
  notifyAt: 190,
  syncInterval: 300, // 秒；请求过密会触发米游社风控
  customUrl: '',
  alwaysOnTop: true,
  deskPin: false, // 钉在桌面：作为桌面壁纸的子窗口，不遮挡其它程序
  theme: 'gold', // 配色方案
  autoStart: false,
  opacity: 0.94,
  uiScale: 1, // 界面缩放，1 为原始大小
  uiHeight: 292, // 主界面内容高度（逻辑像素），随账号数量自适应
  winX: null,
  winY: null,
  lastNotifyDate: '',
  uid: '', // 未登录时的默认 UID
  server: 'cn_gf01',
  activeAccountId: '',
  localNote: null, // 本地推算快照
  customNote: null, // 自定义接口快照
  accounts: [],
};

/** 单个账号的全部数据；凭证与设备指纹都按账号隔离，避免相互污染 */
const ACCOUNT_DEFAULTS = {
  id: '',
  uid: '',
  server: 'cn_gf01',
  nickname: '',
  label: '',
  loginMethod: '', // qr | manual
  cookieSealed: '',
  credentialSealed: '',
  deviceId: '',
  deviceFp: '',
  fpSeed: '',
  fpTime: '',
  challenge: '',
  challengeAt: 0,
  traceId: '',
  note: null,
  lastSyncAt: 0,
  syncError: '', // 最近一次同步失败的原因，成功后清空
  errorAt: 0,
  lastNotifyDate: '',
  createdAt: 0,
};

const PATCHABLE = [
  'source', 'maxResin', 'notifyAt', 'syncInterval', 'customUrl',
  'alwaysOnTop', 'deskPin', 'theme', 'autoStart', 'opacity', 'uiScale', 'uiHeight', 'winX', 'winY', 'uid', 'server',
];

/** 可选配色方案，非法值一律回落到默认 */
const THEMES = ['gold', 'frost', 'jade', 'sakura', 'violet', 'graphite'];

function normalizeTheme(value) {
  const name = String(value || '');
  return THEMES.includes(name) ? name : 'gold';
}

const SCALE_MIN = 0.7;
const SCALE_MAX = 1.8;

function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(n * 100) / 100));
}

function seal(text) {
  if (!text) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(text).toString('base64');
    }
  } catch (_) {
    /* 加密不可用时降级 */
  }
  return 'plain:' + Buffer.from(text, 'utf8').toString('base64');
}

function unseal(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    }
    if (value.startsWith('plain:')) {
      return Buffer.from(value.slice(6), 'base64').toString('utf8');
    }
  } catch (_) {
    /* 解密失败按未配置处理 */
  }
  return '';
}

/** 按快照推算当前树脂，用于账号列表里的缓存展示 */
function resinOf(note, now = Date.now()) {
  if (!note) return null;
  const elapsed = Math.max(0, (now - note.syncedAt) / 1000);
  const remaining = Math.max(0, note.remainingSeconds - elapsed);
  const max = Number(note.maxResin) || 200;
  if (remaining <= 0) return Math.max(max, Number(note.currentResin) || 0);
  return Math.max(0, max - Math.ceil(remaining / RESIN_SECONDS));
}

/** 渲染层需要的快照字段：只含数值，不含任何账号凭证 */
function noteBrief(note) {
  if (!note) return null;
  return {
    currentResin: Number(note.currentResin) || 0,
    maxResin: Number(note.maxResin) || 200,
    remainingSeconds: Number(note.remainingSeconds) || 0,
    syncedAt: Number(note.syncedAt) || 0,
    source: note.source || '',
    extra: note.extra || null,
  };
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'widget-config.json');
    this.data = { ...DEFAULTS };
    let parsed = null;
    try {
      if (fs.existsSync(this.file)) {
        parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...DEFAULTS, ...(parsed.config || {}) };
      }
    } catch (_) {
      /* 配置损坏则用默认值 */
    }
    this.data.accounts = Array.isArray(this.data.accounts) ? this.data.accounts : [];
    this.data.accounts = this.data.accounts
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        ...ACCOUNT_DEFAULTS,
        ...a,
        id: a.id || crypto.randomUUID(),
        deviceId: a.deviceId || crypto.randomUUID(),
      }));
    this.migrateLegacy(parsed);
    this.data.uiScale = clampScale(this.data.uiScale);
    this.data.theme = normalizeTheme(this.data.theme);
    this.data.deskPin = Boolean(this.data.deskPin);
    // 钉在桌面与置顶互斥，桌面上不可能同时浮在最上层
    if (this.data.deskPin) this.data.alwaysOnTop = false;
    if (!this.data.activeAccountId && this.data.accounts.length) {
      this.data.activeAccountId = this.data.accounts[0].id;
    }
    if (this.data.activeAccountId && !this.activeAccount) {
      this.data.activeAccountId = this.data.accounts.length ? this.data.accounts[0].id : '';
    }
    // 旧版本默认 60 秒同步过密，容易触发米游社风控；一次性迁移到 300 秒
    if (Number(this.data.syncInterval) < 180) this.data.syncInterval = 300;
    if (!this.data.uid) this.data.uid = '';
    this.ensureValidSource();
    this.persist();
  }

  /** 把旧版单账号配置迁移为一个账号，保证老用户升级后不用重新登录 */
  migrateLegacy(parsed) {
    const legacy = (parsed && parsed.config) || {};
    if (!this.data.accounts.length && (legacy.cookieSealed || legacy.credentialSealed)) {
      const id = crypto.randomUUID();
      const note = parsed?.note || null;
      this.data.accounts.push({
        ...ACCOUNT_DEFAULTS,
        id,
        uid: String(legacy.uid || ''),
        server: legacy.server || 'cn_gf01',
        nickname: '',
        label: legacy.accountLabel || '',
        loginMethod: legacy.loginMethod || '',
        cookieSealed: legacy.cookieSealed || '',
        credentialSealed: legacy.credentialSealed || '',
        deviceId: legacy.deviceId || crypto.randomUUID(),
        deviceFp: legacy.deviceFp || '',
        fpSeed: legacy.fpSeed || '',
        fpTime: legacy.fpTime || '',
        challenge: legacy.challenge || '',
        challengeAt: Number(legacy.challengeAt) || 0,
        traceId: legacy.traceId || '',
        note: this.data.source === 'local' ? null : note,
        lastSyncAt: note?.syncedAt || 0,
        createdAt: Date.now(),
      });
      this.data.activeAccountId = id;
    }
    // 旧版 note 存在顶层；按当时的来源放回对应位置
    if (parsed && parsed.note) {
      if (this.data.source === 'local' && !this.data.localNote) this.data.localNote = parsed.note;
      if (this.data.source === 'custom' && !this.data.customNote) this.data.customNote = parsed.note;
    }
    for (const key of [
      'cookieSealed', 'credentialSealed', 'loginMethod', 'accountLabel', 'deviceId',
      'deviceFp', 'fpSeed', 'fpTime', 'challenge', 'challengeAt', 'traceId', 'note',
    ]) {
      if (key in this.data) delete this.data[key];
    }
  }

  persist() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ config: this.data }, null, 2), 'utf8');
    } catch (_) {
      /* 忽略写入失败 */
    }
  }

  get config() {
    return { ...this.data };
  }

  get activeAccount() {
    const id = this.data.activeAccountId;
    if (!id) return null;
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  /** 米游社源但没有可用账号时自动降级，避免界面一直报「未登录」 */
  ensureValidSource() {
    if (this.data.source === 'mihoyo' && !this.activeAccount) this.data.source = 'local';
  }

  /** 含 Cookie / 凭证的私有配置，只在主进程内使用 */
  get privateConfig() {
    const acc = this.activeAccount || {};
    let credential = null;
    try {
      const raw = unseal(acc.credentialSealed);
      if (raw) credential = JSON.parse(raw);
    } catch (_) {
      /* 凭证损坏按未配置处理 */
    }
    const cfg = {
      ...this.data,
      uid: acc.uid || this.data.uid,
      server: acc.server || this.data.server,
      cookie: unseal(acc.cookieSealed),
      credential,
      deviceId: acc.deviceId || '',
      deviceFp: acc.deviceFp || '',
      fpSeed: acc.fpSeed || '',
      fpTime: acc.fpTime || '',
      challenge: acc.challenge || '',
      challengeAt: Number(acc.challengeAt) || 0,
      traceId: acc.traceId || '',
    };
    // 验证令牌只在签发后 10 分钟内有效，避免过期令牌一直拖累请求
    if (cfg.challenge && (!cfg.challengeAt || Date.now() - cfg.challengeAt > 600000)) {
      cfg.challenge = '';
    }
    return cfg;
  }

  /** 下发给渲染层的配置：绝不回传 Cookie 或 token 明文 */
  get publicConfig() {
    const acc = this.activeAccount;
    const { accounts, localNote, customNote, ...rest } = this.data;
    return {
      ...rest,
      uiScale: clampScale(this.data.uiScale),
      hasCookie: Boolean(acc && acc.cookieSealed),
      hasCredential: Boolean(acc && acc.credentialSealed),
      loginMethod: acc ? acc.loginMethod : '',
      accountLabel: acc ? acc.label : '',
      uid: acc ? acc.uid : this.data.uid,
      server: acc ? acc.server : this.data.server,
      activeAccountId: this.data.activeAccountId,
      accounts: accounts.map((a) => ({
        id: a.id,
        uid: a.uid,
        server: a.server,
        nickname: a.nickname,
        label: a.label || a.nickname || (a.uid ? `账号 ${a.uid}` : '未命名账号'),
        loginMethod: a.loginMethod,
        hasCookie: Boolean(a.cookieSealed),
        hasCredential: Boolean(a.credentialSealed),
        lastSyncAt: Number(a.lastSyncAt) || 0,
        resin: resinOf(a.note),
        maxResin: Number(a.note?.maxResin) || Number(this.data.maxResin) || 200,
        // 主界面要用每个账号的快照独立倒数，所以整份 note 一起下发（不含任何凭证）
        note: noteBrief(a.note),
        error: a.syncError || '',
        errorAt: Number(a.errorAt) || 0,
      })),
      note: this.noteSnapshot,
    };
  }

  get noteSnapshot() {
    if (this.data.source === 'custom') return this.data.customNote;
    if (this.data.source === 'mihoyo') return this.activeAccount ? this.activeAccount.note : null;
    return this.data.localNote;
  }

  patch(patchObj) {
    const input = patchObj || {};
    for (const key of PATCHABLE) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      if (key === 'uiScale') {
        this.data.uiScale = clampScale(input.uiScale);
      } else if (key === 'theme') {
        this.data.theme = normalizeTheme(input.theme);
      } else if (key === 'deskPin') {
        this.data.deskPin = Boolean(input.deskPin);
        // 钉到桌面就没有必要再置顶，保持两者互斥
        if (this.data.deskPin) this.data.alwaysOnTop = false;
      } else if (key === 'alwaysOnTop') {
        this.data.alwaysOnTop = Boolean(input.alwaysOnTop);
        if (this.data.alwaysOnTop) this.data.deskPin = false;
      } else {
        this.data[key] = input[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(input, 'cookie')) {
      const value = String(input.cookie || '').trim();
      // 留空表示保持原值，方便设置面板不重复输入
      if (value) {
        let acc = this.activeAccount;
        if (!acc) {
          acc = this.createAccount({
            uid: String(input.uid || this.data.uid || ''),
            server: input.server || this.data.server,
            label: '手动登录',
          });
        }
        acc.cookieSealed = seal(value);
        acc.loginMethod = 'manual';
        if (!acc.label) acc.label = acc.uid ? `手动登录 · ${acc.uid}` : '手动登录';
      }
    }
    if (input.clearCookie) {
      this.removeAccount(this.data.activeAccountId);
      return this.publicConfig;
    }
    this.persist();
    return this.publicConfig;
  }

  createAccount(info = {}) {
    const acc = {
      ...ACCOUNT_DEFAULTS,
      id: crypto.randomUUID(),
      uid: String(info.uid || ''),
      server: info.server || this.data.server || 'cn_gf01',
      nickname: info.nickname || '',
      label: info.label || '',
      deviceId: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    this.data.accounts.push(acc);
    this.data.activeAccountId = acc.id;
    return acc;
  }

  /**
   * 扫码登录成功后写入账号：同一 UID 视为同一账号并更新凭证，
   * 否则新增一个账号并切换过去。返回账号 id。
   */
  upsertAccount(info, credential) {
    if (!credential?.cookie) return this.data.activeAccountId;
    const uid = String(info?.uid || '');
    let acc = uid ? this.data.accounts.find((a) => a.uid === uid) : null;
    if (!acc) {
      acc = this.createAccount(info);
    }
    acc.uid = uid || acc.uid;
    acc.server = info?.server || acc.server || 'cn_gf01';
    acc.nickname = info?.nickname || acc.nickname;
    acc.label = info?.label
      || (acc.nickname ? `${acc.nickname}${acc.uid ? ' · ' + acc.uid : ''}` : acc.label)
      || (acc.uid ? `账号 ${acc.uid}` : '米游社账号');
    acc.loginMethod = 'qr';
    acc.cookieSealed = seal(credential.cookie);
    acc.credentialSealed = seal(JSON.stringify({
      mode: credential.mode,
      stoken: credential.stoken || '',
      mid: credential.mid || '',
      stuid: credential.stuid || '',
      ltoken: credential.ltoken || '',
      cookieToken: credential.cookieToken || '',
      extraCookies: credential.extraCookies || {},
      deviceId: credential.deviceId || acc.deviceId,
      cookie: credential.cookie,
    }));
    if (!acc.deviceId) acc.deviceId = crypto.randomUUID();
    this.data.activeAccountId = acc.id;
    this.data.source = 'mihoyo';
    // 新登录换一枚设备指纹，避免沿用被风控标记的设备
    acc.deviceFp = '';
    acc.fpSeed = '';
    acc.fpTime = '';
    acc.challenge = '';
    acc.challengeAt = 0;
    acc.traceId = '';
    this.persist();
    return acc.id;
  }

  /** 刷新凭证（stoken 续期）时只更新当前账号的凭证 */
  setCredential(credential, label = '') {
    if (!credential?.cookie) return this.publicConfig;
    const acc = this.activeAccount;
    if (!acc) {
      this.upsertAccount({}, credential);
      return this.publicConfig;
    }
    acc.cookieSealed = seal(credential.cookie);
    acc.credentialSealed = seal(JSON.stringify({
      mode: credential.mode,
      stoken: credential.stoken || '',
      mid: credential.mid || '',
      stuid: credential.stuid || '',
      ltoken: credential.ltoken || '',
      cookieToken: credential.cookieToken || '',
      extraCookies: credential.extraCookies || {},
      deviceId: credential.deviceId || acc.deviceId,
      cookie: credential.cookie,
    }));
    acc.loginMethod = 'qr';
    if (label) acc.label = label;
    this.persist();
    return this.publicConfig;
  }

  switchAccount(id) {
    const target = this.data.accounts.find((a) => a.id === id);
    if (!target) return this.publicConfig;
    this.data.activeAccountId = target.id;
    this.data.source = 'mihoyo';
    this.persist();
    return this.publicConfig;
  }

  updateAccount(id, patchObj) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) return this.publicConfig;
    const input = patchObj || {};
    if (Object.prototype.hasOwnProperty.call(input, 'uid')) acc.uid = String(input.uid || '');
    if (Object.prototype.hasOwnProperty.call(input, 'server')) acc.server = String(input.server || 'cn_gf01');
    if (Object.prototype.hasOwnProperty.call(input, 'label')) {
      acc.label = String(input.label || '') || acc.nickname || (acc.uid ? `账号 ${acc.uid}` : '米游社账号');
    }
    this.persist();
    return this.publicConfig;
  }

  removeAccount(id) {
    const index = this.data.accounts.findIndex((a) => a.id === id);
    if (index < 0) return this.publicConfig;
    this.data.accounts.splice(index, 1);
    if (this.data.activeAccountId === id) {
      this.data.activeAccountId = this.data.accounts.length ? this.data.accounts[0].id : '';
    }
    this.ensureValidSource();
    this.persist();
    return this.publicConfig;
  }

  /** 兼容旧调用：退出登录 = 移除当前账号 */
  clearCredential() {
    return this.removeAccount(this.data.activeAccountId);
  }

  /** 保存官方签发的设备指纹（按账号隔离） */
  setDeviceFp(fp) {
    const acc = this.activeAccount;
    if (!acc || !fp?.deviceFp) return this.publicConfig;
    acc.deviceFp = String(fp.deviceFp);
    acc.fpSeed = String(fp.seed || '');
    acc.fpTime = String(fp.time || '');
    if (fp.deviceId) acc.deviceId = String(fp.deviceId);
    this.persist();
    return this.publicConfig;
  }

  clearDeviceFp() {
    const acc = this.activeAccount;
    if (!acc) return this.publicConfig;
    acc.deviceFp = '';
    acc.fpSeed = '';
    acc.fpTime = '';
    this.persist();
    return this.publicConfig;
  }

  setChallenge(value) {
    const acc = this.activeAccount;
    if (!acc) return;
    acc.challenge = String(value || '');
    acc.challengeAt = acc.challenge ? Date.now() : 0;
    this.persist();
  }

  consumeChallenge() {
    const acc = this.activeAccount;
    if (!acc || !acc.challenge) return '';
    const value = acc.challenge;
    acc.challenge = '';
    acc.challengeAt = 0;
    this.persist();
    return value;
  }

  setTraceId(value) {
    const acc = this.activeAccount;
    if (!acc) return;
    const next = String(value || '');
    if (acc.traceId === next) return;
    acc.traceId = next;
    this.persist();
  }

  /** 反复风控时换一个设备身份，凭证保持不变 */
  resetDevice() {
    const acc = this.activeAccount;
    if (!acc) return this.publicConfig;
    acc.deviceId = crypto.randomUUID();
    acc.deviceFp = '';
    acc.fpSeed = '';
    acc.fpTime = '';
    this.persist();
    return this.publicConfig;
  }

  setNote(note) {
    if (this.data.source === 'custom') {
      this.data.customNote = note;
    } else if (this.data.source === 'mihoyo') {
      const acc = this.activeAccount;
      if (acc) {
        acc.note = note;
        acc.lastSyncAt = Date.now();
      } else {
        this.data.localNote = note;
      }
    } else {
      this.data.localNote = note;
    }
    this.persist();
  }

  /** 某个账号的缓存快照，用于切换账号时先显示旧值 */
  noteOfAccount(id) {
    const acc = this.data.accounts.find((a) => a.id === id);
    return acc ? acc.note : null;
  }

  /** 按账号写入快照：多账号同时同步时使用，不受 activeAccountId 影响 */
  setNoteFor(id, note) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) return;
    acc.note = note;
    acc.lastSyncAt = Number(note?.syncedAt) || Date.now();
    acc.syncError = '';
    acc.errorAt = 0;
    this.persist();
  }

  setSyncError(id, message) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) return;
    acc.syncError = String(message || '同步失败');
    acc.errorAt = Date.now();
    this.persist();
  }

  /** 需要在主进程内临时把「当前账号上下文」切到某个账号时使用 */
  get activeId() {
    return this.data.activeAccountId;
  }

  setActiveId(id) {
    this.data.activeAccountId = id || '';
  }

  accountById(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  get accounts() {
    return this.data.accounts;
  }
}

module.exports = {
  Store, DEFAULTS, ACCOUNT_DEFAULTS, resinOf, clampScale, SCALE_MIN, SCALE_MAX, THEMES, normalizeTheme,
};

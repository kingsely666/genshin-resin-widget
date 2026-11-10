'use strict';

/**
 * 米游社 Passport 扫码登录。
 * 主通道：App QR（确认后直接下发 stoken_v2，可用 stoken 自动续期）
 * 回退通道：Web QR（从 Set-Cookie 取 ltoken_v2 / cookie_token_v2，不能自动续期）
 * 二维码只在本机生成，凭证只发往米哈游官方域名。
 */
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'; // 4X DS2 salt
const APP_ID = 'bll8iq97cem8';
const APP_VERSION = '2.90.1';
const APP_CLIENT_TYPE = '3';
const APP_UA = 'Mozilla/5.0 miHoYoBBS/2.90.1 Capture/2.2.0';

const APP_CREATE = 'https://passport-api.mihoyo.com/account/ma-cn-passport/app/createQRLogin';
const APP_QUERY = 'https://passport-api.mihoyo.com/account/ma-cn-passport/app/queryQRLoginStatus?token_types=1';
const WEB_CREATE = 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/createQRLogin';
const WEB_QUERY = 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/queryQRLoginStatus';

const LTOKEN_URL = 'https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken';
const CTOKEN_URLS = [
  'https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken',
  'https://passport-api.mihoyo.com/account/auth/api/getCookieAccountInfoBySToken',
];

const TOKEN_HEADERS = {
  'x-rpc-client_type': '1',
  'x-rpc-game_biz': 'bbs_cn',
  'x-rpc-app_version': '2.63.1',
  'User-Agent': 'Hyperion/275 CFNetwork/1402.0.8 Darwin/22.2.0',
};

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/** Passport App 通道的 DS：b 必须与实际发送的 body 字节完全一致 */
function passportDS(body) {
  const t = Math.floor(Date.now() / 1000);
  let r = crypto.randomInt(100000, 200000);
  if (r === 100000) r += 542367;
  const sign = md5(`salt=${SALT}&t=${t}&r=${r}&b=${body}&q=`);
  return `${t},${r},${sign}`;
}

function appHeaders(deviceId, body) {
  return {
    'x-rpc-app_id': APP_ID,
    'x-rpc-client_type': APP_CLIENT_TYPE,
    'x-rpc-device_id': deviceId,
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-sdk_version': APP_VERSION,
    'x-rpc-account_version': APP_VERSION,
    'x-rpc-game_biz': 'bbs_cn',
    'User-Agent': APP_UA,
    'Content-Type': 'application/json',
    DS: passportDS(body),
  };
}

function webHeaders(deviceId) {
  return {
    'x-rpc-app_id': APP_ID,
    'x-rpc-client_type': '4',
    'x-rpc-device_id': deviceId,
    'x-rpc-app_version': APP_VERSION,
    'User-Agent': APP_UA,
    'Content-Type': 'application/json',
  };
}

async function postJSON(url, headers, body, timeout = 15000) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { json: await res.json(), headers: res.headers };
}

function cookiesFromHeaders(headers) {
  const parts = {};
  try {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of list) {
      const first = String(raw).split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0) parts[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
    }
  } catch (_) {
    /* 忽略解析失败 */
  }
  return parts;
}

/** 校验二维码 URL 确实指向米哈游官方域名，避免展示来路不明的地址 */
function parseQrData(data) {
  const url = String(data?.url || '').trim();
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const official = host === 'mihoyo.com' || host.endsWith('.mihoyo.com')
    || host === 'hoyolab.com' || host.endsWith('.hoyolab.com');
  if (!official) return null;
  const ticket = String(data?.ticket || '').trim()
    || parsed.searchParams.get('tk') || parsed.searchParams.get('ticket') || '';
  if (!ticket) return null;
  return { url, ticket };
}

/** 创建扫码会话，App 通道优先，失败回退 Web 通道 */
async function createSession() {
  const deviceId = crypto.randomUUID().toUpperCase();
  const body = '{}';
  let appError = null;
  try {
    const { json } = await postJSON(APP_CREATE, appHeaders(deviceId, body), body);
    if (json?.retcode === 0) {
      const parsed = parseQrData(json.data);
      if (parsed) return { mode: 'app', deviceId, ...parsed };
      appError = new Error('App 通道返回的二维码地址无效');
    } else {
      appError = new Error(`[${json?.retcode}] ${json?.message || 'App 通道不可用'}`);
    }
  } catch (error) {
    appError = error;
  }

  try {
    const { json } = await postJSON(WEB_CREATE, webHeaders(deviceId), body);
    if (json?.retcode !== 0) throw new Error(`[${json?.retcode}] ${json?.message || '创建二维码失败'}`);
    const parsed = parseQrData(json.data);
    if (!parsed) throw new Error('Web 通道返回的二维码地址无效');
    return { mode: 'web', deviceId, ...parsed, fallbackReason: appError?.message || '' };
  } catch (error) {
    throw new Error(`扫码二维码创建失败：${error.message}${appError ? `（App 通道：${appError.message}）` : ''}`);
  }
}

async function fetchTokenField(url, headers, field) {
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.retcode !== 0 || !json?.data?.[field]) {
    throw new Error(`[${json?.retcode}] ${json?.message || 'token 派生失败'}`);
  }
  return String(json.data[field]);
}

/** 用 stoken_v2 补齐 ltoken / cookie_token；失败不丢弃已有凭证 */
async function deriveTokens(credential) {
  const headers = {
    ...TOKEN_HEADERS,
    'x-rpc-device_id': credential.deviceId,
    Cookie: `stoken=${credential.stoken}; mid=${credential.mid}; stuid=${credential.stuid}`,
  };
  if (!credential.ltoken) {
    try { credential.ltoken = await fetchTokenField(LTOKEN_URL, headers, 'ltoken'); } catch (_) { /* 可选 */ }
  }
  if (!credential.cookieToken) {
    for (const url of CTOKEN_URLS) {
      try {
        credential.cookieToken = await fetchTokenField(url, headers, 'cookie_token');
        if (credential.cookieToken) break;
      } catch (_) { /* 尝试下一个端点 */ }
    }
  }
}

/** 拼出米游社各接口都认的完整 Cookie（v1 / v2 别名齐全） */
function buildCookie(credential) {
  const p = { ...(credential.extraCookies || {}) };
  const put = (key, value) => { if (value && !p[key]) p[key] = value; };
  if (credential.stoken) {
    put('stoken', credential.stoken);
    put('stoken_v2', credential.stoken);
  }
  if (credential.mid) {
    for (const key of ['mid', 'mid_v2', 'ltmid_v2', 'account_mid_v2']) put(key, credential.mid);
  }
  if (credential.stuid) {
    for (const key of ['stuid', 'stuid_v2', 'ltuid', 'ltuid_v2', 'account_id', 'account_id_v2', 'login_uid']) {
      put(key, credential.stuid);
    }
  }
  if (credential.ltoken) {
    put('ltoken', credential.ltoken);
    if (credential.ltoken.startsWith('v2_')) put('ltoken_v2', credential.ltoken);
  }
  if (credential.cookieToken) {
    put('cookie_token', credential.cookieToken);
    if (credential.cookieToken.startsWith('v2_')) put('cookie_token_v2', credential.cookieToken);
  }
  return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 从扫码确认响应构造凭证 */
async function credentialFromConfirm(data, cookieParts, session, mode) {
  const info = data.user_info || {};
  const credential = {
    mode,
    deviceId: session.deviceId,
    stuid: String(info.aid || info.uid || info.account_id
      || cookieParts.stuid || cookieParts.stuid_v2 || cookieParts.account_id_v2 || cookieParts.account_id || ''),
    mid: String(info.mid || cookieParts.mid || cookieParts.ltmid_v2 || cookieParts.mid_v2 || ''),
    extraCookies: cookieParts,
  };

  let stoken = '';
  for (const token of (Array.isArray(data.tokens) ? data.tokens : [])) {
    if (String(token?.token_type) === '1' && token?.token) { stoken = String(token.token); break; }
  }
  if (!stoken && data.token?.token) stoken = String(data.token.token);
  if (!stoken) stoken = String(cookieParts.stoken_v2 || cookieParts.stoken || '');
  credential.stoken = stoken;
  credential.cookieToken = String(cookieParts.cookie_token_v2 || cookieParts.cookie_token || '');
  credential.ltoken = String(cookieParts.ltoken_v2 || cookieParts.ltoken || '');

  if (stoken && credential.mid) await deriveTokens(credential);
  credential.cookie = buildCookie(credential);
  if (!credential.cookie) throw new Error('登录成功但未取得可用凭证，请重新扫码或手动填写 Cookie');
  return credential;
}

function interpret(json, headers, session, mode) {
  const retcode = Number(json?.retcode);
  const message = String(json?.message || '');
  if (retcode !== 0) {
    if (retcode === -106 || /过期|失效|expire/i.test(message)) return { status: 'Expired', message: message || '二维码已过期' };
    if (retcode === -3505 || /取消|cancel/i.test(message)) return { status: 'Canceled', message: '登录已取消' };
    return { status: 'Error', message: `[${retcode}] ${message || '查询失败'}` };
  }
  const data = json?.data || {};
  const status = String(data.status || '');
  if (status === 'Created' || status === 'Init') return { status: 'Init' };
  if (status === 'Scanned') return { status: 'Scanned' };
  if (status === 'Expired') return { status: 'Expired', message: '二维码已过期，请刷新' };
  if (status === 'Canceled') return { status: 'Canceled', message: '登录已取消' };
  if (status !== 'Confirmed') return { status: 'Error', message: `未知扫码状态：${status || '空'}` };
  return { status: 'Confirmed', pendingData: data, pendingCookies: cookiesFromHeaders(headers) };
}

/** 查询一次扫码状态；Confirmed 时返回 credential */
async function checkSession(session) {
  const body = JSON.stringify({ ticket: session.ticket });
  const isApp = session.mode === 'app';
  const { json, headers } = await postJSON(
    isApp ? APP_QUERY : WEB_QUERY,
    isApp ? appHeaders(session.deviceId, body) : webHeaders(session.deviceId),
    body
  );
  const result = interpret(json, headers, session, session.mode);
  if (result.status === 'Confirmed') {
    result.credential = await credentialFromConfirm(
      result.pendingData, result.pendingCookies, session, session.mode
    );
    delete result.pendingData;
    delete result.pendingCookies;
  }
  return result;
}

/** 凭证过期时用 stoken 重新派生，返回新的 credential */
async function refreshCredential(credential, deviceId) {
  if (!credential?.stoken) throw new Error('没有可续期的 stoken，请重新扫码登录');
  const next = {
    ...credential,
    deviceId: deviceId || credential.deviceId,
    cookieToken: '',
    ltoken: '',
  };
  await deriveTokens(next);
  next.cookie = buildCookie(next);
  return next;
}

async function makeQRDataURL(text) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 176,
    color: { dark: '#1b202b', light: '#ffffff' },
  });
}

module.exports = {
  createSession,
  checkSession,
  refreshCredential,
  makeQRDataURL,
  buildCookie,
  parseQrData,
};

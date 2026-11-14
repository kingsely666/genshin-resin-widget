'use strict';

/**
 * 米游社 / HoYoLAB「实时便笺」数据层。
 * 只读取本人账号的数据，Cookie 仅用于请求米游社官方域名。
 *
 * 国服风控链路：
 *   缺设备指纹 -> 5003（message 为空）
 *   补上指纹   -> 1034（需要人机验证）
 *   验证后带一次性 challenge -> retcode 0
 */
const crypto = require('node:crypto');
const devicefp = require('./devicefp');

const APP_VERSION = '2.90.1';
const UA_CN = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) miHoYoBBS/${APP_VERSION}`;
const UA_OS = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) HoYoLAB/${APP_VERSION}`;

// DS2 签名盐（client_type = 5）
const SALT_CN = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';
const SALT_OS = 'okr4obncj8bw5a65hbnn5oo6ixjc3l9w';

const ROLE_ENDPOINTS_CN = [
  'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookieToken',
  'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie',
  'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByLtoken',
];
const ROLE_ENDPOINTS_OS = [
  'https://api-os-takumi.mihoyo.com/binding/api/getUserGameRolesByLtoken',
  'https://api-os-takumi.mihoyo.com/binding/api/getUserGameRolesByCookieToken',
];

const VERIFY_CREATE = 'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/createVerification';
const VERIFY_SUBMIT = 'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/verifyVerification';
// 必须与真正被风控的请求 URL 完全一致，否则验证结果不被服务端接受（retcode -1）
const CHALLENGE_PATH = 'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/dailyNote';

/** 验证票据要绑定的目标接口，跟随实际使用的 endpoint */
function challengePathOf(server) {
  return endpointOf(server).note;
}

const ENDPOINTS = {
  cn: {
    note: 'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/dailyNote',
    gameBiz: 'hk4e_cn',
    referer: 'https://webstatic.mihoyo.com/',
    ua: UA_CN,
    salt: SALT_CN,
  },
  os: {
    note: 'https://bbs-api-os.hoyolab.com/game_record/app/genshin/api/dailyNote',
    gameBiz: 'hk4e_global',
    referer: 'https://act.hoyolab.com/',
    ua: UA_OS,
    salt: SALT_OS,
  },
};

const RESIN_SECONDS = 480; // 每 8 分钟恢复 1 点
const AUTH_ERROR_CODES = [-100, -111, -10001, 10001];

function isOversea(server) {
  return String(server || '').startsWith('os_');
}

function endpointOf(server) {
  return isOversea(server) ? ENDPOINTS.os : ENDPOINTS.cn;
}

function isAuthError(retcode) {
  return AUTH_ERROR_CODES.includes(Number(retcode));
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/** 生成 DS2：{timestamp},{random},{md5(salt=...&t=...&r=...&b=...&q=...)} */
function makeDS(query, salt, body = '') {
  const t = Math.floor(Date.now() / 1000);
  let r = crypto.randomInt(100000, 200000);
  if (r === 100000) r += 542367;
  const q = Object.keys(query || {})
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const sign = md5(`salt=${salt}&t=${t}&r=${r}&b=${body}&q=${q}`);
  return `${t},${r},${sign}`;
}

async function requestJSON(url, headers, timeout = 12000) {
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { json: await res.json(), headers: res.headers };
}

function commonHeaders(cfg, ep) {
  const headers = {
    'User-Agent': ep.ua,
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': cfg.deviceId || crypto.randomUUID(),
    'x-rpc-device_name': 'iPhone',
    'X-Requested-With': isOversea(cfg.server) ? 'com.mihoyo.hoyolab' : 'com.mihoyo.hyperion',
    Referer: ep.referer,
    Cookie: cfg.cookie,
    Accept: 'application/json, text/plain, */*',
  };
  if (!isOversea(cfg.server)) Object.assign(headers, devicefp.CN_EXTRA_HEADERS);
  return headers;
}

/** 把接口返回统一成小组件内部使用的快照 */
function normalize(data, fallbackMax, source) {
  const max = Number(data.max_resin ?? data.maxResin ?? fallbackMax) || fallbackMax;
  const current = Number(data.current_resin ?? data.resin ?? 0);
  let remaining = Number(data.resin_recovery_time ?? data.resinRecoveryTime ?? NaN);
  if (!Number.isFinite(remaining)) {
    remaining = Math.max(0, (max - current) * RESIN_SECONDS);
  }
  remaining = Math.max(0, Math.round(remaining));

  const daily = data.daily_task || {};
  return {
    currentResin: current,
    maxResin: max,
    remainingSeconds: remaining,
    syncedAt: Date.now(),
    source,
    extra: {
      task: `${Number(daily.finished_num ?? data.finished_task_num ?? 0)}/${Number(daily.total_num ?? data.total_task_num ?? 4)}`,
      taskReward: Boolean(daily.is_extra_task_reward_received ?? data.is_extra_task_reward_received),
      expedition: `${Number(data.current_expedition_num ?? 0)}/${Number(data.max_expedition_num ?? 5)}`,
      discount: `${Number(data.remain_resin_discount_num ?? 0)}/${Number(data.resin_discount_num_limit ?? 3)}`,
      homeCoin: `${Number(data.current_home_coin ?? 0)}/${Number(data.max_home_coin ?? 0)}`,
    },
  };
}

/** 读取 Cookie 绑定的角色列表（依次尝试多个历史端点，兼容接口改名） */
async function fetchRoles(cfg) {
  if (!cfg.cookie) throw new Error('请先扫码登录或填写米游社 Cookie');
  const ep = endpointOf(cfg.server);
  const urls = isOversea(cfg.server) ? ROLE_ENDPOINTS_OS : ROLE_ENDPOINTS_CN;
  let lastError = '';
  for (const base of urls) {
    try {
      const url = `${base}?game_biz=${ep.gameBiz}`;
      const { json } = await requestJSON(url, commonHeaders(cfg, ep));
      if (json.retcode === 0 && Array.isArray(json?.data?.list) && json.data.list.length) {
        return json.data.list.map((r) => ({
          uid: String(r.game_uid || r.game_uid_str || ''),
          server: String(r.region || ''),
          nickname: r.nickname || '',
          level: r.level || 0,
        }));
      }
      lastError = `[${json.retcode}] ${json.message || '获取角色失败'}`;
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new Error(`获取角色失败：${lastError || '接口无响应'}。可手动填 UID 后直接同步`);
}

/** 把米游社业务错误码翻译成可操作的提示 */
function noteError(json) {
  const retcode = Number(json?.retcode);
  const message = String(json?.message || '');
  if (retcode === 1034) {
    // 实测：1034 是账号级风控，App / 网页 / 真实浏览器的请求全部被挡；
    // 极验提交通道对这类账号恒返回 -1（连签名都不校验），所以只能引导去 App 解除。
    const err = new Error('米游社风控（1034）：请在米游社 App 打开一次实时便笺');
    err.retcode = 1034;
    err.risk = true;
    err.needVerify = true;
    return err;
  }
  if (retcode === 5003) {
    // 5003 是设备校验层的拒绝：错误码先于 DS 校验返回，换 UA / client_type /
    // 指纹 / device_id 格式都无法绕过（实测 7 组组合全部 5003），
    // 但同一 Cookie 的 binding 系列接口仍返回 0，说明登录态本身有效。
    const err = new Error('米游社拒绝本机读取实时便笺（5003）');
    err.retcode = 5003;
    err.needFpRefresh = true;
    err.deviceBlocked = true;
    return err;
  }
  const err = new Error(`[${retcode}] ${message || '接口返回异常'}`);
  err.retcode = retcode;
  return err;
}

/**
 * 拉取实时便笺。
 * @param {object} cfg 私有配置，可含 deviceFp / fpSeed / fpTime / challenge / traceId
 * @param {object} hooks 可选回调：onTrace(traceId)、onChallengeUsed()、onDeviceFpApplied()
 */
async function fetchNote(cfg, hooks = {}) {
  if (!cfg.cookie) throw new Error('请先扫码登录或填写米游社 Cookie');
  if (!cfg.uid) throw new Error('请先填写 UID（扫码登录会自动读取）');

  const ep = endpointOf(cfg.server);
  const query = { role_id: String(cfg.uid), server: String(cfg.server || 'cn_gf01') };
  const qs = Object.keys(query).sort().map((k) => `${k}=${encodeURIComponent(query[k])}`).join('&');
  const headers = {
    ...commonHeaders(cfg, ep),
    DS: makeDS(query, ep.salt),
  };

  // 国服设备指纹：缺了会 5003
  const fpApplied = devicefp.applyDeviceFp(cfg, headers);
  if (fpApplied && typeof hooks.onDeviceFpApplied === 'function') hooks.onDeviceFpApplied();

  // 验证成功后的一次性 challenge（用后即弃）
  if (cfg.challenge) {
    headers['x-rpc-chellange'] = String(cfg.challenge);
    headers['x-rpc-challenge'] = String(cfg.challenge);
  }

  const { json, headers: resHeaders } = await requestJSON(`${ep.note}?${qs}`, headers);
  const traceId = resHeaders?.get?.('x-trace-id') || '';
  if (traceId && typeof hooks.onTrace === 'function') hooks.onTrace(traceId);

  if (json.retcode !== 0) throw noteError(json);
  // 只在请求真正成功后才丢弃一次性令牌：5003 刷新指纹重试时还要复用它
  if (cfg.challenge && typeof hooks.onChallengeUsed === 'function') hooks.onChallengeUsed();
  return normalize(json.data || {}, cfg.maxResin || 200, 'mihoyo');
}

/** 申请人机验证任务，返回 { gt, challenge, new_captcha, success } */
async function createVerification(cfg, traceId = '') {
  if (!cfg.cookie) throw new Error('请先扫码登录');
  const ep = endpointOf(cfg.server);
  const query = { is_high: 'true' };
  const headers = {
    ...commonHeaders(cfg, ep),
    DS: makeDS(query, ep.salt),
    'x-rpc-challenge_path': challengePathOf(cfg.server),
  };
  if (traceId) headers['x-rpc-challenge_trace'] = traceId;
  devicefp.applyDeviceFp(cfg, headers);

  const { json } = await requestJSON(`${VERIFY_CREATE}?is_high=true`, headers);
  if (json.retcode !== 0 || !json?.data?.gt || !json?.data?.challenge) {
    throw new Error(`[${json.retcode}] ${json.message || '申请人机验证失败'}`);
  }
  return {
    gt: String(json.data.gt),
    challenge: String(json.data.challenge),
    new_captcha: Number(json.data.new_captcha ?? 1),
    success: Number(json.data.success ?? 1),
  };
}

/** 提交滑块验证结果，返回一次性 challenge 字符串 */
async function verifyVerification(cfg, geetest, traceId = '') {
  if (!cfg.cookie) throw new Error('请先扫码登录');
  const ep = endpointOf(cfg.server);
  const body = JSON.stringify({
    geetest_challenge: geetest.geetest_challenge || geetest.challenge || '',
    geetest_validate: geetest.geetest_validate || geetest.validate || '',
    geetest_seccode: geetest.geetest_seccode || geetest.seccode || '',
  });
  const headers = {
    ...commonHeaders(cfg, ep),
    DS: makeDS({}, ep.salt, body),
    'x-rpc-challenge_path': challengePathOf(cfg.server),
    'Content-Type': 'application/json',
  };
  if (traceId) headers['x-rpc-challenge_trace'] = traceId;
  devicefp.applyDeviceFp(cfg, headers);

  const res = await fetch(VERIFY_SUBMIT, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const challenge = String(json?.data?.challenge || '');
  if (json.retcode !== 0 || !challenge) {
    const err = new Error(`[${json.retcode}] ${json.message || '验证未通过，请重试'}`);
    err.retcode = json.retcode;
    err.responseKeys = Object.keys(json.data || {});
    // 只保留业务字段用于诊断，不含任何凭证
    err.responseBody = { retcode: json.retcode, message: json.message, data: json.data };
    throw err;
  }
  return challenge;
}

/** 自定义 HTTP 接口（自建代理 / 云函数 / 开源项目 /resin 均可） */
async function fetchCustom(cfg) {
  if (!cfg.customUrl) throw new Error('请先填写自定义接口地址');
  const { json } = await requestJSON(cfg.customUrl, { Accept: 'application/json, text/plain, */*' });
  const data = json && json.data ? json.data : json;
  if (!data || typeof data !== 'object') throw new Error('自定义接口返回格式无法识别');
  return normalize(data, cfg.maxResin || 200, 'custom');
}

/** 手动校准：构造一个可长期推算的本地快照 */
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

module.exports = {
  RESIN_SECONDS,
  APP_VERSION,
  VERIFY_CREATE,
  VERIFY_SUBMIT,
  isOversea,
  isAuthError,
  makeDS,
  fetchRoles,
  fetchNote,
  createVerification,
  verifyVerification,
  fetchCustom,
  normalize,
  buildLocalNote,
  noteError,
};

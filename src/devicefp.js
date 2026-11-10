'use strict';

/**
 * 米游社国服设备指纹（device_fp）。
 *
 * 实时便笺等 game_record 接口对 client_type=5 的请求做设备校验：
 * 缺少合法指纹会直接返回 5003（message 为空）。补上指纹后通常转为
 * 1034（需要人机验证），这是米游社的标准风控路径。
 *
 * 指纹由官方接口签发：POST https://public-data-api.mihoyo.com/device-fp/api/getFp
 * 签发结果需要同时出现在请求头 x-rpc-device_fp 与 Cookie 的 DEVICEFP_* 字段中，
 * 且 x-rpc-device_id 必须与申请时使用的 bbs_device_id 一致。
 */
const crypto = require('node:crypto');

const FP_URL = 'https://public-data-api.mihoyo.com/device-fp/api/getFp';
const APP_VERSION = '2.90.1';
const UA = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) miHoYoBBS/${APP_VERSION}`;

/** 国服 game_record 接口需要的补充头，需与 ext_fields 里的设备描述保持一致 */
const CN_EXTRA_HEADERS = {
  'x-rpc-sys_version': '17.1',
  'x-rpc-tool_version': 'v5.0.1-ys',
  'x-rpc-device_name': 'iPhone',
  'x-rpc-page': 'v5.0.1-ys_#/ys/daily',
  'x-rpc-language': 'zh-cn',
  Origin: 'https://webstatic.mihoyo.com',
};

function randomHex(length) {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i += 1) result += chars[crypto.randomInt(0, 16)];
  return result;
}

function extFields() {
  return JSON.stringify({
    appInstallTimeDiff: String(Date.now() - 100000),
    isSimInserted: '1',
    IDFV: crypto.randomUUID(),
    proxyStatus: '1',
    ramCapacity: '5665',
    isPushEnabled: '0',
    magnetometer: '640.353210x-105.483749x-192.943878',
    accelerometer: '0.033539x-0.684265x-0.757690',
    screenSize: '393×852',
    batteryStatus: '100',
    romCapacity: '242989',
    networkType: '5G',
    hasVpn: '1',
    romRemain: '20617',
    vendor: '--',
    packageName: 'com.miHoYo.mhybbs',
    deviceName: 'iPhone',
    osVersion: '18.0',
    cpuCores: '6',
    gyroscope: '-0.097501x0.010854x0.020438',
    isJailBreak: '0',
    packageVersion: '2.29.0',
    appMemory: '120',
    ramRemain: '104',
    appUpdateTimeDiff: '1725558423064',
    cpuType: 'CPU_TYPE_ARM64',
    screenBrightness: '0.600',
    chargeStatus: '3',
    buildTime: '1725149453887',
    model: 'iPhone15,2',
  });
}

/**
 * 向官方接口申请一枚设备指纹。
 * @param {object} cfg 需含 cookie 与 deviceId
 * @returns {Promise<{deviceFp:string,seed:string,time:string,deviceId:string,fromServer:boolean}>}
 */
async function acquireDeviceFp(cfg) {
  const deviceId = String(cfg.deviceId || crypto.randomUUID()).toUpperCase();
  const seed = crypto.randomUUID();
  const time = String(Date.now());
  const body = {
    seed_id: seed,
    device_id: randomHex(16),
    bbs_device_id: deviceId,
    platform: '1',
    seed_time: time,
    ext_fields: extFields(),
    app_name: 'bbs_cn',
    device_fp: randomHex(13),
  };
  const headers = {
    'User-Agent': UA,
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-client_type': '5',
    'x-rpc-device_id': deviceId,
    ...CN_EXTRA_HEADERS,
    'X-Requested-With': 'com.mihoyo.hyperion',
    Referer: 'https://webstatic.mihoyo.com/',
    'Content-Type': 'application/json',
    // 首次申请时旧的 DEVICEFP_* 为空
    Cookie: `DEVICEFP_SEED_ID=;DEVICEFP_SEED_TIME=;DEVICEFP=;${cfg.cookie || ''}`,
  };

  const res = await fetch(FP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`设备指纹接口 HTTP ${res.status}`);
  const json = await res.json();
  const serverFp = String(json?.data?.device_fp || '');
  return {
    deviceFp: serverFp || randomHex(13), // 接口异常时退回本地种子，仍比完全缺失好
    seed,
    time,
    deviceId,
    fromServer: Boolean(serverFp),
    code: json?.data?.code ?? json?.retcode,
    msg: json?.data?.msg || json?.message || '',
  };
}

/** 把已签发的指纹写进请求头与 Cookie；国际服不需要 */
function applyDeviceFp(cfg, headers) {
  if (!cfg?.deviceFp || cfg.server?.startsWith?.('os_')) return false;
  Object.assign(headers, CN_EXTRA_HEADERS);
  headers['x-rpc-device_fp'] = String(cfg.deviceFp);
  if (cfg.deviceId) headers['x-rpc-device_id'] = String(cfg.deviceId).toUpperCase();
  const prefix = `DEVICEFP_SEED_ID=${cfg.fpSeed || ''};DEVICEFP_SEED_TIME=${cfg.fpTime || ''};DEVICEFP=${cfg.deviceFp};`;
  headers.Cookie = prefix + (headers.Cookie || cfg.cookie || '');
  return true;
}

module.exports = {
  FP_URL,
  CN_EXTRA_HEADERS,
  acquireDeviceFp,
  applyDeviceFp,
  randomHex,
};

'use strict';

/** 协议自检：用 mock 响应跑完扫码登录 + 设备指纹 + 人机验证全链路，不访问真实网络 */
const qr = require('./src/qrlogin');
const api = require('./src/api');
const devicefp = require('./src/devicefp');

let appCreateFails = false;
let appQueryCalls = 0;
let webQueryCalls = 0;
let lastDS = '';
let lastNoteHeaders = null;
let fpRequests = 0;

const WEB_COOKIES = [
  'ltoken_v2=v2_ltoken; Path=/; HttpOnly',
  'cookie_token_v2=v2_ctoken; Path=/; HttpOnly',
  'account_id_v2=123456789; Path=/; HttpOnly',
  'ltmid_v2=mid_abc; Path=/; HttpOnly',
];

function jsonResponse(body, setCookies = []) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name === 'x-trace-id' ? 'TRACE123' : null),
    },
  };
}

global.fetch = async (url, options) => {
  const u = String(url);
  const h = options?.headers || {};
  if (h.DS) lastDS = h.DS;

  if (u.includes('/app/createQRLogin')) {
    if (appCreateFails) return jsonResponse({ retcode: -3001, message: 'App 通道不可用' });
    return jsonResponse({
      retcode: 0, message: 'OK',
      data: {
        url: 'https://user.mihoyo.com/login-platform/mobile.html?tk=TICKET123&token_types=1',
        ticket: 'TICKET123',
      },
    });
  }
  if (u.includes('/app/queryQRLoginStatus')) {
    appQueryCalls += 1;
    const status = ['Created', 'Scanned', 'Confirmed'][Math.min(appQueryCalls - 1, 2)];
    const data = { status };
    if (status === 'Confirmed') {
      data.user_info = { aid: '123456789', mid: 'mid_abc' };
      data.tokens = [{ token_type: 1, token: 'v2_stoken_xyz' }];
    }
    return jsonResponse({ retcode: 0, message: 'OK', data });
  }
  if (u.includes('/web/createQRLogin')) {
    return jsonResponse({
      retcode: 0, message: 'OK',
      data: {
        url: 'https://user.mihoyo.com/login-platform/mobile.html?tk=WEBTICKET&token_types=4#/login/qr',
        ticket: 'WEBTICKET',
      },
    });
  }
  if (u.includes('/web/queryQRLoginStatus')) {
    webQueryCalls += 1;
    if (webQueryCalls === 1) return jsonResponse({ retcode: 0, data: { status: 'Created' } });
    return jsonResponse({
      retcode: 0,
      data: { status: 'Confirmed', user_info: { aid: '123456789', mid: 'mid_abc' }, tokens: [] },
    }, WEB_COOKIES);
  }
  if (u.includes('getLTokenBySToken')) {
    return jsonResponse({ retcode: 0, data: { ltoken: 'v2_ltoken_x' } });
  }
  if (u.includes('getCookieAccountInfoBySToken')) {
    return jsonResponse({ retcode: 0, data: { cookie_token: 'v2_ctoken_x', uid: '123456789' } });
  }

  // 设备指纹签发
  if (u.includes('device-fp/api/getFp')) {
    fpRequests += 1;
    return jsonResponse({ data: { code: 200, msg: 'ok', device_fp: 'fp_server_123' } });
  }

  // 实时便笺：按头模拟米游社风控链路
  if (u.includes('/genshin/api/dailyNote')) {
    lastNoteHeaders = h;
    if (!h['x-rpc-device_fp']) return jsonResponse({ retcode: 5003, message: '', data: null });
    if (!h['x-rpc-chellange']) return jsonResponse({ retcode: 1034, message: '', data: null });
    return jsonResponse({
      retcode: 0, message: 'OK',
      data: {
        current_resin: 148, max_resin: 200, resin_recovery_time: 3600,
        finished_task_num: 3, total_task_num: 4,
        current_expedition_num: 4, max_expedition_num: 5,
        remain_resin_discount_num: 2, resin_discount_num_limit: 3,
      },
    });
  }
  if (u.includes('createVerification')) {
    return jsonResponse({
      retcode: 0, message: 'OK',
      data: { gt: 'GT123', challenge: 'GEE_CHALLENGE', new_captcha: 1, success: 1 },
    });
  }
  if (u.includes('verifyVerification')) {
    return jsonResponse({ retcode: 0, message: 'OK', data: { challenge: 'ONETIME_CHALLENGE' } });
  }
  throw new Error(`未预期的请求：${u}`);
};

(async () => {
  const checks = {};

  /* ---- 扫码登录链路 ---- */
  checks.officialUrl = qr.parseQrData({
    url: 'https://user.mihoyo.com/login-platform/mobile.html?tk=abc', ticket: 'abc',
  })?.ticket === 'abc';
  checks.rejectUnofficialUrl = qr.parseQrData({
    url: 'https://evil.example.com/qr', ticket: 'abc',
  }) === null;

  const session = await qr.createSession();
  checks.appMode = session.mode === 'app' && session.ticket === 'TICKET123';
  checks.dsFormat = /^\d{6,},\d{6},[a-f0-9]{32}$/.test(lastDS);

  const r1 = await qr.checkSession(session);
  const r2 = await qr.checkSession(session);
  const r3 = await qr.checkSession(session);
  checks.states = r1.status === 'Init' && r2.status === 'Scanned' && r3.status === 'Confirmed';

  const cred = r3.credential;
  checks.stoken = cred.stoken === 'v2_stoken_xyz';
  checks.derivedTokens = cred.ltoken === 'v2_ltoken_x' && cred.cookieToken === 'v2_ctoken_x';
  checks.cookieComplete = /stoken_v2=v2_stoken_xyz/.test(cred.cookie)
    && /cookie_token=v2_ctoken_x/.test(cred.cookie)
    && /ltuid=123456789/.test(cred.cookie)
    && /mid=mid_abc/.test(cred.cookie);

  const refreshed = await qr.refreshCredential(cred, session.deviceId);
  checks.refresh = refreshed.cookie.includes('cookie_token=v2_ctoken_x');

  appCreateFails = true;
  const webSession = await qr.createSession();
  checks.webFallback = webSession.mode === 'web' && webSession.ticket === 'WEBTICKET';
  await qr.checkSession(webSession);
  const webResult = await qr.checkSession(webSession);
  checks.webConfirmed = webResult.status === 'Confirmed'
    && webResult.credential.cookie.includes('ltoken_v2=v2_ltoken')
    && webResult.credential.cookie.includes('cookie_token_v2=v2_ctoken');

  const dataUrl = await qr.makeQRDataURL('https://user.mihoyo.com/login?tk=abc');
  checks.qrImage = dataUrl.startsWith('data:image/png;base64,') && dataUrl.length > 1000;

  /* ---- 设备指纹 + 风控验证链路 ---- */
  const baseCfg = {
    cookie: cred.cookie, uid: '100000001', server: 'cn_gf01',
    deviceId: 'DEVICE-UUID', maxResin: 200,
  };

  const fp = await devicefp.acquireDeviceFp(baseCfg);
  checks.fpFromServer = fp.fromServer && fp.deviceFp === 'fp_server_123' && fpRequests === 1;

  const fpCfg = {
    ...baseCfg, deviceFp: fp.deviceFp, fpSeed: fp.seed, fpTime: fp.time,
  };

  try {
    await api.fetchNote(baseCfg);
    checks.noFpGives5003 = false;
  } catch (error) {
    checks.noFpGives5003 = error.retcode === 5003 && error.needFpRefresh === true;
  }

  try {
    await api.fetchNote(fpCfg);
    checks.fpGives1034 = false;
  } catch (error) {
    checks.fpGives1034 = error.retcode === 1034 && error.needVerify === true;
  }

  checks.fpHeadersApplied = lastNoteHeaders?.['x-rpc-device_fp'] === 'fp_server_123'
    && /DEVICEFP=fp_server_123/.test(lastNoteHeaders?.Cookie || '')
    && lastNoteHeaders?.['x-rpc-page'] === 'v5.0.1-ys_#/ys/daily';

  const headersOs = { Cookie: 'x=1' };
  checks.fpSkippedForOversea = devicefp.applyDeviceFp({ ...fpCfg, server: 'os_asia' }, headersOs) === false
    && headersOs['x-rpc-device_fp'] === undefined;

  const verification = await api.createVerification(fpCfg, 'TRACE123');
  checks.verificationCreated = verification.gt === 'GT123' && verification.challenge === 'GEE_CHALLENGE';

  const challenge = await api.verifyVerification(fpCfg, {
    geetest_challenge: 'GEE_CHALLENGE', geetest_validate: 'VALIDATE', geetest_seccode: 'SECCODE',
  }, 'TRACE123');
  checks.verificationSubmitted = challenge === 'ONETIME_CHALLENGE';

  let traceSeen = '';
  let challengeConsumed = false;
  const note = await api.fetchNote({ ...fpCfg, challenge }, {
    onTrace: (t) => { traceSeen = t; },
    onChallengeUsed: () => { challengeConsumed = true; },
  });
  checks.noteAfterVerify = note.currentResin === 148 && note.maxResin === 200
    && note.remainingSeconds === 3600 && note.extra.task === '3/4';
  checks.challengeOneTime = challengeConsumed && lastNoteHeaders['x-rpc-chellange'] === 'ONETIME_CHALLENGE';
  checks.traceIdCaptured = traceSeen === 'TRACE123';
  checks.dsWithBody = /^\d{6,},\d{6},[a-f0-9]{32}$/.test(api.makeDS({}, 'salt', '{"a":1}'));

  const ok = Object.values(checks).every(Boolean);
  console.log('PROTOCOL_SELFTEST=' + JSON.stringify({ ok, checks }));
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.error('PROTOCOL_SELFTEST_FAILED', error);
  process.exit(1);
});

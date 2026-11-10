'use strict';

/**
 * 真实网络诊断：用本机已保存的凭证，调用项目里的生产模块复现问题。
 * 只输出字段名 / 错误码，绝不输出 Cookie 或 token 明文。
 * 运行：npm run diagnose
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const api = require('./src/api');
const devicefp = require('./src/devicefp');

// safeStorage 的密钥绑定 userData 目录，诊断进程必须指向同一目录才能解出凭证
const APP_DATA = process.env.APPDATA || app.getPath('appData');
const USER_DATA = path.join(APP_DATA, 'genshin-resin-widget');
try {
  app.setName('genshin-resin-widget');
  app.setPath('userData', USER_DATA);
} catch (_) { /* 某些版本需在 ready 前设置，失败则继续尝试 */ }
const FILE = path.join(USER_DATA, 'widget-config.json');

function unseal(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('plain:')) return Buffer.from(value.slice(6), 'base64').toString('utf8');
  } catch (_) { /* 解密失败 */ }
  return '';
}

function summarizeCookie(cookie) {
  const fields = cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean);
  const has = (n) => fields.includes(n);
  return {
    count: fields.length,
    hasStoken: has('stoken_v2') || has('stoken'),
    hasLtoken: has('ltoken_v2') || has('ltoken'),
    hasCookieToken: has('cookie_token_v2') || has('cookie_token'),
    hasDeviceFp: has('DEVICEFP'),
  };
}

function out(tag, value) {
  console.log(`DIAG_${tag}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

app.whenReady().then(async () => {
  try {
    if (!fs.existsSync(FILE)) { out('RESULT', 'NO_CONFIG'); app.exit(0); return; }
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const data = parsed.config || {};
    const cookie = unseal(data.cookieSealed);
    let credential = null;
    try { credential = JSON.parse(unseal(data.credentialSealed) || 'null'); } catch (_) { /* ignore */ }

    out('CONFIG', {
      source: data.source, uid: data.uid, server: data.server,
      loginMethod: data.loginMethod, accountLabel: data.accountLabel,
      deviceId: data.deviceId ? 'present' : 'missing',
      cachedFp: Boolean(data.deviceFp),
    });
    out('COOKIE', summarizeCookie(cookie));
    out('CREDENTIAL', credential ? {
      mode: credential.mode,
      stoken: Boolean(credential.stoken), mid: Boolean(credential.mid),
      ltoken: Boolean(credential.ltoken), cookieToken: Boolean(credential.cookieToken),
    } : null);

    const base = { ...data, cookie, credential, maxResin: data.maxResin || 200 };

    try {
      const roles = await api.fetchRoles(base);
      out('ROLES', { ok: true, count: roles.length, first: roles[0] });
    } catch (e) { out('ROLES', { ok: false, message: e.message }); }

    // 1) 不带指纹：复现 5003
    try {
      const note = await api.fetchNote({ ...base, deviceFp: '' });
      out('NOTE_NO_FP', { ok: true, resin: note.currentResin });
    } catch (e) {
      out('NOTE_NO_FP', { retcode: e.retcode, needFpRefresh: Boolean(e.needFpRefresh), message: e.message });
    }

    // 2) 申请官方设备指纹
    let fp = null;
    try {
      fp = await devicefp.acquireDeviceFp(base);
      out('DEVICEFP', { fromServer: fp.fromServer, code: fp.code, msg: fp.msg, got: Boolean(fp.deviceFp) });
    } catch (e) { out('DEVICEFP', { error: e.message }); }

    const withFp = fp
      ? { ...base, deviceFp: fp.deviceFp, fpSeed: fp.seed, fpTime: fp.time, deviceId: fp.deviceId }
      : base;

    // 3) 带指纹：应当从 5003 转为 1034
    let traceId = '';
    try {
      const note = await api.fetchNote(withFp, { onTrace: (t) => { traceId = t; } });
      out('NOTE_WITH_FP', { ok: true, resin: note.currentResin, max: note.maxResin });
    } catch (e) {
      out('NOTE_WITH_FP', {
        retcode: e.retcode, needVerify: Boolean(e.needVerify),
        needFpRefresh: Boolean(e.needFpRefresh), message: e.message,
      });
    }
    out('TRACE_ID', traceId ? 'captured' : 'missing');

    // 4) 人机验证任务是否可下发
    let verification = null;
    try {
      verification = await api.createVerification(withFp, traceId || data.traceId || '');
      out('VERIFY_CREATE', { ok: true, hasGt: Boolean(verification.gt), hasChallenge: Boolean(verification.challenge), success: verification.success });
    } catch (e) { out('VERIFY_CREATE', { ok: false, message: e.message }); }

    // 5) 提交格式探测：真 challenge + 无效 validate，只看错误码形态，不完成验证
    if (verification) {
      try {
        await api.verifyVerification(withFp, {
          geetest_challenge: verification.challenge,
          geetest_validate: 'INVALID_PROBE',
          geetest_seccode: 'INVALID_PROBE|jordan',
        }, traceId || data.traceId || '');
        out('VERIFY_SUBMIT_PROBE', 'unexpected-success');
      } catch (e) {
        out('VERIFY_SUBMIT_PROBE', {
          retcode: e.retcode ?? null, message: e.message, keys: e.responseKeys || [],
        });
      }
    }

    out('RESULT', 'DONE');
  } catch (error) {
    out('RESULT', `FATAL ${error.message}`);
  } finally {
    app.exit(0);
  }
});

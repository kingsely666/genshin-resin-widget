'use strict';

/**
 * 实时便笺「现在这一刻」的真实网络诊断。
 * 用本机已保存的凭证，按账号逐个请求 dailyNote，只输出错误码与数值，不输出任何凭证。
 * 运行：npx electron diagnose-live.js
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const api = require('./src/api');
const devicefp = require('./src/devicefp');

const USER_DATA = path.join(process.env.APPDATA || app.getPath('appData'), 'genshin-resin-widget');
try { app.setPath('userData', USER_DATA); } catch (_) { /* ignore */ }
const FILE = path.join(USER_DATA, 'widget-config.json');

function unseal(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('plain:')) return Buffer.from(value.slice(6), 'base64').toString('utf8');
  } catch (_) { /* 解密失败 */ }
  return '';
}

const out = (tag, value) => console.log(`DIAG_${tag}=${typeof value === 'string' ? value : JSON.stringify(value)}`);

function cfgOf(data, acc) {
  let credential = null;
  try {
    const raw = unseal(acc.credentialSealed);
    if (raw) credential = JSON.parse(raw);
  } catch (_) { /* ignore */ }
  const cfg = {
    ...data,
    uid: acc.uid || data.uid,
    server: acc.server || data.server,
    cookie: unseal(acc.cookieSealed),
    credential,
    deviceId: acc.deviceId || '',
    deviceFp: acc.deviceFp || '',
    fpSeed: acc.fpSeed || '',
    fpTime: acc.fpTime || '',
    challenge: acc.challenge || '',
    challengeAt: Number(acc.challengeAt) || 0,
    maxResin: Number(data.maxResin) || 200,
  };
  if (cfg.challenge && (!cfg.challengeAt || Date.now() - cfg.challengeAt > 600000)) cfg.challenge = '';
  return cfg;
}

async function probe(cfg) {
  const trace = { id: '' };
  const hooks = { onTrace: (t) => { trace.id = t; } };
  try {
    const note = await api.fetchNote(cfg, hooks);
    return { ok: true, resin: note.currentResin, max: note.maxResin, remainSec: note.remainingSeconds };
  } catch (error) {
    return {
      ok: false,
      retcode: error.retcode ?? null,
      needVerify: Boolean(error.needVerify),
      needFpRefresh: Boolean(error.needFpRefresh),
      message: error.message,
      hasChallenge: Boolean(cfg.challenge),
      hasFp: Boolean(cfg.deviceFp),
    };
  }
}

app.whenReady().then(async () => {
  try {
    if (!fs.existsSync(FILE)) { out('RESULT', 'NO_CONFIG'); return; }
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const data = parsed.config || {};
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];

    out('ENV', {
      source: data.source,
      syncInterval: data.syncInterval,
      accounts: accounts.length,
      activeAccountId: data.activeAccountId,
      lastSyncAt: Number(data.lastSyncAt) || 0,
      at: new Date().toISOString(),
    });

    for (let i = 0; i < accounts.length; i += 1) {
      const acc = accounts[i];
      const cfg = cfgOf(data, acc);
      const label = acc.nickname || acc.label || `#${i + 1}`;
      out(`ACC${i}_META`, {
        label, uid: acc.uid, server: acc.server,
        loginMethod: acc.loginMethod,
        hasCookie: Boolean(cfg.cookie),
        cookieFields: cfg.cookie ? cfg.cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean) : [],
        hasCredential: Boolean(cfg.credential),
        deviceId: cfg.deviceId ? 'present' : 'missing',
        cachedFp: Boolean(cfg.deviceFp),
        cachedChallenge: Boolean(cfg.challenge),
        syncError: acc.syncError || '',
        errorAt: Number(acc.errorAt) || 0,
      });

      if (!cfg.cookie) { out(`ACC${i}_NOTE`, { ok: false, message: '无 cookie' }); continue; }

      // 1) 原样请求（带缓存指纹 / 一次性令牌）
      let res = await probe(cfg);
      out(`ACC${i}_NOTE`, res);

      // 2) 5003 -> 重新申请指纹后重试一次
      if (!res.ok && res.needFpRefresh) {
        try {
          const fp = await devicefp.acquireDeviceFp(cfg);
          out(`ACC${i}_FP`, { fromServer: fp.fromServer, code: fp.code, got: Boolean(fp.deviceFp) });
          res = await probe({ ...cfg, deviceFp: fp.deviceFp, fpSeed: fp.seed, fpTime: fp.time, deviceId: fp.deviceId });
          out(`ACC${i}_NOTE_RETRY`, res);
        } catch (e) {
          out(`ACC${i}_FP`, { error: e.message });
        }
      }

      // 3) 仍被挡：确认验证任务是否还能下发（只探测，不提交）
      if (!res.ok && res.retcode === 1034) {
        try {
          const v = await api.createVerification(cfg, '');
          out(`ACC${i}_VERIFY`, { ok: true, hasGt: Boolean(v.gt), success: v.success });
        } catch (e) {
          out(`ACC${i}_VERIFY`, { ok: false, message: e.message });
        }
      }

      if (i < accounts.length - 1) await new Promise((r) => setTimeout(r, 1500));
    }

    out('RESULT', 'DONE');
  } catch (error) {
    out('RESULT', `FATAL ${error.message}`);
  } finally {
    app.exit(0);
  }
});

'use strict';

/** 数据层自检：旧配置迁移、多账号隔离、快照路由、缩放边界 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { app } = require('electron');

const DIR = path.join(os.tmpdir(), 'genshin-widget-store-test');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
app.setPath('userData', DIR);

const legacy = {
  config: {
    source: 'mihoyo',
    uid: '100000001',
    server: 'cn_gf01',
    accountLabel: '旧账号 · 100000001',
    loginMethod: 'qr',
    cookieSealed: 'plain:' + Buffer.from('cookie=legacy', 'utf8').toString('base64'),
    credentialSealed: 'plain:' + Buffer.from(JSON.stringify({ stoken: 'st', mid: 'm', stuid: 'u', cookie: 'cookie=legacy' }), 'utf8').toString('base64'),
    deviceId: 'dev-legacy',
    deviceFp: 'fp-legacy',
    fpSeed: 'seed-legacy',
    fpTime: '1700000000000',
    challenge: 'ch-legacy',
    challengeAt: Date.now(),
    traceId: 'trace-legacy',
    syncInterval: 60,
  },
  note: { currentResin: 120, maxResin: 200, remainingSeconds: 1000, syncedAt: Date.now(), source: 'mihoyo' },
};
fs.writeFileSync(path.join(DIR, 'widget-config.json'), JSON.stringify(legacy), 'utf8');

app.whenReady().then(() => {
  const { Store } = require('./src/store');
  const out = {};
  const store = new Store();
  const firstId = store.config.activeAccountId;

  // 1) 旧单账号配置迁移
  out.migratedAccounts = store.config.accounts.length;
  out.migratedUid = store.activeAccount ? store.activeAccount.uid : '';
  out.migratedCookie = store.privateConfig.cookie;
  out.migratedFp = store.privateConfig.deviceFp;
  out.migratedChallenge = store.privateConfig.challenge;
  out.migratedTrace = store.privateConfig.traceId;
  out.migratedInterval = store.config.syncInterval;
  out.migratedNote = store.noteSnapshot ? store.noteSnapshot.currentResin : null;
  out.legacyKeysRemoved = !('cookieSealed' in store.config) && !('deviceFp' in store.config);

  // 2) 新增第二个账号并切换
  store.upsertAccount(
    { uid: '200000002', server: 'cn_gf01', nickname: '小号' },
    { cookie: 'cookie=second', mode: 'app', stoken: 's2', mid: 'm2', stuid: 'u2' }
  );
  const secondId = store.config.activeAccountId;
  out.accountsAfterUpsert = store.config.accounts.length;
  out.activeUid = store.activeAccount.uid;
  out.secondCookie = store.privateConfig.cookie;
  out.secondFpBeforeSet = store.privateConfig.deviceFp;

  // 3) 指纹 / challenge 按账号隔离
  store.setDeviceFp({ deviceFp: 'fp-second', seed: 'seed-2', time: '1700000001000' });
  store.setChallenge('ch-second');
  store.setTraceId('trace-second');
  out.secondFp = store.privateConfig.deviceFp;
  store.switchAccount(firstId);
  out.firstFpAfterSwitch = store.privateConfig.deviceFp;
  out.firstChallengeAfterSwitch = store.privateConfig.challenge;
  out.firstTraceAfterSwitch = store.privateConfig.traceId;

  // 4) 快照按账号路由
  store.setNote({ currentResin: 50, maxResin: 200, remainingSeconds: 100, syncedAt: Date.now(), source: 'mihoyo' });
  out.firstNote = store.noteSnapshot ? store.noteSnapshot.currentResin : null;
  store.switchAccount(secondId);
  out.secondNote = store.noteSnapshot ? store.noteSnapshot.currentResin : null;

  // 5) 缩放边界
  out.scaleHigh = store.patch({ uiScale: 5 }).uiScale;
  out.scaleLow = store.patch({ uiScale: 0.1 }).uiScale;
  out.scaleNormal = store.patch({ uiScale: 1.25 }).uiScale;

  // 6) 删除账号与源降级
  store.removeAccount(secondId);
  out.accountsAfterRemove = store.config.accounts.length;
  out.activeAfterRemove = store.activeAccount ? store.activeAccount.uid : '';
  store.removeAccount(store.config.activeAccountId);
  out.accountsAfterRemoveAll = store.config.accounts.length;
  out.sourceAfterRemoveAll = store.config.source;

  // 7) publicConfig 不泄露凭证
  const pub = store.publicConfig;
  out.noSealedLeak = !('cookieSealed' in pub) && !('credentialSealed' in pub) && !('deviceId' in pub);

  const ok = out.migratedAccounts === 1
    && out.migratedUid === '100000001'
    && out.migratedCookie === 'cookie=legacy'
    && out.migratedFp === 'fp-legacy'
    && out.migratedChallenge === 'ch-legacy'
    && out.migratedTrace === 'trace-legacy'
    && out.migratedInterval === 300
    && out.migratedNote === 120
    && out.legacyKeysRemoved
    && out.accountsAfterUpsert === 2
    && out.activeUid === '200000002'
    && out.secondCookie === 'cookie=second'
    && out.secondFpBeforeSet === ''
    && out.secondFp === 'fp-second'
    && out.firstFpAfterSwitch === 'fp-legacy'
    && out.firstChallengeAfterSwitch === 'ch-legacy'
    && out.firstTraceAfterSwitch === 'trace-legacy'
    && out.firstNote === 50
    && out.secondNote === null
    && out.scaleHigh === 1.8
    && out.scaleLow === 0.7
    && out.scaleNormal === 1.25
    && out.accountsAfterRemove === 1
    && out.activeAfterRemove === '100000001'
    && out.accountsAfterRemoveAll === 0
    && out.sourceAfterRemoveAll === 'local'
    && out.noSealedLeak;

  console.log('STORE_SELFTEST=' + JSON.stringify({ ok, ...out }));
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error('STORE_SELFTEST_FAILED', error);
  app.exit(1);
});

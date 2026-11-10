'use strict';

/** 启动包装器：清掉宿主可能注入的 ELECTRON_RUN_AS_NODE，保证 Electron 以 GUI 模式运行 */
const { spawn } = require('node:child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// 允许把入口脚本作为参数传入（自检脚本复用同一启动包装器）
const args = process.argv.slice(2);
const child = spawn(electron, args.length ? args : ['.'], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code) => process.exit(code === null ? 0 : code));
child.on('error', (error) => {
  console.error('启动失败：', error.message);
  process.exit(1);
});

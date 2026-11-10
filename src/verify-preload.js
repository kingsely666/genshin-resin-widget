'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('verifyBridge', {
  // 页面主动拉取，避免 did-finish-load 发送时页面脚本尚未注册的竞态
  getInit: () => ipcRenderer.invoke('verify:init:get'),
  // 主进程也可推送（重试时刷新任务）
  onInit: (callback) => ipcRenderer.on('verify:init', (_, data) => callback(data)),
  onFailed: (callback) => ipcRenderer.on('verify:failed', (_, message) => callback(message)),
  submit: (validate) => ipcRenderer.send('verify:submit', validate),
  retry: () => ipcRenderer.invoke('verify:retry'),
  close: () => ipcRenderer.send('verify:close'),
});

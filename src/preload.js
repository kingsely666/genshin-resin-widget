'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 命名避开 HTML 元素的 window 具名属性（例如 id="widget"）
contextBridge.exposeInMainWorld('resinWidget', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  calibrate: (payload) => ipcRenderer.invoke('note:calibrate', payload),
  fetchRoles: () => ipcRenderer.invoke('roles:fetch'),
  qrStart: () => ipcRenderer.invoke('qr:start'),
  qrCancel: () => ipcRenderer.invoke('qr:cancel'),
  verifyStart: () => ipcRenderer.invoke('verify:start'),
  logout: () => ipcRenderer.invoke('account:logout'),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  updateAccount: (id, patch) => ipcRenderer.invoke('account:update', { id, patch }),
  setScale: (value) => ipcRenderer.invoke('scale:set', value),
  fitHeight: (height) => ipcRenderer.send('window:fit-height', height),
  setView: (name) => ipcRenderer.send('window:view', name),
  setSurface: (interactive) => ipcRenderer.send('window:surface', Boolean(interactive)),
  dragStart: (x, y) => ipcRenderer.send('window:drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('window:drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  windowAction: (action) => ipcRenderer.send('window:action', action),
  onNote: (callback) => ipcRenderer.on('note:update', (_, note) => callback(note)),
  onStatus: (callback) => ipcRenderer.on('status:update', (_, status) => callback(status)),
  onSettings: (callback) => ipcRenderer.on('ui:settings', () => callback()),
  onConfig: (callback) => ipcRenderer.on('config:update', (_, config) => callback(config)),
  onQrUpdate: (callback) => ipcRenderer.on('qr:update', (_, payload) => callback(payload)),
  onQrRequest: (callback) => ipcRenderer.on('ui:qr', () => callback()),
  onAccountsRequest: (callback) => ipcRenderer.on('ui:accounts', () => callback()),
  onToast: (callback) => ipcRenderer.on('ui:toast', (_, message) => callback(message)),
});

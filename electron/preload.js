'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File dialogs
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),

  // Job lifecycle
  startJob: (payload) => ipcRenderer.invoke('job:start', payload),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),

  // Streaming events from main → renderer
  onJobProgress: (cb) => ipcRenderer.on('job:progress', (_e, v) => cb(v)),
  onJobState:    (cb) => ipcRenderer.on('job:state',    (_e, v) => cb(v)),
  onJobError:    (cb) => ipcRenderer.on('job:error',    (_e, v) => cb(v)),
  // job:done carries the final output path reported by the backend
  onJobDone:     (cb) => ipcRenderer.on('job:done',     (_e, v) => cb(v)),
  onJobMeta:     (cb) => ipcRenderer.on('job:meta',     (_e, v) => cb(v)),
  onPreviewReady:(cb) => ipcRenderer.on('job:preview-ready', (_e, v) => cb(v)),
  // {degraded, total} — frames the temporal engine could not rebuild
  onTemporalFallback: (cb) => ipcRenderer.on('job:temporal-fallback', (_e, v) => cb(v)),
  // {kind, detail} — the learned engine stood aside, or ran a lower preset
  onDeepNotice: (cb) => ipcRenderer.on('job:deep-notice', (_e, v) => cb(v)),

  // Auto-update
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, v) => cb(v)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_e, v) => cb(v)),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Licensing: the state machine lives in the main process, which owns the
  // token and talks to the shared license service (docs/LICENSE_SERVICE.md).
  licenseState: () => ipcRenderer.invoke('license:getState'),
  licenseActivate: (licenseKey) => ipcRenderer.invoke('license:activate', licenseKey),
  licenseDeactivate: () => ipcRenderer.invoke('license:deactivate'),
  licenseRefresh: () => ipcRenderer.invoke('license:refresh'),
  licenseConfig: () => ipcRenderer.invoke('license:getConfig'),
  // Pushed whenever the trial, a payment or a background refresh changes it.
  onLicenseState: (cb) => ipcRenderer.on('license:state-changed', (_e, v) => cb(v)),

  // Payment: plans and methods come from the service, which is the only
  // place prices and availability are decided.
  paymentPlans: () => ipcRenderer.invoke('payment:getPlans'),
  paymentMethods: (lang) => ipcRenderer.invoke('payment:getMethods', lang),
  paymentCreateOrder: (planId, method) => ipcRenderer.invoke('payment:createOrder', planId, method),
  paymentOrderStatus: (orderId) => ipcRenderer.invoke('payment:orderStatus', orderId),
  paymentHistory: () => ipcRenderer.invoke('payment:history'),
  // A checkout page belongs to the payment provider: it opens in the system
  // browser, or in a plain child window for the methods that show a QR code.
  paymentOpenExternal: (url) => ipcRenderer.invoke('payment:openExternal', url),
  paymentOpenEmbedded: (url) => ipcRenderer.invoke('payment:openEmbedded', url),
  paymentCloseEmbedded: () => ipcRenderer.invoke('payment:closeEmbedded'),
  onPaymentWindowClosed: (cb) => ipcRenderer.on('payment:window-closed', () => cb()),

  // Host platform
  systemInfo: () => ipcRenderer.invoke('system:info'),
  tempDir: () => ipcRenderer.invoke('system:tempDir'),
  notify: (title, body) => ipcRenderer.invoke('system:notify', title, body),

  removeLicenseListeners: () => {
    ipcRenderer.removeAllListeners('license:state-changed');
    ipcRenderer.removeAllListeners('payment:window-closed');
  },

  // Remove all listeners (call on component unmount)
  removeJobListeners: () => {
    ['job:progress','job:state','job:error','job:done','job:meta','job:preview-ready',
     'job:temporal-fallback','job:deep-notice']
      .forEach((ch) => ipcRenderer.removeAllListeners(ch));
  },
});

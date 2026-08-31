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

  // Subscription: state is owned by the main process, which persists it
  subscriptionStatus: () => ipcRenderer.invoke('subscription:getStatus'),
  subscribe: (plan, paymentMethod) => ipcRenderer.invoke('subscription:subscribe', plan, paymentMethod),
  cancelAutoRenew: () => ipcRenderer.invoke('subscription:cancel'),

  // Host platform
  systemInfo: () => ipcRenderer.invoke('system:info'),
  tempDir: () => ipcRenderer.invoke('system:tempDir'),
  notify: (title, body) => ipcRenderer.invoke('system:notify', title, body),

  // Remove all listeners (call on component unmount)
  removeJobListeners: () => {
    ['job:progress','job:state','job:error','job:done','job:meta','job:preview-ready',
     'job:temporal-fallback','job:deep-notice']
      .forEach((ch) => ipcRenderer.removeAllListeners(ch));
  },
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File dialogs
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),

  // Python hello (Epic 1 validation)
  runPython: (payload) => ipcRenderer.invoke('python:run', payload),

  // Job lifecycle
  startJob: (payload) => ipcRenderer.invoke('job:start', payload),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),

  // Streaming events from main → renderer
  onJobProgress: (cb) => ipcRenderer.on('job:progress', (_e, v) => cb(v)),
  onJobState:    (cb) => ipcRenderer.on('job:state',    (_e, v) => cb(v)),
  onJobError:    (cb) => ipcRenderer.on('job:error',    (_e, v) => cb(v)),
  onJobDone:     (cb) => ipcRenderer.on('job:done',     (_e) => cb()),
  onJobMeta:     (cb) => ipcRenderer.on('job:meta',     (_e, v) => cb(v)),
  onPreviewReady:(cb) => ipcRenderer.on('job:preview-ready', (_e, v) => cb(v)),

  // Remove all listeners (call on component unmount)
  removeJobListeners: () => {
    ['job:progress','job:state','job:error','job:done','job:meta','job:preview-ready']
      .forEach((ch) => ipcRenderer.removeAllListeners(ch));
  },
});

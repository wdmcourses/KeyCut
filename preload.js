const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('keycut', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  getOpenFile: () => ipcRenderer.invoke('get-open-file'),
  onOpenFile: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('app:open-file', listener);
    return () => ipcRenderer.removeListener('app:open-file', listener);
  },
  saveProjectDialog: (defaultName) => ipcRenderer.invoke('dialog:saveProject', defaultName),
  saveExportDialog: (defaultName) => ipcRenderer.invoke('dialog:saveExport', defaultName),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  getFilePath: (file) => webUtils.getPathForFile(file),

  probeVideo: (filePath) => ipcRenderer.invoke('probe:video', filePath),
  probeQuick: (p) => ipcRenderer.invoke('probe:quick', p),
  renderWaveform: (filePath, opts) => ipcRenderer.invoke('waveform:render', { filePath, ...opts }),
  ffmpegPath: () => ipcRenderer.invoke('ffmpegPath'),
  lockSource: (filePath) => ipcRenderer.invoke('source:lock', filePath),
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  chooseFile: () => ipcRenderer.invoke('dialog:chooseFile'),
  workArea: () => ipcRenderer.invoke('screen:workArea'),
  setWindowSize: (width, height) => ipcRenderer.invoke('win:setSize', { width, height }),
  setWindowContentSize: (width, height, frameW, frameH) => ipcRenderer.invoke('win:setContentSize', { width, height, frameW, frameH }),
  setWindowBounds: (bounds) => ipcRenderer.invoke('win:setBounds', bounds),

  saveProject: (filePath, data) => ipcRenderer.invoke('project:save', { filePath, data }),
  loadProject: (filePath) => ipcRenderer.invoke('project:load', filePath),
  resolveProjectSource: (projectPath, rel) => ipcRenderer.invoke('project:resolveSource', { projectPath, rel }),

  exportStart: (payload) => ipcRenderer.invoke('export:start', payload),
  onExportProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },

  convertAnalyze: (payload) => ipcRenderer.invoke('convert:analyze', payload),
  convertStart: (payload) => ipcRenderer.invoke('convert:start', payload),
  convertCancel: () => ipcRenderer.invoke('convert:cancel'),
  convertRemoveOutput: (payload) => ipcRenderer.invoke('convert:remove-output', payload),
  onConvertAnalyzeProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('convert:analyze-progress', listener);
    return () => ipcRenderer.removeListener('convert:analyze-progress', listener);
  },
  onConvertProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('convert:progress', listener);
    return () => ipcRenderer.removeListener('convert:progress', listener);
  },

  confirmClose: () => ipcRenderer.invoke('dialog:confirmClose'),
  forceClose: () => ipcRenderer.send('app:force-close'),
  onCloseRequest: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('app:request-close', listener);
    return () => ipcRenderer.removeListener('app:request-close', listener);
  }
});
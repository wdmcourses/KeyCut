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
  openProjectDialog: () => ipcRenderer.invoke('dialog:openProject'),
  recentsList: () => ipcRenderer.invoke('recents:list'),
  recentsAdd: (filePath) => ipcRenderer.invoke('recents:add', filePath),
  recentsClear: () => ipcRenderer.invoke('recents:clear'),

  compatStart: (opts) => ipcRenderer.invoke('compat:start', opts),
  compatChunk: () => ipcRenderer.invoke('compat:chunk'),
  compatStderr: () => ipcRenderer.invoke('compat:stderr'),
  compatStop: () => ipcRenderer.invoke('compat:stop'),
  compatDeleteDummy: (dummyPath) => ipcRenderer.invoke('compat:deleteDummy', dummyPath),
  compatEnsureDummy: (opts) => ipcRenderer.invoke('compat:ensureDummy', opts),
  onCompatDummyProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('compat:dummy-progress', listener);
    return () => ipcRenderer.removeListener('compat:dummy-progress', listener);
  },
  saveExportDialog: (defaultName, compress, allowedExts) => ipcRenderer.invoke('dialog:saveExport', defaultName, compress, allowedExts),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  getFilePath: (file) => webUtils.getPathForFile(file),

  probeVideo: (filePath) => ipcRenderer.invoke('probe:video', filePath),
  probeQuick: (p) => ipcRenderer.invoke('probe:quick', p),
  probeJoinable: (files) => ipcRenderer.invoke('probe:joinable', { files }),
  renderWaveform: (filePath, opts) => ipcRenderer.invoke('waveform:render', { filePath, ...opts }),
  ffmpegPath: () => ipcRenderer.invoke('ffmpegPath'),
  fileExists: (p) => ipcRenderer.invoke('file:exists', p),
  renameFileLocked: (payload) => ipcRenderer.invoke('file:renameLocked', payload),
  deleteFile: (p) => ipcRenderer.invoke('file:delete', p),
  chooseFile: () => ipcRenderer.invoke('dialog:chooseFile'),
  chooseFiles: () => ipcRenderer.invoke('dialog:chooseFiles'),
  concatJoin: (payload) => ipcRenderer.invoke('concat:join', payload),
  concatCancel: () => ipcRenderer.invoke('concat:cancel'),
  concatCopyOutput: (payload) => ipcRenderer.invoke('concat:copy-output', payload),
  concatRemoveOutput: (payload) => ipcRenderer.invoke('concat:remove-output', payload),
  onConcatProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('concat:progress', listener);
    return () => ipcRenderer.removeListener('concat:progress', listener);
  },
  workArea: () => ipcRenderer.invoke('screen:workArea'),
  setTitle: (title) => ipcRenderer.send('win:set-title', title),
  setWindowSize: (width, height) => ipcRenderer.invoke('win:setSize', { width, height }),
  setWindowContentSize: (width, height, frameW, frameH) => ipcRenderer.invoke('win:setContentSize', { width, height, frameW, frameH }),
  setWindowBounds: (bounds) => ipcRenderer.invoke('win:setBounds', bounds),
  centerWindowOn: (center) => ipcRenderer.invoke('win:centerOn', center),

  saveProject: (filePath, data) => ipcRenderer.invoke('project:save', { filePath, data }),
  loadProject: (filePath) => ipcRenderer.invoke('project:load', filePath),
  loadProjectTimeline: (filePath, id) => ipcRenderer.invoke('project:loadTimeline', { filePath, id }),
  loadProjectTimelines: (filePath, ids) => ipcRenderer.invoke('project:loadTimelines', { filePath, ids }),
  resolveProjectSource: (projectPath, rel) => ipcRenderer.invoke('project:resolveSource', { projectPath, rel }),

  exportStart: (payload) => ipcRenderer.invoke('export:start', payload),
  exportProject: (payload) => ipcRenderer.invoke('export:project', payload),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
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
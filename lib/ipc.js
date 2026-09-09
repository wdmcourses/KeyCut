const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { probeVideo } = require('./probe');
const { saveProject, loadProject } = require('./project');
const { startExport } = require('./export');





function resolveFfmpegPath(appRoot) {
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cands = [
    path.join(process.resourcesPath, bin),
    path.join(appRoot, 'vendor', 'ffmpeg', bin)
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'ffmpeg';
}

function registerIpc(getWindow, appRoot, tmpDir) {
  ipcMain.handle('dialog:openFile', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Open',
      properties: ['openFile'],
      filters: [
        { name: 'All supported files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'ts', 'flv', 'wmv', 'mts', 'm2ts', 'kc'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('dialog:saveExport', async (_e, defaultName) => {
    const res = await dialog.showSaveDialog(getWindow(), {
      title: 'Export Lossless',
      defaultPath: defaultName || 'output.mp4',
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'ts', 'mts', 'm2ts', 'flv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose export folder',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('dialog:saveProject', async (_e, defaultName) => {
    const res = await dialog.showSaveDialog(getWindow(), {
      title: 'Save Project',
      defaultPath: defaultName || 'project.kc',
      filters: [{ name: 'KeyCut project', extensions: ['kc'] }]
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath;
  });

  ipcMain.handle('dialog:confirmClose', async () => {
    const res = await dialog.showMessageBox(getWindow(), {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'The project has unsaved changes.',
      detail: 'What do you want to do?',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    return ['save', 'discard', 'cancel'][res.response];
  });

  ipcMain.handle('probe:video', async (_e, filePath) => {
    try {
      return await probeVideo(filePath, resolveFfmpegPath(appRoot));
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ffmpegPath', () => resolveFfmpegPath(appRoot));

  ipcMain.handle('export:start', async (event, payload) => {
    const { sourcePath, segments, outputPath } = payload;
    if (!sourcePath || !Array.isArray(segments) || !segments.length || !outputPath) {
      return { ok: false, error: 'Invalid export parameters' };
    }
    const send = (evt, data) => { if (!event.sender.isDestroyed()) event.sender.send(evt, data); };
    try {
      const dir = path.join(tmpDir, 'part-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      const result = await startExport({
        src: sourcePath,
        segments,
        out: outputPath,
        tmpDir: dir,
        ffmpeg: resolveFfmpegPath(appRoot),
        onProgress: (p) => send('export:progress', p),
        videoTimebase: payload.videoTimebase,
        hasThumbnail: payload.hasThumbnail,
        streams: payload.streams
      });
      try { fs.rmdirSync(tmpDir); } catch {}
      return { ok: true, ...result };
    } catch (err) {
      send('export:progress', { phase: 'error', message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('project:save', async (_e, payload) => {
    const { filePath, data } = payload;
    try {
      await saveProject(filePath, data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('project:load', async (_e, filePath) => {
    try {
      return await loadProject(filePath);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerIpc, resolveFfmpegPath };
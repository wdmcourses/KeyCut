const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { probeVideo } = require('./probe');
const { saveProject, loadProject } = require('./project');
const { startExport } = require('./export');

// Cross-platform ffmpeg resolution:
//  1) bundled flat in resources/ (packaged, next to app code - LosslessCut style)
//  2) vendor/ffmpeg/ in the repo (dev)
//  3) system PATH fallback
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
        { name: 'Media files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'ts', 'flv', 'wmv', 'mts', 'm2ts'] },
        { name: 'KeyCut project', extensions: ['kc'] },
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
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath;
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

  ipcMain.handle('dialog:confirm', async (_e, message) => {
    const res = await dialog.showMessageBox(getWindow(), {
      type: 'warning',
      message: message || 'Continue?',
      buttons: ['Continue', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    });
    return res.response === 0;
  });

  // Unsaved-changes prompt when closing/opening over a dirty project.
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
      const result = await startExport({
        src: sourcePath,
        segments,
        out: outputPath,
        tmpDir,
        ffmpeg: resolveFfmpegPath(appRoot),
        onProgress: (p) => send('export:progress', p)
      });
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
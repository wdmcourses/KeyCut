const { ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { probeVideo, probeQuick } = require('./probe');
const { saveProject, loadProject } = require('./project');
const { startExport } = require('./export');
const { renderWaveformPng } = require('./waveform');

const MIN_WIN_W = 900;
const MIN_WIN_H = 560;





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

  ipcMain.handle('file:exists', (_e, p) => !!p && fs.existsSync(p));

  ipcMain.handle('probe:quick', async (_e, filePath) => {
    if (!filePath) return { error: 'No path' };
    try {
      return await probeQuick(filePath, resolveFfmpegPath(appRoot));
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('dialog:chooseFile', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Locate source file',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'ts', 'flv', 'wmv', 'mts', 'm2ts'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

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
    const backPath = filePath + '.back';
    const cleanup = async () => { try { await fs.promises.unlink(backPath); } catch {} };
    try {
      await saveProject(backPath, data);
      try {
        await fs.promises.rename(backPath, filePath);
      } catch (e) {
        await fs.promises.unlink(filePath).catch(() => {});
        await fs.promises.rename(backPath, filePath);
      }
      await cleanup();
      return { ok: true };
    } catch (err) {
      await cleanup();
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

  ipcMain.handle('project:resolveSource', (_e, { projectPath, rel }) => {
    if (!rel) return { path: null };
    const p = path.resolve(path.dirname(projectPath), rel.split('/').join(path.sep));
    try {
      return { path: fs.existsSync(p) ? p : null };
    } catch {
      return { path: null };
    }
  });

  ipcMain.handle('waveform:render', async (_e, { filePath, start, duration, streamIndex, width, height }) => {
    try {
      const buf = await renderWaveformPng({
        filePath,
        start,
        duration,
        streamIndex,
        width,
        height,
        ffmpeg: resolveFfmpegPath(appRoot)
      });
      return { ok: true, data: buf };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('screen:workArea', () => {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    return { width: wa.width, height: wa.height };
  });
  ipcMain.handle('win:setSize', (_e, { width, height }) => {
    const win = getWindow();
    if (!win) return;
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const w = Math.max(MIN_WIN_W, Math.min(Math.round(width), wa.width));
    const h = Math.max(MIN_WIN_H, Math.min(Math.round(height), wa.height));
    win.setMinimumSize(MIN_WIN_W, MIN_WIN_H);
    win.setSize(w, h);
  });
  ipcMain.handle('win:setBounds', (_e, bounds) => {
    const win = getWindow();
    if (!win || !bounds) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const w = Math.max(MIN_WIN_W, Math.min(Math.round(bounds.w || MIN_WIN_W), wa.width));
    const h = Math.max(MIN_WIN_H, Math.min(Math.round(bounds.h || MIN_WIN_H), wa.height));
    let x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : wa.x;
    let y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : wa.y;
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
    win.setMinimumSize(MIN_WIN_W, MIN_WIN_H);
    win.setBounds({ x, y, width: w, height: h });
  });
}

module.exports = { registerIpc, resolveFfmpegPath };
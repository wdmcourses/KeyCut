const { ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { probeVideo, probeQuick } = require('./probe');
const { saveProject, loadProject } = require('./project');
const { startExport, killExport } = require('./export');
const { analyzeKeyframes, startConvert, killCurrent } = require('./convert');
const { joinFiles, killConcat } = require('./concat');
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

  ipcMain.handle('dialog:saveExport', async (_e, defaultName, compress) => {
    const res = await dialog.showSaveDialog(getWindow(), {
      title: compress ? 'Render' : 'Export Lossless',
      defaultPath: defaultName || 'output.mp4',
      filters: compress
        ? [{ name: 'MP4 video', extensions: ['mp4'] }, { name: 'All files', extensions: ['*'] }]
        : [
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

  ipcMain.handle('dialog:chooseFiles', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose video files to join',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'ts', 'flv', 'wmv', 'mts', 'm2ts'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths;
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
        streams: payload.streams,
        compress: payload.compress,
        resolution: payload.resolution,
        duration: payload.duration
      });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return { ok: true, ...result };
    } catch (err) {
      send('export:progress', { phase: 'error', message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('export:cancel', () => {
    killExport();
    return { ok: true };
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
    const win = getWindow();
    const wa = win ? screen.getDisplayMatching(win.getBounds()).workAreaSize : screen.getPrimaryDisplay().workAreaSize;
    return { width: wa.width, height: wa.height };
  });
  ipcMain.handle('win:setSize', (_e, { width, height }) => {
    const win = getWindow();
    if (!win) return;
    const wa = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    const w = Math.max(MIN_WIN_W, Math.min(Math.round(width), wa.width));
    const h = Math.max(MIN_WIN_H, Math.min(Math.round(height), wa.height));
    win.setMinimumSize(MIN_WIN_W, MIN_WIN_H);
    win.setSize(w, h);
  });
  ipcMain.handle('win:setContentSize', (_e, { width, height, frameW, frameH }) => {
    const win = getWindow();
    if (!win) return;
    const wa = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    const cb = win.getContentBounds();
    const ob = win.getBounds();
    const fw = Number.isFinite(frameW) ? frameW : (ob.width - cb.width);
    const fh = Number.isFinite(frameH) ? frameH : (ob.height - cb.height);
    const w = Math.min(Math.round(width), wa.width - fw);
    const h = Math.min(Math.round(height), wa.height - fh);
    win.setMinimumSize(MIN_WIN_W, MIN_WIN_H);
    win.setContentSize(w, h);
  });
  ipcMain.handle('win:setBounds', (_e, bounds) => {
    const win = getWindow();
    if (!win || !bounds) return;
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const w = Math.max(MIN_WIN_W, Math.min(Math.round(bounds.w || MIN_WIN_W), wa.width));
    const h = Math.max(MIN_WIN_H, Math.min(Math.round(bounds.h || MIN_WIN_H), wa.height));
    let x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : wa.x;
    let y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : wa.y;
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
    win.setMinimumSize(MIN_WIN_W, MIN_WIN_H);
    win.setBounds({ x, y, width: w, height: h });
  });

  ipcMain.handle('convert:analyze', async (event, { src, duration }) => {
    const ffmpeg = resolveFfmpegPath(appRoot);
    const send = (evt, data) => { if (!event.sender.isDestroyed()) event.sender.send(evt, data); };
    try {
      const result = await analyzeKeyframes({
        src,
        duration,
        ffmpeg,
        onProgress: (done, total) => send('convert:analyze-progress', { progress: done / total })
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('convert:start', async (event, { src, duration, interval }) => {
    const ffmpeg = resolveFfmpegPath(appRoot);
    const dir = path.dirname(src);
    const base = path.basename(src, path.extname(src));
    const out = path.join(dir, base + '_keyframed.mkv');
    const send = (evt, data) => { if (!event.sender.isDestroyed()) event.sender.send(evt, data); };
    try {
      const result = await startConvert({
        src,
        out,
        ffmpeg,
        duration,
        interval,
        onProgress: (p) => send('convert:progress', { progress: p })
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('convert:cancel', () => {
    killCurrent();
    return { ok: true };
  });

  ipcMain.handle('convert:remove-output', async (event, { out } = {}) => {
    if (typeof out === 'string' && out) await fs.promises.unlink(out).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('concat:join', async (event, { files } = {}) => {
    if (!Array.isArray(files) || files.length < 2) return { ok: false, error: 'At least two files are required' };
    const ffmpeg = resolveFfmpegPath(appRoot);
    const send = (evt, data) => { if (!event.sender.isDestroyed()) event.sender.send(evt, data); };
    try {
      const metas = [];
      let totalDuration = 0;
      for (const f of files) {
        const q = await probeQuick(f, ffmpeg);
        if (!q) { return { ok: false, error: 'Failed to probe: ' + f }; }
        if (q.duration) totalDuration += q.duration;
        metas.push(q);
      }
      const base = metas[0];
      for (let i = 1; i < metas.length; i++) {
        const m = metas[i];
        if (!m.width || !m.height || !base.width || !base.height) continue;
        if (m.width !== base.width || m.height !== base.height) {
          return { ok: false, error: 'Cannot join: resolution mismatch (' + base.width + 'x' + base.height + ' vs ' + m.width + 'x' + m.height + ')' };
        }
        if (base.fps && m.fps) {
          const rel = Math.abs(m.fps - base.fps) / Math.max(base.fps, m.fps);
          if (rel > 0.1) {
            return { ok: false, error: 'Cannot join: frame rate differs too much (' + base.fps.toFixed(2) + ' vs ' + m.fps.toFixed(2) + ' fps)' };
          }
        }
        if (base.codec && m.codec && base.codec !== m.codec) {
          return { ok: false, error: 'Cannot join: video codec mismatch (' + base.codec + ' vs ' + m.codec + ')' };
        }
        if (base.sarNum && m.sarNum && base.sarDen && m.sarDen && (base.sarNum / base.sarDen !== m.sarNum / m.sarDen)) {
          return { ok: false, error: 'Cannot join: pixel aspect ratio mismatch (SAR ' + base.sarNum + ':' + base.sarDen + ' vs ' + m.sarNum + ':' + m.sarDen + ')' };
        }
        if (base.audioCodec && m.audioCodec && base.audioCodec !== m.audioCodec) {
          return { ok: false, error: 'Cannot join: audio codec mismatch (' + base.audioCodec + ' vs ' + m.audioCodec + ')' };
        }
        if (base.audioRate && m.audioRate && base.audioRate !== m.audioRate) {
          return { ok: false, error: 'Cannot join: audio rate mismatch (' + base.audioRate + ' Hz vs ' + m.audioRate + ' Hz)' };
        }
        if (base.audioChannels && m.audioChannels && base.audioChannels !== m.audioChannels) {
          return { ok: false, error: 'Cannot join: audio channels mismatch (' + base.audioChannels + ' vs ' + m.audioChannels + ')' };
        }
      }
      const result = await joinFiles({
        files,
        ffmpeg,
        totalDuration,
        onProgress: (p) => send('concat:progress', { progress: p })
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('concat:cancel', () => {
    killConcat();
    return { ok: true };
  });

  ipcMain.handle('concat:remove-output', async (event, { out } = {}) => {
    if (typeof out === 'string' && out) await fs.promises.unlink(out).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('concat:copy-output', async (event, { from, to } = {}) => {
    try {
      if (from && to && from !== to) await fs.promises.copyFile(from, to);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerIpc, resolveFfmpegPath };
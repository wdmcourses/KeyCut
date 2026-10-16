const { ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { probeVideo, probeQuick, probeStreams } = require('./probe');
const { saveProject, loadProject, loadProjectTimeline, loadProjectTimelines } = require('./project');
const { startExport, killExport } = require('./export');
const { LOSSLESS_EXTS, preferredLosslessExt } = require('./formats');
const { analyzeKeyframes, startConvert, killCurrent } = require('./convert');
const { killConcat, outputNameFor } = require('./concat');
const { assertJoinable, joinSources } = require('./joinutil');
const { renderWaveformPng } = require('./waveform');
const { recentsList, recentsAdd, recentsClear } = require('./recents');
const { listExtensions, downloadExtension, resolveTools } = require('./extensions');
const { collectDropped } = require('./folder');
const { startCompat, readCompatChunk, compatStderr, stopCompat, makeDummy, dummyPathFor } = require('./compatPlayer');

const MIN_WIN_W = 900;
const MIN_WIN_H = 560;





function resolveFfmpegPath(appRoot) {
  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cands = [
    path.join(process.resourcesPath, bin),
    path.join(appRoot, 'vendor', 'ffmpeg', process.platform, bin),
    path.join(appRoot, 'vendor', 'ffmpeg', bin)
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'ffmpeg';
}

function clearPreviewFiles(dir, keepPath) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('preview-')) continue;
      const full = path.join(dir, f);
      if (keepPath && full === keepPath) continue;
      for (let i = 0; i < 4; i++) {
        try { fs.unlinkSync(full); break; } catch {}
      }
    }
  } catch {}
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

  ipcMain.handle('dialog:saveExport', async (_e, defaultName, compress, allowedExts) => {
    const losslessExts = Array.isArray(allowedExts) && allowedExts.length
      ? allowedExts
      : LOSSLESS_EXTS;
    const res = await dialog.showSaveDialog(getWindow(), {
      title: compress ? 'Render' : 'Export Lossless',
      defaultPath: defaultName || 'output.mp4',
      filters: compress
        ? [{ name: 'MP4 video', extensions: ['mp4'] }, { name: 'All files', extensions: ['*'] }]
        : [
            { name: 'Video', extensions: losslessExts },
            { name: 'All files', extensions: ['*'] }
          ]
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath;
  });

  ipcMain.handle('dialog:savePreview', async (_e, defaultName, ext) => {
    const cleanExt = String(ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
    const res = await dialog.showSaveDialog(getWindow(), {
      title: 'Save Preview As',
      defaultPath: defaultName || ('preview.' + cleanExt),
      filters: [
        { name: 'Video', extensions: [cleanExt] },
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

  ipcMain.handle('dialog:openProject', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Open Project',
      properties: ['openFile'],
      filters: [{ name: 'KeyCut project', extensions: ['kc'] }]
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('recents:list', () => recentsList());
  ipcMain.handle('recents:add', (_e, filePath) => {
    recentsAdd(filePath);
    return { ok: true };
  });
  ipcMain.handle('recents:clear', () => {
    recentsClear();
    return { ok: true };
  });

  ipcMain.handle('compat:start', async (_e, opts) => {
    try {
      const chunk = await startCompat({ ffmpeg: resolveFfmpegPath(appRoot), ...(opts || {}) });
      if (chunk == null) {
        const err = compatStderr();
        return { ok: false, error: (err && err.slice(-300)) || 'ffmpeg produced no data' };
      }
      return { ok: true, chunk: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('compat:chunk', async () => {
    const buf = await readCompatChunk();
    return buf ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
  });
  ipcMain.handle('compat:stderr', () => compatStderr());
  ipcMain.handle('compat:stop', () => {
    stopCompat();
    return { ok: true };
  });
  ipcMain.handle('compat:deleteDummy', async (_e, dummyPath) => {
    if (typeof dummyPath === 'string' && dummyPath) {
      for (let i = 0; i < 4; i++) {
        try {
          fs.unlinkSync(dummyPath);
          break;
        } catch {
          if (i < 3) await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        }
      }
    }
    return { ok: true };
  });
  ipcMain.handle('compat:ensureDummy', async (_e, { src, duration }) => {
    const out = dummyPathFor(tmpDir, src);
    if (fs.existsSync(out)) return { ok: true, dummyPath: out, created: false };
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    const send = (evt, data) => { if (_e.sender && !_e.sender.isDestroyed()) _e.sender.send(evt, data); };
    try {
      await makeDummy({
        ffmpeg: resolveFfmpegPath(appRoot),
        duration,
        outPath: out,
        onProgress: (p) => send('compat:dummy-progress', { progress: p })
      });
      return { ok: true, dummyPath: out, created: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('ext:list', () => listExtensions(appRoot));

  ipcMain.handle('ext:download', async (event, id) => {
    const send = (evt, data) => { if (!event.sender.isDestroyed()) event.sender.send(evt, data); };
    try {
      return await downloadExtension(appRoot, id, (progress) => send('ext:progress', { id, progress }));
    } catch (err) {
      return { ok: false, error: err.message };
    }
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

  ipcMain.handle('paths:collect', (_e, paths) => {
    if (!Array.isArray(paths)) return { videos: [], projects: [], folders: [] };
    return collectDropped(paths);
  });

  ipcMain.handle('probe:quick', async (_e, filePath) => {
    if (!filePath) return { error: 'No path' };
    try {
      return await probeQuick(filePath, resolveFfmpegPath(appRoot));
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('probe:joinable', async (_e, { files }) => {
    if (!Array.isArray(files) || !files.length) return { ok: false, error: 'No files to analyze' };
    try {
      const ffmpeg = resolveFfmpegPath(appRoot);
      let base = null;
      for (const f of files) {
        const q = await probeQuick(f, ffmpeg);
        if (!q) return { ok: false, error: 'Failed to probe: ' + f };
        if (!base) { base = q; continue; }
        const err = assertJoinable([base, q]);
        if (err) return { ok: false, error: err };
      }
      return { ok: true, count: files.length };
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'Failed to analyze files' };
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
      fs.mkdirSync(tmpDir, { recursive: true });
      const dir = fs.mkdtempSync(path.join(tmpDir, 'exp-'));
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
        quality: payload.quality,
        gpu: payload.gpu,
        duration: payload.duration,
        tools: resolveTools(appRoot, payload.tools)
      });
      return { ok: true, ...result };
    } catch (err) {
      send('export:progress', { phase: 'error', message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('export:cancel', () => {
    killExport();
    killConcat();
    stopCompat();
    return { ok: true };
  });

  ipcMain.handle('project:save', async (_e, payload) => {
    const { filePath, data } = payload;
    const backPath = filePath + '.back';
    const oldPath = filePath + '.old';
    const cleanup = async () => {
      for (const p of [backPath, oldPath]) { try { await fs.promises.unlink(p); } catch {} }
    };
    try {
      await saveProject(backPath, data);
      try {
        await fs.promises.rename(backPath, filePath);
      } catch (e) {
        if (fs.existsSync(filePath)) await fs.promises.rename(filePath, oldPath);
        try {
          await fs.promises.rename(backPath, filePath);
        } catch (e2) {
          if (!fs.existsSync(filePath) && fs.existsSync(oldPath)) await fs.promises.rename(oldPath, filePath).catch(() => {});
          throw e2;
        }
        await fs.promises.unlink(oldPath).catch(() => {});
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

  ipcMain.handle('project:loadTimeline', async (_e, { filePath, id }) => {
    try {
      const tl = await loadProjectTimeline(filePath, id);
      return { ok: true, timeline: tl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('project:loadTimelines', async (_e, { filePath, ids }) => {
    try {
      const tls = await loadProjectTimelines(filePath, ids);
      return { ok: true, timelines: tls };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('export:project', async (event, payload) => {
    const { timelines, outputPath, ffmpeg, compress, resolution, quality, gpu, tools } = payload || {};
    if (!Array.isArray(timelines) || !timelines.length) return { ok: false, error: 'No timelines to export' };
    if (!outputPath) return { ok: false, error: 'Missing output path' };
    const send = (evt, data) => { if (!event.sender.isDestroyed()) event.sender.send(evt, data); };
    const ffmpegBin = ffmpeg || resolveFfmpegPath(appRoot);
    return joinSources({
      parts: timelines,
      outputPath,
      ffmpeg: ffmpegBin,
      tmpDir,
      toolList: resolveTools(appRoot, tools),
      compress: !!compress,
      resolution: resolution || 'origin',
      quality,
      gpu,
      onProgress: (p) => send('export:progress', p),
      onError: (message) => send('export:progress', { phase: 'error', message })
    });
  });

  ipcMain.handle('project:resolveSource', (_e, { projectPath, rel }) => {
    if (!rel) return { path: null };
    const p = path.resolve(path.dirname(projectPath), rel.split('/').join(path.sep));
    return { path: p };
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
  ipcMain.handle('win:centerOn', (_e, center) => {
    const win = getWindow();
    if (!win || !center) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const x = Math.max(wa.x, Math.min(center.x - b.width / 2, wa.x + wa.width - b.width));
    const y = Math.max(wa.y, Math.min(center.y - b.height / 2, wa.y + wa.height - b.height));
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
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
      for (const f of files) {
        const q = await probeQuick(f, ffmpeg);
        if (!q) return { ok: false, error: 'Failed to probe: ' + f };
        metas.push(q);
      }
      const err = assertJoinable(metas);
      if (err) return { ok: false, error: err };
      const parts = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const q = metas[i];
        const dur = (q && typeof q.duration === 'number' && q.duration > 0) ? q.duration : null;
        let streams = null;
        try { streams = await probeStreams(f, ffmpeg); } catch { streams = null; }
        const hasThumbnail = !!(streams && streams.some((s) => s && s.disposition && s.disposition.includes('attached_pic')));
        parts.push({
          sourcePath: f,
          segments: [[0, dur != null ? dur : 1e9]],
          duration: dur != null ? dur : 0,
          streams,
          hasThumbnail,
          rotation: (q && q.rotation) || 0,
          videoTimebase: null
        });
      }
      const firstExt = (String(files[0]).match(/\.([^.\\/]+)$/) || [])[1] || '';
      const out = outputNameFor(files, preferredLosslessExt(parts[0] && parts[0].streams, firstExt));
      const result = await joinSources({
        parts,
        outputPath: out,
        ffmpeg,
        tmpDir,
        compress: false,
        onProgress: (p) => { if (p.progress != null) send('concat:progress', { progress: p.progress }); }
      });
      if (result && result.ok === false && result.error === 'Cancelled') {
        try { fs.unlinkSync(out); } catch {}
      }
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('concat:cancel', () => {
    killConcat();
    killExport();
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

  ipcMain.handle('preview:target', async (_e, { key, extension }) => {
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    const h = crypto.createHash('sha1').update(String(key || '')).digest('hex').slice(0, 12);
    const ext = String(extension || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
    const p = path.join(tmpDir, 'preview-' + h + '.' + ext);
    const exists = fs.existsSync(p);
    clearPreviewFiles(tmpDir, p);
    return { path: p, exists };
  });

  ipcMain.handle('preview:clear', async () => {
    clearPreviewFiles(tmpDir, null);
    return { ok: true };
  });
}

module.exports = { registerIpc, resolveFfmpegPath };
const path = require('path');
const fs = require('fs');
const { probeQuick } = require('./probe');
const { joinFiles, concatCancelled, resetConcatCancelled } = require('./concat');
const { startExport, exportCancelled, resetExportCancelled, writeToTarget } = require('./export');
const { removeDir } = require('./tmp');

function assertJoinable(metas) {
  if (!metas || metas.length < 2) return null;
  const base = metas[0];
  if (!base) return null;
  for (let i = 1; i < metas.length; i++) {
    const m = metas[i];
    if (!m) continue;
    if (!m.width || !m.height || !base.width || !base.height) continue;
    if (m.width !== base.width || m.height !== base.height) {
      return 'Cannot join: resolution mismatch (' + base.width + 'x' + base.height + ' vs ' + m.width + 'x' + m.height + ')';
    }
    if (base.fps && m.fps) {
      const rel = Math.abs(m.fps - base.fps) / Math.max(base.fps, m.fps);
      if (rel > 0.1) {
        return 'Cannot join: frame rate differs too much (' + base.fps.toFixed(2) + ' vs ' + m.fps.toFixed(2) + ' fps)';
      }
    }
    if (base.codec && m.codec && base.codec !== m.codec) {
      return 'Cannot join: video codec mismatch (' + base.codec + ' vs ' + m.codec + ')';
    }
    if (base.sarNum && m.sarNum && base.sarDen && m.sarDen && (base.sarNum / base.sarDen !== m.sarNum / m.sarDen)) {
      return 'Cannot join: pixel aspect ratio mismatch (SAR ' + base.sarNum + ':' + base.sarDen + ' vs ' + m.sarNum + ':' + m.sarDen + ')';
    }
    if (base.audioCodec && m.audioCodec && base.audioCodec !== m.audioCodec) {
      return 'Cannot join: audio codec mismatch (' + base.audioCodec + ' vs ' + m.audioCodec + ')';
    }
    if (base.audioRate && m.audioRate && base.audioRate !== m.audioRate) {
      return 'Cannot join: audio rate mismatch (' + base.audioRate + ' Hz vs ' + m.audioRate + ' Hz)';
    }
    if (base.audioChannels && m.audioChannels && base.audioChannels !== m.audioChannels) {
      return 'Cannot join: audio channels mismatch (' + base.audioChannels + ' vs ' + m.audioChannels + ')';
    }
  }
  return null;
}

async function probeMetas(files, ffmpeg) {
  const metas = [];
  for (const f of files) {
    const q = await probeQuick(f, ffmpeg);
    if (!q) throw new Error('Failed to probe: ' + f);
    metas.push(q);
  }
  return metas;
}

async function mergeTimelines({ files, ffmpeg, onProgress, totalDuration, baseDir }) {
  const metas = await probeMetas(files, ffmpeg);
  const err = assertJoinable(metas);
  if (err) throw new Error(err);
  return joinFiles({ files, ffmpeg, onProgress, totalDuration, baseDir });
}

const CUT_WEIGHT = 0.5;

async function joinSources({ parts, outputPath, ffmpeg, tmpDir, toolList, compress, resolution, quality, gpu, onProgress, onError }) {
  const tools = Array.isArray(toolList) ? toolList : [];
  const emit = (p) => { if (onProgress) onProgress(p); };
  const fail = (message) => { if (onError) onError(message); };
  fs.mkdirSync(tmpDir, { recursive: true });
  const mergeDir = fs.mkdtempSync(path.join(tmpDir, 'merge-'));
  const keptDur = (tl) => (tl.segments || []).reduce((a, s) => a + Math.max(0, (s[1] || 0) - (s[0] || 0)), 0);
  const totalKept = parts.reduce((a, tl) => a + keptDur(tl), 0);
  const active = parts.filter((tl) => tl && tl.sourcePath && Array.isArray(tl.segments) && tl.segments.length);
  const hasVideo = (tl) => {
    const streams = tl.streams || [];
    return !streams.length || streams.some((s) => s && s.codec_type === 'video');
  };
  const videoTimelines = active.filter(hasVideo);
  const firstVideo = videoTimelines[0] || null;
  const rotations = videoTimelines.map((tl) => tl.rotation || 0);
  const uniformRotation = rotations.length && rotations.every((r) => r === rotations[0]) ? rotations[0] : 0;
  const bakeRotation = tools.length ? uniformRotation : 0;
  const finalRotation = bakeRotation ? 0 : (firstVideo ? (firstVideo.rotation || 0) : 0);
  try {
    resetExportCancelled();
    resetConcatCancelled();
    const files = [];
    let total = 0;
    let doneKept = 0;
    for (let i = 0; i < parts.length; i++) {
      const tl = parts[i];
      if (!tl || !tl.sourcePath || !Array.isArray(tl.segments) || !tl.segments.length) continue;
      if (exportCancelled() || concatCancelled()) throw new Error('Cancelled');
      const part = path.join(mergeDir, 'part_' + String(i).padStart(6, '0') + '.mkv');
      const segDurs = tl.segments.map((s) => Math.max(0, (s[1] || 0) - (s[0] || 0)));
      await startExport({
        src: tl.sourcePath,
        segments: tl.segments,
        out: part,
        tmpDir: path.join(mergeDir, 'work_' + i),
        ffmpeg,
        onProgress: (p) => {
          if (p.phase === 'tool') { emit(p); return; }
          if (p.phase !== 'cut' || !p.total) return;
          let f = 0;
          for (let k = 0; k < Math.min(p.index, segDurs.length); k++) f += segDurs[k];
          const frac = totalKept > 0 ? ((doneKept + f) / totalKept) * CUT_WEIGHT : 0;
          emit({ phase: 'join', progress: Math.min(frac, CUT_WEIGHT) });
        },
        videoTimebase: tl.videoTimebase,
        hasThumbnail: tl.hasThumbnail,
        streams: tl.streams,
        rotation: bakeRotation && hasVideo(tl) ? bakeRotation : 0,
        gpu,
        tools,
        compress: false,
        resolution: null,
        duration: keptDur(tl)
      });
      files.push(part);
      total += tl.duration || keptDur(tl);
      doneKept += keptDur(tl);
    }
    if (!files.length) throw new Error('No timelines produced segments');
    const res = await mergeTimelines({
      files,
      ffmpeg,
      onProgress: (p) => {
        const frac = CUT_WEIGHT + (p.progress != null ? p.progress : 0) * (1 - CUT_WEIGHT);
        emit({ phase: 'join', progress: Math.min(frac, 1) });
      },
      totalDuration: total,
      baseDir: tmpDir
    });
    emit({ phase: 'join', progress: 1 });
    if (!res || !res.ok || !res.out) throw new Error('Merge failed');
    const mergedOut = res.out;
    let finalOut = outputPath;
    if (compress) {
      const measured = await probeQuick(mergedOut, ffmpeg).then((p) => (p && p.duration > 0 ? p.duration : total)).catch(() => total);
      const encoded = await startExport({
        src: mergedOut,
        segments: [[0, measured]],
        out: outputPath,
        tmpDir: path.join(mergeDir, 'final'),
        ffmpeg,
        onProgress: (p) => {
          if (p.phase === 'encode') emit({ phase: 'compress', progress: p.progress != null ? p.progress : 0 });
        },
        compress: true,
        resolution: resolution || 'origin',
        rotation: finalRotation,
        quality,
        gpu,
        duration: measured
      });
      if (encoded && encoded.out) finalOut = encoded.out;
      emit({ phase: 'compress', progress: 1 });
    } else {
      finalOut = await writeToTarget({ ffmpeg, input: mergedOut, out: outputPath, avoidNegativeTs: 'make_zero', rotation: finalRotation });
    }
    try { fs.unlinkSync(mergedOut); } catch {}
    emit({ phase: 'done', out: finalOut });
    return { ok: true, out: finalOut };
  } catch (err) {
    fail(err.message);
    return { ok: false, error: err.message };
  } finally {
    await removeDir(mergeDir);
  }
}

module.exports = { assertJoinable, probeMetas, mergeTimelines, joinSources, joinFiles };

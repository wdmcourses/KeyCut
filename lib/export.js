const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { probeStreams, probeMedia } = require('./probe');
const { removeDir } = require('./tmp');
const { outFormatFor, mp4LikeExt, isDropped, decideCodec, containerAccepts, containerFamily, demuxerFamily, fallbackExt } = require('./formats');

let _exportChild = null;
let _exportCancelled = false;

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

function killTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

function killExport() {
  _exportCancelled = true;
  if (_exportChild) {
    killTree(_exportChild);
    _exportChild = null;
  }
}

function exportCancelled() {
  return _exportCancelled;
}

function resetExportCancelled() {
  _exportCancelled = false;
}

function partExtFor(src) {
  const ext = path.extname(src).toLowerCase();
  if (['.mp4', '.m4v', '.3gp', '.3g2', '.f4v', '.ipod'].includes(ext)) return '.mp4';
  if (['.mov', '.m4a'].includes(ext)) return '.mov';
  if (['.mkv', '.webm'].includes(ext)) return '.mkv';
  if (['.ts', '.m2ts', '.mts', '.m2t'].includes(ext)) return '.ts';
  if (ext === '.avi') return '.avi';
  return '.mkv';
}

const STREAM_MAP_TYPE = { video: 'v', audio: 'a', subtitle: 's', attachment: 't' };

const BAKE_AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '320k'];
const BAKE_VIDEO_QUALITY = 'high';

function selectStreams(streams) {
  const selected = [];
  const counts = { v: 0, a: 0, s: 0, t: 0 };
  for (const s of streams || []) {
    const type = STREAM_MAP_TYPE[s.codec_type];
    if (!type) continue;
    selected.push({ stream: s, type, index: counts[type] });
    counts[type]++;
  }
  return selected;
}

function withoutCoverArt(streams) {
  return (streams || []).filter((s) => !(s.disposition && s.disposition.includes('attached_pic')));
}

function streamArgsFor(streams, format, withDisposition, videoCodecArgs, audioCodecArgs) {
  const all = selectStreams(streams);
  if (!all.length) return ['-map', '0', '-c', 'copy'];
  const selected = all.filter(({ stream }) => !isDropped(stream, format));
  const args = [];
  selected.forEach(({ stream, type, index }, outIdx) => {
    args.push('-map', '0:' + type + ':' + index);
    if (type === 'v' && videoCodecArgs) args.push(...videoCodecArgs);
    else if (type === 'a' && audioCodecArgs) args.push(...audioCodecArgs);
    else args.push('-c:' + outIdx, decideCodec(stream, format));
    if (withDisposition) {
      const active = stream.disposition && stream.disposition.length ? stream.disposition[0] : null;
      if (active) args.push('-disposition:' + outIdx, active);
    }
  });
  return args;
}

function runFfmpeg(ffmpeg, args, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    _exportChild = child;
    let stderr = '';
    const timer = setTimeout(() => { killTree(child); reject(new Error('ffmpeg timed out')); }, FFMPEG_TIMEOUT_MS);
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (onLog) onLog(d.toString('utf8'));
    });
    child.on('error', (err) => { clearTimeout(timer); _exportChild = null; reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      _exportChild = null;
      if (_exportCancelled) return reject(new Error('Cancelled'));
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited with code ' + code + ': ' + stderr.slice(-2000)));
    });
  });
}

function runFfmpegProgress(ffmpeg, args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    _exportChild = child;
    let stderr = '';
    const timer = setTimeout(() => { killTree(child); reject(new Error('ffmpeg timed out')); }, FFMPEG_TIMEOUT_MS);
    child.stderr.on('data', (d) => {
      const chunk = d.toString('utf8');
      stderr += chunk;
      if (onProgress && duration > 0) {
        const m = chunk.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const elapsed = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.min(elapsed / duration, 0.99));
        }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); _exportChild = null; reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      _exportChild = null;
      if (_exportCancelled) return reject(new Error('Cancelled'));
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited with code ' + code + ': ' + stderr.slice(-2000)));
    });
  });
}

const NVENC_PHASES = {
  low: ['-rc', 'vbr_hq', '-cq', '24', '-qmin', '2', '-qmax', '41'],
  mid: ['-rc', 'vbr_hq', '-cq', '22', '-qmin', '2', '-qmax', '30'],
  high: ['-rc', 'vbr_hq', '-cq', '15', '-qmin', '2', '-qmax', '15']
};

const X264_PHASES = {
  low: ['-crf', '28', '-qmin', '10', '-qmax', '41'],
  mid: ['-crf', '22', '-qmin', '5', '-qmax', '30'],
  high: ['-crf', '16', '-qmin', '5', '-qmax', '20']
};

const AMF_PHASES = {
  low: ['-rc', 'cqp', '-qp_i', '30', '-qp_p', '30', '-qp_b', '30'],
  mid: ['-rc', 'cqp', '-qp_i', '25', '-qp_p', '25', '-qp_b', '25'],
  high: ['-rc', 'cqp', '-qp_i', '20', '-qp_p', '20', '-qp_b', '20']
};

const QSV_PHASES = {
  low: ['-look_ahead', '0', '-global_quality', '30'],
  mid: ['-look_ahead', '0', '-global_quality', '25'],
  high: ['-look_ahead', '0', '-global_quality', '20']
};

const X264_BASE = [
  '-flags', '+loop', '-cmp', 'chroma', '-deblock', '0:0', '-bt', '256k', '-coder', '0',
  '-me_range', '16', '-subq', '5', '-preset', 'faster', '-partitions', '+parti4x4+parti8x8+partp8x8',
  '-g', '200', '-keyint_min', '25', '-trellis', '0', '-sc_threshold', '40', '-i_qfactor', '0.71',
  '-b_strategy', '1', '-qcomp', '0.6', '-qdiff', '4', '-refs', '2', '-direct-pred', '1', '-wpredp', '2',
  '-bf', '0', '-profile:v', 'main'
];

function scaleArgs(resolution) {
  const w = { 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 }[String(resolution)];
  if (w) return ['-vf', 'scale=' + w + ':-2:flags=bilinear'];
  return ['-vf', 'scale=iw:ceil(ih/4)*4:flags=bilinear'];
}

function rotateArgs(rotation, ext) {
  if (!rotation || !mp4LikeExt(ext)) return [];
  return ['-metadata:s:v:0', 'rotate=' + String(rotation)];
}

const ENCODER_PROBE_TIMEOUT_MS = 15000;

function probeEncoder(ffmpeg, codec, extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=1:d=0.1',
      '-frames:v', '1',
      '-c:v', codec,
      ...(extraArgs || []),
      '-f', 'null', '-'
    ], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(false); }, ENCODER_PROBE_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

const _encoderCache = new Map();

async function resolveEncoder(ffmpeg) {
  if (_encoderCache.has(ffmpeg)) return _encoderCache.get(ffmpeg);
  if (process.platform !== 'win32') {
    _encoderCache.set(ffmpeg, 'libx264');
    return 'libx264';
  }
  const candidates = [
    ['h264_nvenc', ['-profile:v', 'main', '-level:v', 'auto', '-pix_fmt', 'yuv420p', ...NVENC_PHASES.low]],
    ['h264_amf', ['-profile:v', 'high', '-level:v', 'auto', '-pix_fmt', 'yuv420p', ...AMF_PHASES.low]],
    ['h264_qsv', ['-profile:v', 'main', '-level:v', '41', '-pix_fmt', 'yuv420p', ...QSV_PHASES.low]]
  ];
  for (const [codec, args] of candidates) {
    if (await probeEncoder(ffmpeg, codec, args)) {
      _encoderCache.set(ffmpeg, codec);
      return codec;
    }
  }
  _encoderCache.set(ffmpeg, 'libx264');
  return 'libx264';
}

async function videoEncoderArgs({ ffmpeg, gpu, quality }) {
  const q = NVENC_PHASES[quality] ? quality : 'low';
  const enc = gpu === false ? 'libx264' : await resolveEncoder(ffmpeg);
  if (enc === 'h264_amf') {
    return ['-c:v', 'h264_amf', '-profile:v', 'high', '-level:v', 'auto', '-pix_fmt', 'yuv420p', ...AMF_PHASES[q]];
  }
  if (enc === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-profile:v', 'main', '-level:v', '41', '-pix_fmt', 'yuv420p', ...QSV_PHASES[q]];
  }
  if (enc === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-profile:v', 'main', '-level:v', 'auto', '-pix_fmt', 'yuv420p', ...NVENC_PHASES[q]];
  }
  return ['-c:v', 'libx264', ...X264_BASE, ...X264_PHASES[q], '-pix_fmt', 'yuv420p'];
}

async function compressArgs({ ffmpeg, resolution, quality, gpu }) {
  return [
    ...scaleArgs(resolution),
    ...await videoEncoderArgs({ ffmpeg, gpu, quality }),
    '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2'
  ];
}


function runTool({ tool, input, cwd, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [...tool.cmd.slice(1), input, ...(tool.args || [])];
    const child = spawn(tool.cmd[0], args, { windowsHide: true, cwd, env: { ...process.env, ...(tool.env || {}) } });
    _exportChild = child;
    let log = '';
    const marks = (tool.progressMarks || []).slice().sort((a, b) => a[1] - b[1]);
    const fired = new Set();
    const emit = (progress, detail) => { if (onProgress) onProgress({ progress, detail: detail || null }); };
    const timer = setTimeout(() => { killTree(child); reject(new Error((tool.label || tool.id) + ' timed out')); }, FFMPEG_TIMEOUT_MS);
    const onChunk = (d) => {
      log = (log + d.toString('utf8')).slice(-8000);
      for (let i = 0; i < marks.length; i++) {
        if (fired.has(i)) continue;
        if (marks[i][0].test(log)) { fired.add(i); emit(marks[i][1], marks[i][2]); }
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (err) => { clearTimeout(timer); _exportChild = null; reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      _exportChild = null;
      if (_exportCancelled) return reject(new Error('Cancelled'));
      if (code !== 0) return reject(new Error((tool.label || tool.id) + ' failed (code ' + code + '): ' + log.slice(-2000)));
      emit(1, null);
      let outPath = null;
      if (tool.outputRe) {
        const m = log.match(tool.outputRe);
        if (m) outPath = m[1].trim();
      }
      resolve(outPath);
    });
  });
}

async function applyTools({ tools, input, tmpDir, ffmpeg, onProgress }) {
  let current = input;
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (_exportCancelled) throw new Error('Cancelled');
    const dir = path.join(tmpDir, 'tool_' + i);
    fs.mkdirSync(dir, { recursive: true });
    if (onProgress) onProgress({ phase: 'tool', id: tool.id, label: tool.label, progress: 0 });
    const produced = await runTool({
      tool,
      input: current,
      cwd: dir,
      onProgress: onProgress ? (e) => onProgress({ phase: 'tool', id: tool.id, label: tool.label, progress: e.progress, detail: e.detail }) : null
    });
    const next = produced || path.join(dir, path.basename(input));
    if (i > 0 && current && current !== next) { try { fs.rmSync(current, { force: true }); } catch {} }
    current = next;
  }
  return current;
}

async function normalizeToTarget({ ffmpeg, input, out, avoidNegativeTs, streams, rotation }) {
  const outExt = path.extname(out).toLowerCase();
  const outFormat = outFormatFor(outExt);
  if (!outFormat) return null;
  let probed = streams || null;
  if (!probed) { try { probed = await probeStreams(input, ffmpeg); } catch { probed = null; } }
  const all = selectStreams(probed);
  const selected = all.filter(({ stream }) => !isDropped(stream, outFormat));
  if (!selected.length) return null;
  const copyOnly = all.length === selected.length && selected.every(({ stream }) => decideCodec(stream, outFormat) === 'copy');
  const mp4Like = mp4LikeExt(outExt);
  const stamp = rotateArgs(rotation, outExt);
  if (copyOnly && path.extname(input).toLowerCase() === outExt && !stamp.length) return null;
  await runFfmpeg(ffmpeg, [
    '-y', '-v', 'error',
    '-i', input,
    ...streamArgsFor(probed, outFormat, true),
    ...stamp,
    '-ignore_unknown',
    ...(avoidNegativeTs ? ['-avoid_negative_ts', avoidNegativeTs] : []),
    ...(mp4Like ? ['-strict', '-2', '-movflags', '+faststart'] : []),
    ...(outFormat ? ['-f', outFormat] : []),
    out
  ]);
  return out;
}

async function fitOutPath({ ffmpeg, input, out }) {
  const outExt = path.extname(out).toLowerCase();
  const curExt = path.extname(input).toLowerCase();
  const outFormat = outFormatFor(outExt);
  if (!outFormat) return { out, family: null, streams: null };
  let media = null;
  try { media = await probeMedia(input, ffmpeg); } catch { media = null; }
  if (!media) return { out, family: null, streams: null };
  const streams = media.streams || [];
  const family = demuxerFamily(media.container);
  if (!streams.length || containerAccepts(streams, outFormat)) return { out, family, streams };
  const ext = curExt ? fallbackExt(curExt, family, streams) : null;
  return { out: ext ? out.slice(0, out.length - outExt.length) + ext : out, family, streams };
}

async function writeToTarget({ ffmpeg, input, out, avoidNegativeTs, rotation }) {
  const fit = await fitOutPath({ ffmpeg, input, out });
  const target = fit.out;
  if (target === input) return target;
  const curExt = path.extname(input).toLowerCase();
  const targetExt = path.extname(target).toLowerCase();
  const same = fit.family ? fit.family === containerFamily(outFormatFor(targetExt)) : targetExt === curExt;
  const stamp = rotateArgs(rotation, targetExt);
  if (!stamp.length && (!targetExt || same)) {
    try { fs.renameSync(input, target); }
    catch { try { fs.copyFileSync(input, target); fs.rmSync(input, { force: true }); } catch {} }
    return target;
  }
  const normalized = await normalizeToTarget({ ffmpeg, input, out: target, avoidNegativeTs, streams: fit.streams, rotation });
  if (normalized) {
    try { fs.rmSync(input, { force: true }); } catch {}
    return target;
  }
  const mp4Like = mp4LikeExt(targetExt);
  await runFfmpeg(ffmpeg, [
    '-y', '-v', 'error',
    '-i', input,
    '-c', 'copy',
    ...stamp,
    ...(avoidNegativeTs ? ['-avoid_negative_ts', avoidNegativeTs] : []),
    ...(mp4Like ? ['-strict', '-2', '-movflags', '+faststart'] : []),
    target
  ]);
  try { fs.rmSync(input, { force: true }); } catch {}
  return target;
}

async function startExport({ src, segments, out, tmpDir, ffmpeg, onProgress, videoTimebase, hasThumbnail, streams, compress, resolution, duration, rotation, quality, gpu, tools }) {
  _exportCancelled = false;
  fs.mkdirSync(tmpDir, { recursive: true });

  const emit = (phase, extra) => {
    if (onProgress) onProgress({ phase, ...extra });
  };
  const toolList = Array.isArray(tools) ? tools : [];
  const hasTools = toolList.length > 0;
  const bake = hasTools && !!rotation;
  const outRotation = bake ? 0 : rotation;
  let finalOut = out;

  try {
    const partNames = [];
    const partExt = partExtFor(src);
    const partFormat = outFormatFor(partExt);
    const bakeVideoArgs = bake ? await videoEncoderArgs({ ffmpeg, gpu, quality: BAKE_VIDEO_QUALITY }) : null;
    const bakeStreams = bake ? withoutCoverArt(streams) : streams;
    const cutStreamArgs = bake
      ? (selectStreams(bakeStreams).length
        ? streamArgsFor(bakeStreams, partFormat, false, bakeVideoArgs, BAKE_AUDIO_ARGS)
        : ['-map', '0:v:0', '-map', '0:a?', ...bakeVideoArgs, ...BAKE_AUDIO_ARGS])
      : (selectStreams(streams).length
        ? streamArgsFor(streams, partFormat, false)
        : ['-c', 'copy']);
    const cutFpsArgs = bake ? ['-vsync', '0', '-metadata:s:v:0', 'rotate=0'] : [];
    const timescaleArgs = videoTimebase ? ['-video_track_timescale', String(videoTimebase)] : [];
    const avoidNegValue = hasThumbnail ? 'auto' : 'make_zero';
    const rotationArgs = rotateArgs(outRotation, partExt);
    const srcExt = path.extname(src).toLowerCase();
    const needsPremux = ['.ts', '.m2ts', '.mts', '.m2t'].includes(srcExt);
    let cutSrc = src;
    let premuxDone = false;
    emit('cut', { index: 0, total: segments.length });

    if (needsPremux) {
      const premux = path.join(tmpDir, '_premux.mkv');
      await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-i', src, '-map', '0', '-c', 'copy', premux]);
      cutSrc = premux;
      premuxDone = true;
    }

    for (let i = 0; i < segments.length; i++) {
      const [start, end] = segments[i];
      const len = end - start;
      const partName = 'part_' + String(i).padStart(6, '0') + partExt;
      const partPath = path.join(tmpDir, partName);
      const partStrict = mp4LikeExt(partExt) ? ['-strict', '-2'] : [];
      partNames.push(partPath);
      const startArgs = start > 0 ? ['-ss', start.toFixed(6)] : [];
      const avoidNegArgs = start > 0 ? ['-avoid_negative_ts', avoidNegValue] : [];
      await runFfmpeg(ffmpeg, [
        '-y', '-v', 'error',
        ...startArgs,
        '-i', cutSrc,
        '-t', len.toFixed(6),
        ...cutStreamArgs,
        ...cutFpsArgs,
        ...rotationArgs,
        ...avoidNegArgs,
        '-ignore_unknown',
        ...timescaleArgs,
        ...partStrict,
        partPath
      ]);
      emit('cut', { index: i + 1, total: segments.length });
    }

    if (premuxDone) { try { fs.rmSync(cutSrc, { force: true }); } catch {} }

    const listPath = path.join(tmpDir, '_concat.txt');
    const lines = partNames.map((p) => "file 'file:" + p.replace(/\\/g, '/') + "'").join('\n') + '\n';
    fs.writeFileSync(listPath, lines, 'utf8');

    emit('concat', {});
    const outExt = path.extname(out).toLowerCase();
    const outFormat = outFormatFor(outExt);
    const mp4Like = mp4LikeExt(outExt);
    const movFlags = mp4Like ? ['-movflags', '+faststart'] : [];
    const strictArgs = mp4Like ? ['-strict', '-2'] : [];
    const formatArgs = outFormat ? ['-f', outFormat] : [];
    const needsIntermediate = compress || hasTools;
    const concatOut = needsIntermediate ? path.join(tmpDir, 'mux' + (outExt || '.mp4')) : out;
    const concatStreamArgs = compress ? ['-map', '0:v:0?', '-map', '0:a?', '-c', 'copy'] : streamArgsFor(bakeStreams, outFormat, true);
    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe,fd',
      '-i', listPath,
      ...concatStreamArgs,
      '-ignore_unknown',
      ...timescaleArgs,
      ...strictArgs,
      ...movFlags,
      ...formatArgs,
      concatOut
    ]);

    let current = concatOut;
    if (hasTools) {
      current = await applyTools({ tools: toolList, input: concatOut, tmpDir, ffmpeg, onProgress });
    }

    if (compress) {
      emit('encode', { progress: 0 });
      const cargs = await compressArgs({ ffmpeg, resolution, quality, duration, gpu });
      await runFfmpegProgress(ffmpeg, [
        '-y', '-v', 'error', '-stats',
        '-i', current,
        '-map', '0:v:0', '-map', '0:a?',
        ...cargs,
        ...rotateArgs(outRotation, outExt),
        ...(mp4Like ? ['-movflags', '+faststart'] : []),
        out
      ], duration, (p) => emit('encode', { progress: p }));
      if (current !== out) { try { fs.rmSync(current, { force: true }); } catch {} }
    } else if (current !== out) {
      finalOut = await writeToTarget({ ffmpeg, input: current, out, rotation: outRotation });
    }

    try {
      const st = fs.statSync(src);
      fs.utimesSync(finalOut, st.atime, st.mtime);
    } catch {}

    emit('done', { out: finalOut });
    return { out: finalOut };
  } catch (err) {
    if (err && err.message === 'Cancelled') {
      try { fs.unlinkSync(finalOut); } catch {}
      if (finalOut !== out) { try { fs.unlinkSync(out); } catch {} }
    }
    throw err;
  } finally {
    await removeDir(tmpDir);
    emit('cleanup');
  }
}

module.exports = { startExport, killExport, exportCancelled, resetExportCancelled, runFfmpeg, compressArgs, videoEncoderArgs, scaleArgs, NVENC_PHASES, X264_PHASES, X264_BASE, AMF_PHASES, QSV_PHASES, resolveEncoder, probeEncoder, runTool, applyTools, normalizeToTarget, writeToTarget };
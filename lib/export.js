const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let _exportChild = null;
let _exportCancelled = false;

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

function killExport() {
  _exportCancelled = true;
  if (_exportChild) {
    try { _exportChild.kill('SIGKILL'); } catch {}
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

function outFormatFor(ext) {
  switch (ext) {
    case '.mp4': case '.m4v': case '.3gp': case '.3g2': case '.f4v': case '.ipod': case '.psp': return 'mp4';
    case '.mov': return 'mov';
    case '.mkv': return 'matroska';
    case '.webm': return 'webm';
    case '.ts': case '.m2ts': case '.mts': case '.m2t': return 'mpegts';
    case '.avi': return 'avi';
    default: return null;
  }
}

const MOVENC = ['mp4', 'mov', '3gp', '3g2', 'f4v', 'ipod', 'psp', 'ismv'];

function decideCodec(stream, outFormat) {
  if (stream.codec_type === 'subtitle') {
    if (outFormat && MOVENC.includes(outFormat) && !['dvb_subtitle', 'mov_text'].includes(stream.codec_name)) return 'mov_text';
    if (outFormat === 'matroska' && stream.codec_name === 'mov_text') return 'srt';
    if (outFormat === 'webm' && stream.codec_name !== 'webvtt') return 'webvtt';
    return 'copy';
  }
  if (stream.codec_type === 'audio') {
    if (stream.codec_name === 'pcm_bluray' && outFormat !== 'mpegts') return 'pcm_s24le';
    if (stream.codec_name === 'pcm_dvd' && outFormat != null && ['matroska', 'mov'].includes(outFormat)) return 'pcm_s32le';
    return 'copy';
  }
  return 'copy';
}

const STREAM_MAP_TYPE = { video: 'v', audio: 'a', subtitle: 's', attachment: 't' };

function streamArgsFor(streams, outFormat) {
  if (!streams || !streams.length) return ['-map', '0', '-c', 'copy'];
  const args = [];
  let outIdx = 0;
  const counts = { v: 0, a: 0, s: 0, t: 0 };
  for (const s of streams) {
    const type = STREAM_MAP_TYPE[s.codec_type];
    if (!type) continue;
    const codec = decideCodec(s, outFormat);
    args.push('-map', '0:' + type + ':' + counts[type], '-c:' + outIdx, codec);
    const active = s.disposition && s.disposition.length ? s.disposition[0] : null;
    if (active) args.push('-disposition:' + outIdx, active);
    counts[type]++;
    outIdx++;
  }
  return args;
}

function runFfmpeg(ffmpeg, args, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    _exportChild = child;
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg timed out')); }, FFMPEG_TIMEOUT_MS);
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
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg timed out')); }, FFMPEG_TIMEOUT_MS);
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
  if (w) return ['-vf', 'scale=' + w + ':-2:flags=lanczos'];
  return ['-vf', 'scale=iw:ceil(ih/4)*4:flags=lanczos'];
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

function compressArgs({ ffmpeg, resolution, quality, duration, gpu }) {
  return new Promise(async (resolve, reject) => {
    const vf = scaleArgs(resolution);
    const audio = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2'];
    const q = NVENC_PHASES[quality] ? quality : 'low';
    const enc = gpu === false ? 'libx264' : await resolveEncoder(ffmpeg);
    if (enc === 'h264_amf') {
      resolve([...vf, '-c:v', 'h264_amf', '-profile:v', 'high', '-level:v', 'auto', '-pix_fmt', 'yuv420p', ...AMF_PHASES[q], ...audio]);
    } else if (enc === 'h264_qsv') {
      resolve([...vf, '-c:v', 'h264_qsv', '-profile:v', 'main', '-level:v', '41', '-pix_fmt', 'yuv420p', ...QSV_PHASES[q], ...audio]);
    } else if (enc === 'h264_nvenc') {
      resolve([...vf, '-c:v', 'h264_nvenc', '-profile:v', 'main', '-level:v', 'auto', '-pix_fmt', 'yuv420p', ...NVENC_PHASES[q], ...audio]);
    } else {
      resolve([...vf, '-c:v', 'libx264', ...X264_BASE, ...X264_PHASES[q], '-pix_fmt', 'yuv420p', ...audio]);
    }
  });
}


async function startExport({ src, segments, out, tmpDir, ffmpeg, onProgress, videoTimebase, hasThumbnail, streams, compress, resolution, duration, rotation, quality, gpu }) {
  _exportCancelled = false;
  fs.mkdirSync(tmpDir, { recursive: true });

  const emit = (phase, extra) => {
    if (onProgress) onProgress({ phase, ...extra });
  };

  try {
    const partNames = [];
    const partExt = partExtFor(src);
    const timescaleArgs = videoTimebase ? ['-video_track_timescale', String(videoTimebase)] : [];
    const avoidNeg = hasThumbnail ? 'auto' : 'make_zero';
    const srcExt = path.extname(src).toLowerCase();
    const needsPremux = ['.ts', '.m2ts', '.mts', '.m2t'].includes(srcExt);
    let cutSrc = src;
    let premuxDone = false;
    emit('cut', { index: 0, total: segments.length });

    if (needsPremux) {
      const premux = path.join(tmpDir, '_premux.mkv');
      await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-i', src, '-c', 'copy', premux]);
      cutSrc = premux;
      premuxDone = true;
    }

    for (let i = 0; i < segments.length; i++) {
      const [start, end] = segments[i];
      const len = end - start;
      const partName = 'part_' + String(i).padStart(6, '0') + partExt;
      const partPath = path.join(tmpDir, partName);
      const partStrict = ['.mp4', '.mov', '.m4v', '.3gp', '.3g2', '.ipod', '.f4v'].includes(partExt) ? ['-strict', '-2'] : [];
      partNames.push(partPath);
      if (rotation) {
        await runFfmpeg(ffmpeg, [
          '-y', '-v', 'error',
          '-i', cutSrc,
          '-ss', start.toFixed(6),
          '-to', end.toFixed(6),
          '-map', '0',
          '-c', 'copy',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
          '-avoid_negative_ts', avoidNeg,
          '-ignore_unknown',
          ...timescaleArgs,
          ...partStrict,
          partPath
        ]);
      } else {
        await runFfmpeg(ffmpeg, [
          '-y', '-v', 'error',
          '-ss', start.toFixed(6),
          '-i', cutSrc,
          '-t', len.toFixed(6),
          '-c', 'copy',
          '-avoid_negative_ts', avoidNeg,
          '-ignore_unknown',
          ...timescaleArgs,
          ...partStrict,
          partPath
        ]);
      }
      emit('cut', { index: i + 1, total: segments.length });
    }

    if (premuxDone) { try { fs.rmSync(cutSrc, { force: true }); } catch {} }

    const listPath = path.join(tmpDir, '_concat.txt');
    const lines = partNames.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n';
    fs.writeFileSync(listPath, lines, 'utf8');

    emit('concat', {});
    const outExt = path.extname(out).toLowerCase();
    const outFormat = outFormatFor(outExt);
    const mp4Like = ['.mp4', '.mov', '.m4v', '.3gp', '.3g2', '.ipod', '.f4v'].includes(outExt);
    const movFlags = mp4Like ? ['-movflags', '+faststart'] : [];
    const strictArgs = mp4Like ? ['-strict', '-2'] : [];
    const concatOut = compress ? path.join(tmpDir, 'mux' + (outExt || '.mp4')) : out;
    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      ...streamArgsFor(streams, outFormat),
      '-ignore_unknown',
      ...timescaleArgs,
      ...strictArgs,
      ...movFlags,
      concatOut
    ]);

    if (compress) {
      emit('encode', { progress: 0 });
      const cargs = await compressArgs({ ffmpeg, resolution, quality, duration, gpu });
      await runFfmpegProgress(ffmpeg, [
        '-y', '-v', 'error', '-stats',
        '-i', concatOut,
        '-map', '0:v:0', '-map', '0:a?',
        ...cargs,
        ...(mp4Like ? ['-movflags', '+faststart'] : []),
        out
      ], duration, (p) => emit('encode', { progress: p }));
      try { fs.rmSync(concatOut, { force: true }); } catch {}
    }

    try {
      const st = fs.statSync(src);
      fs.utimesSync(out, st.atime, st.mtime);
    } catch {}

    emit('done', { out });
    return { out };
  } catch (err) {
    if (err && err.message === 'Cancelled') {
      try { fs.unlinkSync(out); } catch {}
    }
    throw err;
  } finally {
    
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
      }
      fs.rmdirSync(tmpDir);
    } catch {
      
    }
    emit('cleanup');
  }
}

module.exports = { startExport, killExport, exportCancelled, resetExportCancelled, runFfmpeg, compressArgs, scaleArgs, NVENC_PHASES, X264_PHASES, X264_BASE, AMF_PHASES, QSV_PHASES, resolveEncoder, probeEncoder };
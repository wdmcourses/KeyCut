const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

function streamArgsFor(streams, outFormat) {
  if (!streams || !streams.length) return ['-map', '0', '-c', 'copy'];
  const args = [];
  let outIdx = 0;
  for (const s of streams) {
    const codec = decideCodec(s, outFormat);
    args.push('-map', '0:' + s.index, '-c:' + outIdx, codec);
    const active = s.disposition && s.disposition.length ? s.disposition[0] : null;
    if (active) args.push('-disposition:' + outIdx, active);
    outIdx++;
  }
  return args;
}

function runFfmpeg(ffmpeg, args, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (onLog) onLog(d.toString('utf8'));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited with code ' + code + ': ' + stderr.slice(-2000)));
    });
  });
}


async function startExport({ src, segments, out, tmpDir, ffmpeg, onProgress, videoTimebase, hasThumbnail, streams }) {
  fs.mkdirSync(tmpDir, { recursive: true });

  const emit = (phase, extra) => {
    if (onProgress) onProgress({ phase, ...extra });
  };

  try {
    const partNames = [];
    const partExt = partExtFor(src);
    const timescaleArgs = videoTimebase ? ['-video_track_timescale', String(videoTimebase)] : [];
    const avoidNeg = hasThumbnail ? 'auto' : 'make_zero';
    emit('cut', { index: 0, total: segments.length });

    for (let i = 0; i < segments.length; i++) {
      const [start, end] = segments[i];
      const len = end - start;
      const partName = 'part_' + String(i).padStart(6, '0') + partExt;
      const partPath = path.join(tmpDir, partName);
      partNames.push(partPath);
      await runFfmpeg(ffmpeg, [
        '-y', '-v', 'error',
        '-ss', start.toFixed(6),
        '-i', src,
        '-t', len.toFixed(6),
        '-c', 'copy',
        '-avoid_negative_ts', avoidNeg,
        '-ignore_unknown',
        ...timescaleArgs,
        partPath
      ]);
      emit('cut', { index: i + 1, total: segments.length });
    }

    
    const listPath = path.join(tmpDir, '_concat.txt');
    const lines = partNames.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n';
    fs.writeFileSync(listPath, lines, 'utf8');

    emit('concat', {});
    const outExt = path.extname(out).toLowerCase();
    const outFormat = outFormatFor(outExt);
    const mp4Like = ['.mp4', '.mov', '.m4v', '.3gp', '.3g2', '.ipod', '.f4v'].includes(outExt);
    const mkvLike = ['.mkv', '.webm'].includes(outExt);
    const movFlags = mp4Like ? ['-movflags', '+faststart'] : [];
    const mkvFlags = mkvLike ? ['-default_mode', 'infer_no_subs'] : [];
    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      ...streamArgsFor(streams, outFormat),
      '-ignore_unknown',
      ...timescaleArgs,
      ...movFlags,
      ...mkvFlags,
      out
    ]);

    try {
      const st = fs.statSync(src);
      fs.utimesSync(out, st.atime, st.mtime);
    } catch {}

    emit('done', { out });
    return { out };
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

module.exports = { startExport };
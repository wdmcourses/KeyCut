const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { probeQuick } = require('./probe');

let _concatChild = null;
let _concatCancelled = false;

function killConcat() {
  _concatCancelled = true;
  if (_concatChild) {
    try { _concatChild.kill('SIGKILL'); } catch {}
    _concatChild = null;
  }
}

function outputNameFor(files) {
  const first = files[0];
  const dir = path.dirname(first);
  const folder = path.basename(dir).replace(/\s+/g, '_');
  const allMov = files.every((f) => /\.mov$/i.test(f));
  const ext = allMov ? '.mov' : '.mkv';
  return path.join(dir, (folder || 'joined') + '_joined' + ext);
}

function runFfmpeg(ffmpeg, args, onProgress, totalDuration) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    _concatChild = child;
    let stderr = '';
    child.stderr.on('data', (d) => {
      const chunk = d.toString('utf8');
      stderr += chunk;
      if (onProgress && totalDuration > 0) {
        const m = chunk.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const elapsed = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.min(elapsed / totalDuration, 0.99));
        }
      }
    });
    child.on('error', (err) => { _concatChild = null; reject(err); });
    child.on('close', (code) => {
      _concatChild = null;
      if (_concatCancelled) return reject(new Error('Cancelled'));
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited with code ' + code + ': ' + stderr.slice(-2000)));
    });
  });
}

function runFfmpegList(ffmpeg, args, listStr, onProgress, totalDuration) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    _concatChild = child;
    let stderr = '';
    child.stderr.on('data', (d) => {
      const chunk = d.toString('utf8');
      stderr += chunk;
      if (onProgress && totalDuration > 0) {
        const m = chunk.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const elapsed = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.min(elapsed / totalDuration, 0.99));
        }
      }
    });
    child.on('error', (err) => { _concatChild = null; reject(err); });
    child.on('close', (code) => {
      _concatChild = null;
      if (_concatCancelled) return reject(new Error('Cancelled'));
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited with code ' + code + ': ' + stderr.slice(-2000)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(listStr);
  });
}

function annexbBsf(codec) {
  if (codec === 'h264') return 'h264_mp4toannexb';
  if (codec === 'hevc') return 'hevc_mp4toannexb';
  return null;
}

function channelLayout(ch) {
  if (ch === 1) return 'mono';
  if (ch === 2) return 'stereo';
  return ch > 2 ? String(ch) + 'c' : 'stereo';
}

async function joinFiles({ files, ffmpeg, onProgress, totalDuration }) {
  _concatCancelled = false;
  const out = outputNameFor(files);
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'keycut-join-'));
  try {
    if (onProgress) onProgress(0.01);
    const infos = [];
    let hasAudio = false;
    let audioRate = null;
    let audioCh = null;
    let audioCodec = null;
    for (const f of files) {
      const q = await probeQuick(f, ffmpeg);
      infos.push({ path: f, q });
      if (q && q.audioCodec) {
        hasAudio = true;
        if (audioRate == null) audioRate = q.audioRate;
        if (audioCh == null) audioCh = q.audioChannels;
        if (audioCodec == null) audioCodec = q.audioCodec;
      }
    }
    const needSilent = hasAudio && infos.some((i) => !(i.q && i.q.audioCodec));
    const refAudio = { rate: audioRate || 48000, ch: audioCh || 2, codec: audioCodec || 'aac' };
    const q0 = infos[0].q;
    const direct = q0 && (q0.codec === 'vp9' || q0.codec === 'av1');
    const rotArgs = q0 && q0.rotation ? ['-display_rotation', String(q0.rotation)] : [];

    if (direct && !needSilent) {
      const listStr = files.map((f) => "file '" + f.replace(/\\/g, '/') + "'").join('\n') + '\n';
      await runFfmpegList(ffmpeg, [
        '-y', '-v', 'info', '-stats',
        ...rotArgs,
        '-protocol_whitelist', 'file,pipe,fd',
        '-f', 'concat', '-safe', '0',
        '-i', 'pipe:0',
        '-c', 'copy',
        out
      ], listStr, onProgress, totalDuration || 0);
      if (onProgress) onProgress(1);
      return { ok: true, out };
    }

    const partPaths = [];
    for (let i = 0; i < infos.length; i++) {
      if (_concatCancelled) throw new Error('Cancelled');
      const partPath = path.join(tmpDir, 'part_' + String(i).padStart(4, '0') + (direct ? '.mkv' : '.ts'));
      partPaths.push(partPath);
      const q = infos[i].q;
      const hasFileAudio = !!(q && q.audioCodec);
      const bsf = q && q.codec ? annexbBsf(q.codec) : null;
      const args = ['-y', '-v', 'info', '-stats', '-i', infos[i].path];
      if (!hasFileAudio && needSilent) {
        args.push('-f', 'lavfi', '-i', 'anullsrc=r=' + refAudio.rate + ':cl=' + channelLayout(refAudio.ch));
      }
      args.push('-map', '0:v:0');
      if (bsf) args.push('-bsf:v', bsf);
      args.push('-c:v', 'copy');
      if (hasFileAudio) {
        args.push('-map', '0:a?', '-c:a', 'copy');
      } else if (needSilent) {
        args.push('-map', '1:a:0', '-c:a', refAudio.codec === 'opus' ? 'libopus' : 'aac');
        args.push('-b:a', refAudio.codec === 'opus' ? '96k' : '128k');
        args.push('-shortest');
      }
      if (direct) args.push('-f', 'matroska');
      else args.push('-f', 'mpegts');
      args.push(partPath);
      const segDur = totalDuration ? totalDuration / files.length : 0;
      await runFfmpeg(ffmpeg, args, onProgress ? (p) => onProgress(0.02 + (i / files.length) * 0.7 + p * (0.7 / files.length)) : null, segDur);
    }
    if (_concatCancelled) throw new Error('Cancelled');
    const listStr = partPaths.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n';
    await runFfmpegList(ffmpeg, [
      '-y', '-v', 'info', '-stats',
      ...rotArgs,
      '-protocol_whitelist', 'file,pipe,fd',
      '-f', 'concat', '-safe', '0',
      '-i', 'pipe:0',
      '-c', 'copy',
      out
    ], listStr, onProgress, totalDuration || 0);
    if (onProgress) onProgress(1);
    return { ok: true, out };
  } catch (err) {
    if (err && err.message === 'Cancelled') {
      try { fs.unlinkSync(out); } catch {}
    }
    throw err;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { joinFiles, killConcat, outputNameFor };
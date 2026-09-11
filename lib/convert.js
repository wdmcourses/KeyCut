const fs = require('fs');
const { spawn } = require('child_process');

const SAMPLE_POSITIONS = [0.1, 0.25, 0.5, 0.75, 0.9];
const SAMPLE_DURATION = 3;
const KEYFRAME_THRESHOLD = 2;

let _currentChild = null;
let _cancelled = false;

function killCurrent() {
  _cancelled = true;
  if (_currentChild) {
    try { _currentChild.kill('SIGKILL'); } catch {}
    _currentChild = null;
  }
}

function isCancelled() {
  return _cancelled;
}

function resetCancel() {
  _cancelled = false;
}

function sampleKeyframeCount(src, start, dur, ffmpeg) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner',
      '-skip_frame', 'nokey',
      '-ss', String(start),
      '-t', String(dur),
      '-i', src,
      '-map', '0:v:0',
      '-f', 'null', '-'
    ], { windowsHide: true });
    _currentChild = child;
    let stderr = '';
    child.on('error', (err) => { _currentChild = null; reject(err); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      _currentChild = null;
      if (code === null || isCancelled()) return resolve(-1);
      const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
      resolve(matches.length ? parseInt(matches[matches.length - 1][1], 10) : 0);
    });
  });
}

async function analyzeKeyframes({ src, duration, ffmpeg, onProgress }) {
  resetCancel();
  const densities = [];
  for (let i = 0; i < SAMPLE_POSITIONS.length; i++) {
    if (isCancelled()) throw new Error('Cancelled');
    const start = Math.max(0, duration * SAMPLE_POSITIONS[i] - SAMPLE_DURATION / 2);
    const count = await sampleKeyframeCount(src, start, SAMPLE_DURATION, ffmpeg);
    if (count < 0) throw new Error('Cancelled');
    densities.push(count / SAMPLE_DURATION);
    if (onProgress) onProgress(i + 1, SAMPLE_POSITIONS.length);
  }
  const avg = densities.reduce((a, b) => a + b, 0) / densities.length;
  return { avg, enough: avg >= KEYFRAME_THRESHOLD };
}

function startConvert({ src, out, ffmpeg, duration, interval, onProgress }) {
  return new Promise((resolve, reject) => {
    resetCancel();
    const secs = Number.isFinite(interval) && interval > 0 ? interval : 0.1;
    const child = spawn(ffmpeg, [
      '-y', '-v', 'error', '-stats',
      '-i', src,
      '-c:v', 'libx264',
      '-x264-params', 'scenecut=0',
      '-crf', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*' + secs + ')',
      '-c:a', 'copy',
      out
    ], { windowsHide: true });
    _currentChild = child;
    let stderr = '';
    child.on('error', (err) => { _currentChild = null; reject(err); });
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
    child.on('close', (code) => {
      _currentChild = null;
      if (isCancelled()) {
        try { fs.unlinkSync(out); } catch {}
        return reject(new Error('Cancelled'));
      }
      if (code !== 0) {
        try { fs.unlinkSync(out); } catch {}
        if (/no space left/i.test(stderr)) return reject(new Error('No space left on device'));
        if (/permission denied/i.test(stderr)) return reject(new Error('Permission denied'));
        return reject(new Error('FFmpeg error (code ' + code + ')'));
      }
      resolve({ out });
    });
  });
}

module.exports = { analyzeKeyframes, startConvert, killCurrent };

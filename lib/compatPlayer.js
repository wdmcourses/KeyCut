const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

let _child = null;
let _dummyChild = null;
let _stderrTail = '';

function compatArgs({ path: src, seekTo, videoIndex = 0, audioIndex, size, fps, forceColorspace }) {
  const scaleOpts = [];
  if (size && size > 0) scaleOpts.push(size + ':' + size + ':flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2');
  scaleOpts.push('in_color_matrix=auto:in_range=auto:out_color_matrix=bt709:out_range=tv');
  const parts = [];
  if (fps && fps > 0) parts.push('fps=' + fps);
  parts.push('scale=' + scaleOpts.join(':'));
  parts.push('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709');
  parts.push('format=yuv420p');
  const vf = (forceColorspace ? 'colorspace=iall=bt709:all=bt709,' : '') + parts.join(',');
  return [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', '+nobuffer+flush_packets+discardcorrupt',
    '-avioflags', 'direct',
    '-flush_packets', '1',
    '-ss', String(seekTo),
    '-i', src,
    '-fps_mode', 'passthrough',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-filter_complex', '[' + videoIndex + ':v]' + vf + '[v]',
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '10', '-g', '1',
    ...(audioIndex != null ? ['-map', '0:a:0', '-ac', '2', '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-'
  ];
}

function startCompatOnce(opts) {
  _stderrTail = '';
  const child = spawn(opts.ffmpeg, compatArgs(opts), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  _child = child;
  child.stderr.on('data', (d) => { _stderrTail = (d.toString('utf8') + _stderrTail).slice(0, 2000); });
  child.stdout.pause();
  const clear = () => { if (_child === child) _child = null; };
  child.on('close', clear);
  child.on('error', clear);
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (chunk) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      child.stdout.pause();
      child.stdout.off('data', onData);
      child.stdout.off('end', onEnd);
      child.stdout.off('error', onErr);
      child.off('close', onClose);
      child.off('error', onErrChild);
      resolve(chunk == null ? null : chunk);
    };
    const onData = (d) => { child.stdout.pause(); finish(d); };
    const onEnd = () => finish(null);
    const onErr = () => finish(null);
    const onClose = () => finish(null);
    const onErrChild = () => finish(null);
    child.stdout.once('data', onData);
    child.stdout.once('end', onEnd);
    child.stdout.once('error', onErr);
    child.once('close', onClose);
    child.once('error', onErrChild);
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(null);
    }, 10000);
    child.stdout.resume();
  });
}

async function startCompat(opts) {
  stopCompat();
  let first = await startCompatOnce(opts);
  if (first == null && _stderrTail && /\[swscaler[^\]]*\]\s+Unsupported input/.test(_stderrTail)) {
    first = await startCompatOnce({ ...opts, forceColorspace: true });
  }
  return first;
}

function doRead() {
  return new Promise((resolve) => {
    const child = _child;
    if (!child || child.killed) return resolve(null);
    const onData = (d) => { child.stdout.pause(); cleanup(); resolve(d); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = () => { cleanup(); resolve(null); };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stdout.off('end', onEnd);
      child.stdout.off('error', onError);
    };
    child.stdout.once('data', onData);
    child.stdout.once('end', onEnd);
    child.stdout.once('error', onError);
    child.stdout.resume();
  });
}

let _readChain = Promise.resolve(null);

function readCompatChunk() {
  const p = _readChain.then(() => doRead());
  _readChain = p.catch(() => null);
  return p;
}

function compatStderr() {
  return _stderrTail;
}

function stopCompat() {
  if (_child) { try { _child.kill('SIGKILL'); } catch {} _child = null; }
  if (_dummyChild) { try { _dummyChild.kill('SIGKILL'); } catch {} _dummyChild = null; }
}

function dummyPathFor(tmpDir, src) {
  const h = crypto.createHash('sha1').update(String(src)).digest('hex').slice(0, 12);
  return path.join(tmpDir, 'compat-' + h + '.mkv');
}

function makeDummy({ ffmpeg, duration, outPath, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'info', '-stats',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=8000',
      '-t', String(duration),
      '-c:a', 'flac',
      '-y', outPath
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    _dummyChild = child;
    let stderr = '';
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      stderr += s;
      if (onProgress && duration > 0) {
        const m = s.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const el = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.min(el / duration, 1));
        }
      }
    });
    child.on('error', (err) => { _dummyChild = null; reject(err); });
    child.on('close', (code) => {
      _dummyChild = null;
      if (code === 0) resolve(outPath);
      else reject(new Error('ffmpeg dummy failed: ' + stderr.slice(-400)));
    });
  });
}

module.exports = { startCompat, readCompatChunk, compatStderr, stopCompat, makeDummy, dummyPathFor };
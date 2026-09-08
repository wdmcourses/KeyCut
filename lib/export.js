const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { looksLikeMp4 } = require('./probe');

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


async function startExport({ src, segments, out, tmpDir, ffmpeg, onProgress }) {
  fs.mkdirSync(tmpDir, { recursive: true });

  const emit = (phase, extra) => {
    if (onProgress) onProgress({ phase, ...extra });
  };

  try {
    const partNames = [];
    
    
    
    const partExt = looksLikeMp4(src) ? '.ts' : '.mkv';
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
        '-avoid_negative_ts', 'make_zero',
        partPath
      ]);
      emit('cut', { index: i + 1, total: segments.length });
    }

    
    const listPath = path.join(tmpDir, '_concat.txt');
    const lines = partNames.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n';
    fs.writeFileSync(listPath, lines, 'utf8');

    emit('concat', {});
    await runFfmpeg(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      out
    ]);

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
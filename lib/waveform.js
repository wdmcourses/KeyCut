const { spawn } = require('child_process');

function renderWaveformPng({ filePath, start, duration, streamIndex, width = 2000, height = 300, color = '#ffffff', ffmpeg }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      ...(start != null ? ['-ss', String(start)] : []),
      ...(duration != null ? ['-t', String(duration)] : []),
      '-i', filePath,
      '-filter_complex', '[0:' + streamIndex + ']aformat=channel_layouts=mono,showwavespic=s=' + width + 'x' + height + ':scale=lin:filter=peak:split_channels=0:colors=' + color + '[wf]',
      '-map', '[wf]',
      '-frames:v', '1',
      '-vcodec', 'png',
      '-f', 'image2',
      '-'
    ];
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Waveform timeout')); }, 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !chunks.length) reject(new Error('Waveform failed: ' + err.slice(-400)));
      else resolve(Buffer.concat(chunks));
    });
  });
}

module.exports = { renderWaveformPng };
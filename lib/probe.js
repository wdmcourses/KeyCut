const { spawn } = require('child_process');
const fs = require('fs');
const { parseMp4 } = require('./mp4');

const MP4_EXT = new Set(['.mp4', '.mov', '.m4v', '.m4a', '.3gp', '.3g2']);

function looksLikeMp4(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (!MP4_EXT.has(ext)) return false;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const size = buf.readUInt32BE(0);
    const type = buf.toString('ascii', 4, 8);
    return (size >= 12 && type === 'ftyp') || type === 'moov';
  } catch {
    return false;
  }
}






function runFfmpegProbe(filePath, ffmpeg) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'info',
      '-i', filePath,
      '-map', '0:v:0',
      '-c', 'copy',
      '-f', 'framecrc', '-'
    ];
    let stderr = '';
    let stdout = '';
    const child = spawn(ffmpeg, args, { windowsHide: true });
    child.on('error', reject);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Probe timed out')); }, 60000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseFfmpegOutput(stderr, stdout));
    });
  });
}

function parseFfmpegOutput(stderr, stdout) {
  const info = { duration: null, width: null, height: null, fps: null, keyTimes: [] };
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) info.duration = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);
  const stream = stderr.match(/Stream #\d+:\d+(?:\[\d+\])?.*?Video:.*?(\d+)x(\d+)/);
  if (stream) {
    info.width = parseInt(stream[1], 10);
    info.height = parseInt(stream[2], 10);
  }
  const fps = stderr.match(/Video:.*?(\d+(?:\.\d+)?)\s*(?:fps|fps,)/);
  if (fps) info.fps = parseFloat(fps[1]);

  
  let tbN = 1000;
  const tb = stdout.match(/#tb 0: 1\/(\d+)/);
  if (tb) tbN = parseInt(tb[1], 10);

  
  
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    const fm = line.match(/F=0x([0-9a-fA-F]+)/);
    if (fm && parseInt(fm[1], 16) === 0) continue;
    const mm = line.match(/^(\d+),\s+(-?\d+),\s+(-?\d+),/);
    if (!mm) continue;
    const t = mm[3] / tbN;
    if (t >= 0 && !seen.has(t)) { seen.add(t); info.keyTimes.push(t); }
  }
  info.keyTimes.sort((a, b) => a - b);
  return info;
}

async function probeVideo(filePath, ffmpeg) {
  if (looksLikeMp4(filePath)) {
    try {
      const parsed = await parseMp4(filePath);
      if (parsed && parsed.duration > 0) {
        let keyTimes = parsed.keyTimes;
        if (!keyTimes || keyTimes.length === 0) {
          
          keyTimes = strideKeyTimes(parsed, parsed.timescale);
        }
        return {
          source: filePath,
          duration: parsed.duration,
          width: parsed.width,
          height: parsed.height,
          fps: parsed.fps,
          keyTimes: keyTimes || []
        };
      }
    } catch (e) {
      
    }
  }
  const info = await runFfmpegProbe(filePath, ffmpeg);
  if (!info.duration) {
    throw new Error('Failed to probe video: ' + filePath);
  }
  return { source: filePath, ...info, keyTimes: info.keyTimes || [] };
}

function strideKeyTimes(parsed, timescale) {
  const maxPoints = 50000;
  const total = parsed.totalSamples || Math.floor(parsed.duration * parsed.fps);
  if (total <= maxPoints) {
    const step = total > 1 ? parsed.duration / (total - 1) : parsed.duration;
    const times = [];
    for (let i = 0; i < total; i++) times.push(i * step);
    return times;
  }
  const stepSamples = Math.ceil(total / maxPoints);
  const frameDur = parsed.duration / total;
  const times = [];
  for (let i = 0; i < total; i += stepSamples) times.push(i * frameDur);
  return times;
}

module.exports = { probeVideo, looksLikeMp4 };
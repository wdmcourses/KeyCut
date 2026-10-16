const { spawn } = require('child_process');
const fs = require('fs');
const { parseMp4 } = require('./mp4');

const MAX_PROBES = 3;
let _activeProbes = 0;
const _probeQueue = [];
function probeSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _activeProbes++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        _activeProbes--;
        const next = _probeQueue.shift();
        if (next) next();
      });
    };
    if (_activeProbes < MAX_PROBES) run();
    else _probeQueue.push(run);
  });
}

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
  return probeSlot(() => new Promise((resolve, reject) => {
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
  }));
}

function parseFfmpegOutput(stderr, stdout) {
  const info = { duration: null, width: null, height: null, fps: null, keyTimes: [], videoTimebase: null };
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) info.duration = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);
  const stream = stderr.match(/Stream #\d+:\d+(?:\[\d+\])?.*?Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
  if (stream) {
    info.width = parseInt(stream[1], 10);
    info.height = parseInt(stream[2], 10);
  }
  const rot = stderr.match(/display\s*matrix:\s*rotation of\s*(-?\d+(?:\.\d+)?)\s*degrees/i);
  if (rot) {
    const deg = ((Math.round(parseFloat(rot[1])) % 360) + 360) % 360;
    info.rotation = (deg >= 315 || deg < 45) ? 0 : deg >= 45 && deg < 135 ? 90 : deg >= 135 && deg < 225 ? 180 : 270;
    if ((info.rotation === 90 || info.rotation === 270) && info.width != null && info.height != null) {
      const t = info.width;
      info.width = info.height;
      info.height = t;
    }
  } else {
    info.rotation = 0;
  }
  const fps = stderr.match(/Video:.*?(\d+(?:\.\d+)?)\s*(?:fps|fps,)/);
  if (fps) info.fps = parseFloat(fps[1]);
  const tbn = stderr.match(/Video:.*?(\d+)(k)?\s+tbn/);
  if (tbn) info.videoTimebase = parseInt(tbn[1], 10) * (tbn[2] ? 1000 : 1);

  
  const seen = new Set();
  for (const f of parseFrames(stdout)) {
    if (f.keyframe && f.time >= 0 && !seen.has(f.time)) { seen.add(f.time); info.keyTimes.push(f.time); }
  }
  info.keyTimes.sort((a, b) => a - b);
  return info;
}

function parseFrames(stdout) {
  let tbN = 1000;
  const tb = stdout.match(/#tb 0: 1\/(\d+)/);
  if (tb) tbN = parseInt(tb[1], 10);
  const frames = [];
  for (const line of stdout.split('\n')) {
    const mm = line.match(/^(\d+),\s+(-?\d+),\s+(-?\d+),/);
    if (!mm || mm[1] !== '0') continue;
    const fm = line.match(/F=0x([0-9a-fA-F]+)/);
    const keyframe = !(fm && parseInt(fm[1], 16) === 0);
    frames.push({ time: parseInt(mm[3], 10) / tbN, keyframe });
  }
  frames.sort((a, b) => a.time - b.time);
  return frames;
}

function readFrames({ filePath, ffmpeg, streamIndex = 'v:0', from, to }) {
  const intervalArgs = from != null && to != null ? ['-copyts', '-ss', String(from), '-t', String(Math.max(0, to - from))] : [];
  const args = ['-v', 'info', ...intervalArgs, '-i', filePath, '-map', '0:' + streamIndex, '-c', 'copy', '-f', 'framecrc', '-'];
  return probeSlot(() => new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stdout = '';
    child.on('error', reject);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error('Probe timed out')); }, 60000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseFrames(stdout));
    });
  }));
}

function parseStreams(stderr) {
  const streams = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(/Stream #0:(\d+).*?(Video|Audio|Subtitle|Data|Attachment):\s*([a-zA-Z0-9_]+)/);
    if (!m) continue;
    const disposition = [];
    if (/\(default\)/.test(line)) disposition.push('default');
    if (/\(forced\)/.test(line)) disposition.push('forced');
    if (/\(attached pic\)/.test(line)) disposition.push('attached_pic');
    const sr = line.match(/(\d+)\s*Hz/);
    streams.push({
      index: parseInt(m[1], 10),
      codec_type: m[2].toLowerCase(),
      codec_name: m[3].toLowerCase(),
      sample_rate: sr ? parseInt(sr[1], 10) : null,
      disposition
    });
  }
  return streams;
}

function parseContainer(stderr) {
  const m = stderr.match(/Input #0,\s*(.+?),\s*from\s*'/);
  return m ? m[1].trim().toLowerCase() : null;
}

function probeMedia(filePath, ffmpeg) {
  return probeSlot(() => new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let stderr = '';
    child.on('error', () => resolve(null));
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('close', () => resolve({ container: parseContainer(stderr), streams: parseStreams(stderr) }));
  }));
}

function probeStreams(filePath, ffmpeg) {
  return probeMedia(filePath, ffmpeg).then((media) => (media ? media.streams : null));
}

function probeFlags(filePath, ffmpeg) {
  return probeSlot(() => new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let stderr = '';
    child.on('error', () => resolve({ pcmAudio: false, hasThumbnail: false, streams: [] }));
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('close', () => resolve({
      pcmAudio: /Audio:\s*pcm/i.test(stderr),
      hasThumbnail: /\(attached pic\)/i.test(stderr),
      streams: parseStreams(stderr)
    }));
  }));
}

async function probeVideo(filePath, ffmpeg) {
  if (looksLikeMp4(filePath)) {
    try {
      const parsed = await parseMp4(filePath);
      if (parsed && parsed.duration > 0) {
        const frames = await readFrames({ filePath, ffmpeg });
        const keyTimes = frames.filter((f) => f.keyframe && f.time >= 0).map((f) => f.time);
        const flags = await probeFlags(filePath, ffmpeg);
        return {
          source: filePath,
          duration: parsed.duration,
          width: parsed.width,
          height: parsed.height,
          rotation: parsed.rotation || 0,
          fps: parsed.fps,
          keyTimes,
          pcmAudio: flags.pcmAudio,
          hasThumbnail: flags.hasThumbnail,
          videoTimebase: parsed.timescale || null,
          streams: flags.streams
        };
      }
    } catch (e) {
      
    }
  }
  const info = await runFfmpegProbe(filePath, ffmpeg);
  if (!info.duration) {
    throw new Error('Failed to probe video: ' + filePath);
  }
  const flags = await probeFlags(filePath, ffmpeg);
  return { source: filePath, ...info, keyTimes: info.keyTimes || [], pcmAudio: flags.pcmAudio, hasThumbnail: flags.hasThumbnail, streams: flags.streams };
}

function probeQuick(filePath, ffmpeg) {
  return probeSlot(() => new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let stderr = '';
    child.on('error', reject);
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Probe timed out')); }, 30000);
    child.on('close', () => {
      clearTimeout(timer);
      const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const stream = stderr.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
      const fps = stderr.match(/Video:.*?(\d+(?:\.\d+)?)\s*(?:fps|fps,)/);
      const codec = stderr.match(/Video:\s*([a-zA-Z0-9_]+)/);
      const sar = stderr.match(/\[SAR (\d+):(\d+) DAR (\d+):(\d+)\]/);
      const audio = stderr.match(/Audio:\s*([a-zA-Z0-9_]+).*?(\d+)\s*Hz.*?(mono|stereo|\d+(?:\.\d+)?\s*(?:channels?)?)/);
      const audioMono = stderr.match(/Audio:.*?mono/);
      const audioStereo = stderr.match(/Audio:.*?stereo/);
      const rot = stderr.match(/display\s*matrix:\s*rotation of\s*(-?\d+(?:\.\d+)?)\s*degrees/i);
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch {}
      let rotation = 0;
      if (rot) {
        const deg = ((Math.round(parseFloat(rot[1])) % 360) + 360) % 360;
        rotation = (deg >= 315 || deg < 45) ? 0 : deg >= 45 && deg < 135 ? 90 : deg >= 135 && deg < 225 ? 180 : 270;
      }
      resolve({
        duration: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : null,
        width: stream ? parseInt(stream[1], 10) : null,
        height: stream ? parseInt(stream[2], 10) : null,
        fps: fps ? parseFloat(fps[1]) : null,
        codec: codec ? codec[1].toLowerCase() : null,
        sarNum: sar ? parseInt(sar[1], 10) : null,
        sarDen: sar ? parseInt(sar[2], 10) : null,
        audioCodec: audio ? audio[1].toLowerCase() : null,
        audioRate: audio ? parseInt(audio[2], 10) : null,
        audioChannels: audioMono ? 1 : audioStereo ? 2 : (audio && audio[3] ? (parseFloat(audio[3]) || null) : null),
        rotation,
        size
      });
    });
  }));
}

module.exports = { probeVideo, probeQuick, probeStreams, probeMedia, looksLikeMp4, readFrames };
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { probeVideo, readFrames } = require('../lib/probe');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(os.tmpdir(), 'keycut-keyframe-align');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

function run(args) {
  const r = spawnSync(FF, args, { windowsHide: true, maxBuffer: 1e8 });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').toString().slice(-400));
  return r.stdout.toString();
}

function seekTime(file, t) {
  const out = run(['-v', 'error', '-ss', String(t), '-copyts', '-i', file, '-frames:v', '1', '-c', 'copy', '-f', 'framecrc', '-']);
  let tb = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^#tb 0: 1\/(\d+)/);
    if (m) { tb = parseInt(m[1], 10); continue; }
    if (line.startsWith('0,')) return +line.split(',')[2].trim() / tb;
  }
  return null;
}

(async () => {
  const plain = path.join(WORK, 'plain.mp4');
  run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p', plain]);

  const vid = path.join(WORK, 'vid.mp4');
  const aud = path.join(WORK, 'aud.m4a');
  run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p', vid]);
  run(['-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'aac', aud]);
  const editlist = path.join(WORK, 'editlist.mov');
  run(['-y', '-i', aud, '-itsoffset', '0.044', '-i', vid, '-map', '1:v', '-map', '0:a', '-c', 'copy', editlist]);

  for (const [name, file] of [['plain', plain], ['edit-list', editlist]]) {
    console.log('[' + name + ']');
    const frames = await readFrames({ filePath: file, ffmpeg: FF });
    const ref = frames.filter((f) => f.keyframe).map((f) => f.time);
    const meta = await probeVideo(file, FF);
    const got = meta.keyTimes || [];
    check('keyframe count matches ffmpeg packets', got.length === ref.length, 'got ' + got.length + ' ref ' + ref.length);
    let same = got.length === ref.length && got.length > 0;
    for (let i = 0; same && i < got.length; i++) if (Math.abs(got[i] - ref[i]) > 0.000001) same = false;
    check('keyframe times match ffmpeg packets', same, 'got ' + got.slice(0, 5) + ' ref ' + ref.slice(0, 5));
    let seekOk = true;
    let detail = '';
    for (let i = 1; i < Math.min(got.length, 4); i++) {
      const st = seekTime(file, got[i].toFixed(6));
      if (st == null || Math.abs(st - got[i]) > 0.001) {
        seekOk = false;
        detail = 'keyframe ' + i + ' t=' + got[i] + ' seek ' + st;
        break;
      }
    }
    check('seek lands exactly on each keyframe', seekOk, detail);
  }

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });

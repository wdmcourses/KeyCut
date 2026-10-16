const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { probeQuick } = require('../lib/probe');
const { joinFiles } = require('../lib/concat');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(os.tmpdir(), 'keycut-join-rotation');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

function run(args) { const r = spawnSync(FF, args, { windowsHide: true, maxBuffer: 1e8 }); if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').toString().slice(-300)); return r; }
function rotationOf(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8' });
  const m = (r.stderr || '').match(/display\s*matrix:\s*rotation of\s*(-?\d+(?:\.\d+)?)\s*degrees/i);
  return m ? Math.abs(Math.round(parseFloat(m[1]))) % 360 : 0;
}
function mkRotated(file, withAudio) {
  const src = file + '.src.mov';
  const a = ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1'];
  if (withAudio) a.push('-f', 'lavfi', '-i', 'sine=f=440:d=1', '-map', '0:v', '-map', '1:a');
  a.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) a.push('-c:a', 'aac', '-shortest');
  a.push(src);
  run(a);
  run(['-y', '-i', src, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', file]);
}

(async () => {
  const d1 = path.join(WORK, 'same');
  fs.mkdirSync(d1, { recursive: true });
  const a = path.join(d1, 'a.mov');
  const b = path.join(d1, 'b.mov');
  mkRotated(a, true);
  fs.copyFileSync(a, b);

  check('fixture has rotation 90', rotationOf(a) === 90, 'got ' + rotationOf(a));
  const q = await probeQuick(a, FF);
  check('probeQuick detects rotation 90', q.rotation === 90, 'got ' + q.rotation);

  const r1 = await joinFiles({ files: [a, b], ffmpeg: FF, totalDuration: 2 });
  check('join compatible: rotation preserved', rotationOf(r1.out) === 90, 'got ' + rotationOf(r1.out));

  const d2 = path.join(WORK, 'noaudio');
  fs.mkdirSync(d2, { recursive: true });
  const a2 = path.join(d2, 'a.mov');
  const c2 = path.join(d2, 'c.mov');
  mkRotated(a2, true);
  mkRotated(c2, false);
  const r2 = await joinFiles({ files: [a2, c2], ffmpeg: FF, totalDuration: 2 });
  check('join missing-audio (fallback): rotation preserved', rotationOf(r2.out) === 90, 'got ' + rotationOf(r2.out));

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });

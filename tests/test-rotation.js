const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { probeQuick, probeStreams, probeVideo } = require('../lib/probe');
const { startExport } = require('../lib/export');
const { joinFiles } = require('../lib/concat');
const { joinSources } = require('../lib/joinutil');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(os.tmpdir(), 'keycut-rotation');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

function run(args) {
  const r = spawnSync(FF, args, { windowsHide: true, maxBuffer: 1e8 });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').toString().slice(-300));
}

function matrix(p) {
  const r = spawnSync(FF, ['-hide_banner', '-i', p], { windowsHide: true, encoding: 'utf8' });
  const m = (r.stderr || '').match(/display\s*matrix:\s*rotation of\s*(-?\d+(?:\.\d+)?)\s*degrees/i);
  return m ? parseFloat(m[1]) : 0;
}

function sameAngle(a, b) {
  const d = ((a - b) % 360 + 540) % 360 - 180;
  return Math.abs(d) < 1;
}

function mkRotated(file, deg) {
  const src = file + '.src.mp4';
  run(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  const a = ['-y', '-v', 'error', '-i', src, '-c', 'copy'];
  if (deg) a.push('-metadata:s:v:0', 'rotate=' + deg);
  a.push(file);
  run(a);
}

(async () => {
  for (const deg of [0, 90, 180, 270]) {
    const a = path.join(WORK, 'a_' + deg + '.mov');
    const b = path.join(WORK, 'b_' + deg + '.mov');
    mkRotated(a, deg);
    mkRotated(b, deg);
    const src = matrix(a);

    const meta = await probeVideo(a, FF);
    const pq = await probeQuick(a, FF);
    check('deg ' + deg + ': probeVideo matches source', sameAngle(meta.rotation, src), 'probeVideo=' + meta.rotation + ' src=' + src);
    check('deg ' + deg + ': probeQuick matches source', sameAngle(pq.rotation, src), 'probeQuick=' + pq.rotation + ' src=' + src);

    const exp = path.join(WORK, 'exp_' + deg + '.mov');
    await startExport({ src: a, segments: [[0, 0.6]], out: exp, tmpDir: path.join(WORK, 't_' + deg), ffmpeg: FF, videoTimebase: meta.videoTimebase, hasThumbnail: meta.hasThumbnail, streams: meta.streams, rotation: meta.rotation, compress: false, duration: 0.6, tools: [], gpu: null });
    check('deg ' + deg + ': startExport keeps rotation', sameAngle(matrix(exp), src), 'got ' + matrix(exp));

    const jf = await joinFiles({ files: [a, b], ffmpeg: FF, totalDuration: 2 });
    check('deg ' + deg + ': joinFiles keeps rotation', sameAngle(matrix(jf.out), src), 'got ' + matrix(jf.out));

    const parts = [];
    for (const f of [a, b]) {
      const q = await probeQuick(f, FF);
      let streams = null;
      try { streams = await probeStreams(f, FF); } catch { streams = null; }
      parts.push({ sourcePath: f, segments: [[0, q.duration]], duration: q.duration, streams, hasThumbnail: false, rotation: q.rotation || 0, videoTimebase: null });
    }
    const js = path.join(WORK, 'js_' + deg + '.mov');
    await joinSources({ parts, outputPath: js, ffmpeg: FF, tmpDir: path.join(WORK, 'jt_' + deg), compress: false });
    check('deg ' + deg + ': joinSources keeps rotation', sameAngle(matrix(js), src), 'got ' + matrix(js));
  }

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });

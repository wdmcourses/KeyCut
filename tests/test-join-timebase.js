const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { probeQuick, probeStreams } = require('../lib/probe');
const { joinSources, assertJoinable } = require('../lib/joinutil');
const { outputNameFor } = require('../lib/concat');
const { preferredLosslessExt } = require('../lib/formats');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(os.tmpdir(), 'keycut-join-timebase');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

function run(args) {
  const r = spawnSync(FF, args, { windowsHide: true, maxBuffer: 1e8 });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').toString().slice(-300));
}

async function buildParts(files) {
  const metas = [];
  for (const f of files) metas.push(await probeQuick(f, FF));
  const err = assertJoinable(metas);
  if (err) throw new Error(err);
  const parts = [];
  for (let i = 0; i < files.length; i++) {
    let streams = null;
    try { streams = await probeStreams(files[i], FF); } catch { streams = null; }
    const hasThumbnail = !!(streams && streams.some((s) => s && s.disposition && s.disposition.includes('attached_pic')));
    parts.push({
      sourcePath: files[i],
      segments: [[0, metas[i].duration]],
      duration: metas[i].duration,
      streams,
      hasThumbnail,
      rotation: metas[i].rotation || 0,
      videoTimebase: null
    });
  }
  return parts;
}

(async () => {
  const a = path.join(WORK, 'a.mov');
  const b = path.join(WORK, 'b.mp4');
  run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-video_track_timescale', '16000', a]);
  run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-video_track_timescale', '60000', b]);

  const qa = await probeQuick(a, FF);
  const qb = await probeQuick(b, FF);
  check('fixtures probed', !!qa && !!qb && qa.duration > 0 && qb.duration > 0);

  const out = path.join(WORK, 'out.mkv');
  const parts = await buildParts([a, b]);
  check('preferred container follows first source (mov)', preferredLosslessExt(parts[0].streams, 'mov') === 'mov', preferredLosslessExt(parts[0].streams, 'mov'));
  check('joined auto-name uses that container', outputNameFor([a, b], preferredLosslessExt(parts[0].streams, 'mov')).endsWith('_joined.mov'));
  const res = await joinSources({ parts, outputPath: out, ffmpeg: FF, tmpDir: path.join(WORK, 'tmp'), compress: false });
  check('join succeeds', !!(res && res.ok), res && res.error);

  const qo = (res && res.ok) ? await probeQuick(out, FF) : null;
  const dur = qo ? qo.duration : 0;
  check('joined duration ~4s (no timebase inflation)', dur > 3.4 && dur < 4.6, 'got ' + dur);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });

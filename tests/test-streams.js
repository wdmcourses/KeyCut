const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startExport } = require('../lib/export');
const { probeVideo } = require('../lib/probe');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(os.tmpdir(), 'keycut-streams');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

function run(args) {
  const r = spawnSync(FF, args, { windowsHide: true, maxBuffer: 1e8 });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').toString().slice(-400));
}

async function exportTo(src, out, tmp, streams) {
  const meta = await probeVideo(src, FF);
  await startExport({
    src, segments: [[0.2, 1.2], [1.6, 2.8]], out, tmpDir: tmp,
    ffmpeg: FF, videoTimebase: meta.videoTimebase, hasThumbnail: meta.hasThumbnail, streams: streams || meta.streams,
    compress: false, resolution: null, quality: null, gpu: null, duration: 2.2, tools: [],
  });
  const m = await probeVideo(out, FF);
  return (m.streams || []).map((s) => s.codec_type + ':' + s.codec_name);
}

(async () => {
  run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-f', 'lavfi', '-i', 'sine=f=880:d=3',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(WORK, 'av.mp4')]);
  fs.writeFileSync(path.join(WORK, 's.srt'), '1\n00:00:00,500 --> 00:00:01,500\nhi\n\n');
  run(['-v', 'error', '-y', '-i', path.join(WORK, 'av.mp4'), '-i', path.join(WORK, 's.srt'),
    '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', path.join(WORK, 'src.mp4')]);
  run(['-v', 'error', '-y', '-i', path.join(WORK, 'av.mp4'), '-i', path.join(WORK, 's.srt'),
    '-map', '0', '-map', '1', '-c', 'copy', path.join(WORK, 'src.mkv')]);

  console.log('[mp4 source: video + 2 audio + mov_text]');
  const meta = await probeVideo(path.join(WORK, 'src.mp4'), FF);
  const srcTypes = (meta.streams || []).map((s) => s.codec_type);
  check('source probed with 2 audio + subtitle', srcTypes.filter((t) => t === 'audio').length === 2 && srcTypes.includes('subtitle'), srcTypes.join(','));

  const st1 = await exportTo(path.join(WORK, 'src.mp4'), path.join(WORK, 'out1.mp4'), path.join(WORK, 't1'));
  check('export keeps video', st1.some((t) => t.startsWith('video:')), st1.join(' | '));
  check('export keeps both audio tracks', st1.filter((t) => t.startsWith('audio:')).length === 2, st1.join(' | '));
  check('export keeps subtitle', st1.some((t) => t.startsWith('subtitle:')), st1.join(' | '));

  console.log('[mkv source with subrip -> mp4 output]');
  const st2 = await exportTo(path.join(WORK, 'src.mkv'), path.join(WORK, 'out2.mp4'), path.join(WORK, 't2'));
  check('export keeps both audio tracks', st2.filter((t) => t.startsWith('audio:')).length === 2, st2.join(' | '));
  check('subtitle converted to mov_text for mp4', st2.includes('subtitle:mov_text'), st2.join(' | '));

  console.log('[single video+audio still works]');
  run(['-v', 'error', '-y', '-i', path.join(WORK, 'av.mp4'), '-map', '0:v', '-map', '0:a:0', '-c', 'copy', '-shortest', path.join(WORK, 'plain.mp4')]);
  const st3 = await exportTo(path.join(WORK, 'plain.mp4'), path.join(WORK, 'out3.mkv'), path.join(WORK, 't3'));
  check('plain source exports video+audio', st3.some((t) => t.startsWith('video:')) && st3.some((t) => t.startsWith('audio:')), st3.join(' | '));

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });

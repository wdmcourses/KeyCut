const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startExport } = require('../lib/export');
const { probeVideo, probeStreams } = require('../lib/probe');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(process.env.KEYCUT_TMP || os.tmpdir(), 'keycut-plugin-matrix');
const FX = path.join(WORK, 'fx');
const PLUG = path.join(WORK, 'plug');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(FX, { recursive: true });
fs.mkdirSync(PLUG, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d == null ? '' : d); } };

function run(args) {
  const r = spawnSync(FF, args, { windowsHide: true, maxBuffer: 1e8 });
  if (r.status !== 0) throw new Error('ffmpeg: ' + (r.stderr || '').toString().slice(-500));
  return r;
}

function containerOf(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8' });
  const m = ((r.stderr || '') + (r.stdout || '')).match(/Input #0,\s*(.+?),\s*from/);
  return m ? m[1] : null;
}

async function streamsOf(file) {
  return (await probeStreams(file, FF)) || [];
}

const W = 160, H = 90, FPS = 12.5, DUR = 0.4;
const VH = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-g', '5'];
const VP9 = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '45', '-deadline', 'realtime', '-cpu-used', '8'];
const SRT = path.join(WORK, 's.srt');
const DEFS = {
  mp4_h264_aac: ['mp4', 'mp4', VH, ['-c:a', 'aac', '-b:a', '96k']],
  mov_h264_pcm: ['mov', 'mov', VH, ['-c:a', 'pcm_s16le']],
  mkv_h264_opus: ['mkv', 'matroska', VH, ['-c:a', 'libopus', '-b:a', '64k']],
  webm_vp9_opus: ['webm', 'webm', ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '45', '-deadline', 'realtime', '-cpu-used', '8'], ['-c:a', 'libopus', '-b:a', '64k']],
  mkv_mpeg4_mp3: ['mkv', 'matroska', ['-c:v', 'mpeg4', '-q:v', '6'], ['-c:a', 'libmp3lame', '-b:a', '64k']],
  mkv_h264_noaudio: ['mkv', 'matroska', VH, ['-an']],
  mkv_h264_srt: ['mkv', 'matroska', VH, ['-c:a', 'aac', '-b:a', '96k'], 'subrip']
};

function genFixture(id) {
  const [ext, fmt, v, a, sub] = DEFS[id];
  const file = path.join(FX, id + '.' + ext);
  if (fs.existsSync(file)) return file;
  const base = path.join(FX, id + '_base.mp4');
  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=' + W + 'x' + H + ':rate=' + FPS + ':duration=' + DUR,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + DUR, ...v, ...a];
  if (!sub) { run([...args, '-f', fmt, file]); return file; }
  run([...args, '-f', 'mp4', base]);
  if (sub === 'mov_text') run(['-y', '-hide_banner', '-loglevel', 'error', '-i', base, '-i', SRT, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', '-f', 'mp4', file]);
  else run(['-y', '-hide_banner', '-loglevel', 'error', '-i', base, '-i', SRT, '-map', '0', '-map', '1', '-c', 'copy', '-f', 'matroska', file]);
  fs.rmSync(base, { force: true });
  return file;
}

const BYTES_JS = path.join(WORK, 'bytes-tool.js');
fs.writeFileSync(BYTES_JS, [
  "const fs = require('fs');",
  "const path = require('path');",
  'const input = process.argv[2];',
  "const out = path.join(process.cwd(), 'plugin' + process.env.CLAIM_EXT);",
  'fs.copyFileSync(input, out);',
  "console.log('output     : ' + out);",
  ''
].join('\n'), 'utf8');

function bytesTool(claim) {
  return {
    id: 'bytes', label: 'bytes', cmd: [process.execPath, BYTES_JS],
    env: { ...process.env, CLAIM_EXT: claim }, args: [],
    outputRe: /^output\s*:\s*(.+?)\s*$/m, progressMarks: []
  };
}

function videoTool(name, plugExt, fmt, withSub, vcodec, acopy) {
  const out = path.join(PLUG, name + plugExt);
  const args = [];
  if (withSub) args.push('-i', SRT);
  args.push('-map', '0:v:0', ...(withSub ? ['-map', '1:0'] : []), ...(acopy ? ['-map', '0:a:0'] : []));
  args.push(...(vcodec === 'vp9' ? VP9 : VH));
  args.push(...(acopy ? ['-c:a', 'copy'] : ['-an']));
  if (withSub) args.push('-c:s', 'mov_text');
  args.push('-f', fmt, out);
  return {
    id: name, label: name, cmd: [FF, '-y', '-v', 'info', '-i'], args,
    outputRe: /^Output #\d+,\s*[a-z0-9]+,\s*to\s*'(.+?)':/m, progressMarks: []
  };
}

const CASES = [
  { src: 'mp4_h264_aac', kind: 'bytes', claim: '.mkv', out: '.mkv', audio: true },
  { src: 'mp4_h264_aac', kind: 'bytes', claim: '.mkv', out: '.mp4', audio: true },
  { src: 'mov_h264_pcm', kind: 'bytes', claim: '.mkv', out: '.mkv', audio: true },
  { src: 'mov_h264_pcm', kind: 'bytes', claim: '.mp4', out: '.mkv', audio: true },
  { src: 'mov_h264_pcm', kind: 'bytes', claim: '.mp4', out: '.mp4', block: 'pcm' },
  { src: 'mkv_h264_opus', kind: 'bytes', claim: '.mp4', out: '.mkv', audio: true },
  { src: 'mkv_h264_opus', kind: 'bytes', claim: '.mp4', out: '.mp4', audio: true },
  { src: 'webm_vp9_opus', kind: 'bytes', claim: '.mp4', out: '.mkv', audio: true },
  { src: 'webm_vp9_opus', kind: 'video', plug: '.mkv', fmt: 'matroska', out: '.webm', fell: '.mkv', audio: false },
  { src: 'webm_vp9_opus', kind: 'video', plug: '.webm', fmt: 'matroska', out: '.webm', fell: '.mkv', audio: false },
  { src: 'mp4_h264_aac', kind: 'video', plug: '.mkv', fmt: 'matroska', out: '.avi', vcodec: 'vp9', fell: '.mkv', audio: false },
  { src: 'mkv_h264_opus', kind: 'video', plug: '.mkv', fmt: 'matroska', out: '.mp4', acopy: true, fell: '.mkv', audio: true },
  { src: 'mkv_h264_noaudio', kind: 'bytes', claim: '.mp4', out: '.mkv', audio: false },
  { src: 'mkv_h264_srt', kind: 'bytes', claim: '.mkv', out: '.mp4', audio: true, sub: 'mov_text' },
  { src: 'mp4_h264_aac', kind: 'video', plug: '.mp4', fmt: 'mp4', out: '.mp4', audio: false },
  { src: 'mp4_h264_aac', kind: 'video', plug: '.mkv', fmt: 'matroska', out: '.mkv', audio: false },
  { src: 'mkv_mpeg4_mp3', kind: 'video', plug: '.mkv', fmt: 'matroska', out: '.mkv', audio: false },
  { src: 'mkv_h264_opus', kind: 'video', plug: '.mkv', fmt: 'matroska', out: '.mp4', audio: false },
  { src: 'mov_h264_pcm', kind: 'video', plug: '.mkv', fmt: 'matroska', out: '.mkv', audio: false },
  { src: 'mp4_h264_aac', kind: 'videosub', plug: '.mp4', fmt: 'mp4', out: '.mkv', audio: false, sub: 'subrip' },
  { src: 'mp4_h264_aac', kind: 'videosub', plug: '.mp4', fmt: 'mp4', out: '.mp4', audio: false, sub: 'mov_text' }
];

(async () => {
  fs.writeFileSync(SRT, '1\n00:00:00,050 --> 00:00:00,250\nhi\n\n');
  const files = {};
  for (const id of Object.keys(DEFS)) files[id] = genFixture(id);
  const metas = {};
  for (const id of Object.keys(files)) metas[id] = await probeVideo(files[id], FF);

  let i = 0;
  for (const c of CASES) {
    i++;
    const name = '[' + i + '] ' + c.src + ' + ' + c.kind + (c.claim ? '(' + c.claim + ')' : '') + ' -> .' + c.out.replace('.', '');
    const tmpDir = path.join(WORK, 't' + i);
    const out = path.join(WORK, 'out' + i + c.out);
    const saved = path.join(WORK, 'out' + i + (c.fell || c.out));
    const tool = c.kind === 'bytes' ? bytesTool(c.claim) : videoTool(c.kind + i, c.plug, c.fmt, c.kind === 'videosub', c.vcodec, c.acopy);
    let err = null;
    let res = null;
    try {
      res = await startExport({
        src: files[c.src], segments: [[0.05, 0.35]], out, tmpDir, ffmpeg: FF,
        videoTimebase: null, hasThumbnail: false, streams: metas[c.src].streams,
        compress: false, duration: 0.3, tools: [tool]
      });
    } catch (e) {
      err = e.message;
    }
    if (c.block) {
      const matched = !!err && (c.block === 'pcm' ? /Could not find tag for codec pcm/.test(err) : true);
      check(name + ' blocked at the intermediate (pre-existing)', matched, err ? err.slice(0, 200) : 'no error at all');
      continue;
    }
    if (err) { check(name + ' exports', false, err.split('\n')[0].slice(0, 200)); continue; }
    const st = await streamsOf(saved);
    const cont = String(containerOf(saved));
    const wantExt = c.fell || c.out;
    const wantCont = wantExt === '.mkv' ? cont.startsWith('matroska') : /^mov,mp4/.test(cont);
    const summary = cont + ' :: ' + st.map((s) => s.codec_type + ':' + s.codec_name).join(' | ');
    if (c.fell) check(name + ' saved to the plugin container', !!res && res.out === saved && !fs.existsSync(out), res && res.out);
    check(name + ' container', wantCont && fs.existsSync(saved) && fs.statSync(saved).size > 0, summary);
    check(name + ' video', st.some((s) => s.codec_type === 'video'), summary);
    check(name + ' audio=' + c.audio, st.some((s) => s.codec_type === 'audio') === c.audio, summary);
    if (c.sub) check(name + ' subtitle=' + c.sub, st.some((s) => s.codec_type === 'subtitle' && s.codec_name === c.sub), summary);
    check(name + ' temp cleaned', !fs.existsSync(tmpDir), summary);
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

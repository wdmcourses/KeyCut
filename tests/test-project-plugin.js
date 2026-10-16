const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FF = path.join(ROOT, 'vendor', 'ffmpeg', 'win32', 'ffmpeg.exe');
const DIR = path.join(os.tmpdir(), 'keycut-project-plugin');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const SRC = path.join(DIR, 'a.mp4');
const SRC2 = path.join(DIR, 'b.mp4');
const OUT = path.join(DIR, 'combined.mp4');
const WSRC = path.join(DIR, 'w1.webm');
const WSRC2 = path.join(DIR, 'w2.webm');
const WOUT = path.join(DIR, 'combined.webm');
const WSAVED = path.join(DIR, 'combined.mkv');
const FAKE_APP = path.join(DIR, 'app');
const EXT = path.join(FAKE_APP, 'resources', 'lossless-debreath');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, d == null ? '' : d); } };

function makeVideo(p, dur) {
  const r = spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=' + dur, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + dur, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-shortest', p]);
  if (r.status !== 0) { console.error('gen fail', r.stderr.toString()); process.exit(1); }
}

function probeDur(p) {
  const r = spawnSync(FF, ['-hide_banner', '-i', p], { windowsHide: true });
  const m = r.stderr.toString().match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
}

function makeWebm(p, dur) {
  const r = spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=' + dur, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + dur, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '45', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '64k', '-shortest', p]);
  if (r.status !== 0) { console.error('gen fail', r.stderr.toString()); process.exit(1); }
}

function installFakePlugin() {
  fs.mkdirSync(path.join(EXT, 'python'), { recursive: true });
  const py = path.join(EXT, 'python', 'python.exe');
  try { fs.linkSync(process.execPath, py); } catch { fs.copyFileSync(process.execPath, py); }
  fs.writeFileSync(path.join(EXT, 'debreath.py'), [
    "const path = require('path');",
    "const { spawnSync } = require('child_process');",
    'const FF = ' + JSON.stringify(FF) + ';',
    'const input = process.argv[2];',
    "const out = path.join(process.cwd(), 'doubled.mkv');",
    "const r = spawnSync(FF, ['-y', '-v', 'error', '-i', input, '-vf', 'setpts=2*PTS', '-af', 'atempo=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out], { windowsHide: true });",
    'if (r.status !== 0) { console.error(String(r.stderr)); process.exit(1); }',
    "console.log('output     : ' + out);",
    ''
  ].join('\n'), 'utf8');
}

const handlers = {};
const stub = {
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {}, once: () => {}, on: () => {} },
  dialog: {},
  screen: {},
  app: { getPath: () => path.join(DIR, 'userData'), isPackaged: false }
};
const origLoad = Module._load;
Module._load = function (request) { if (request === 'electron') return stub; return origLoad.apply(this, arguments); };
process.resourcesPath = ROOT;
const { registerIpc } = require(path.join(ROOT, 'lib', 'ipc'));
const { probeStreams } = require(path.join(ROOT, 'lib', 'probe'));
Module._load = origLoad;

function payloadFor(streamsA, streamsB, tools, compress) {
  return {
    timelines: [
      { sourcePath: SRC, segments: [[0, 2]], videoTimebase: null, hasThumbnail: false, streams: streamsA, rotation: 0 },
      { sourcePath: SRC2, segments: [[0, 2]], videoTimebase: null, hasThumbnail: false, streams: streamsB, rotation: 0 }
    ],
    outputPath: OUT,
    ffmpeg: FF,
    compress,
    resolution: 'origin',
    quality: 'low',
    gpu: false,
    duration: 4,
    tools
  };
}

(async () => {
  makeVideo(SRC, 2);
  makeVideo(SRC2, 2);
  makeWebm(WSRC, 2);
  makeWebm(WSRC2, 2);
  installFakePlugin();
  registerIpc(() => null, FAKE_APP, path.join(DIR, 'rt'));
  const event = { sender: { isDestroyed: () => true, send: () => {} } };

  console.log('[0] the fake plugin itself');
  const doubled = path.join(DIR, 'doubled.mkv');
  const self = spawnSync(path.join(EXT, 'python', 'python.exe'), [path.join(EXT, 'debreath.py'), SRC, '-l', '60'], { cwd: DIR, windowsHide: true, encoding: 'utf8' });
  check('plugin runs and doubles the input', self.status === 0 && fs.existsSync(doubled) && Math.abs(probeDur(doubled) - 4) < 0.5, 'rc=' + self.status + ' ' + String(self.stderr || '').slice(-200));

  const st1 = await probeStreams(SRC, FF);
  const st2 = await probeStreams(SRC2, FF);

  async function run(tools, compress) {
    fs.rmSync(OUT, { force: true });
    const res = await handlers['export:project'](event, payloadFor(st1, st2, tools, compress));
    if (!res || !res.ok) throw new Error((res && res.error) || 'export failed');
    return probeDur(OUT);
  }

  console.log('[1] control: combine two 2s timelines, compressed');
  const d1 = await run([], true);
  check('control export ~4s', d1 !== null && d1 > 3.4 && d1 < 5, String(d1));

  console.log('[2] plugin doubles the duration, compressed (regression)');
  const d2 = await run(['lossless-debreath'], true);
  check('plugin output is not truncated by the stale duration', d2 !== null && d2 > 7, String(d2) + ' (expected ~8s; truncation would be ~4s)');

  console.log('[3] same plugin, not compressed');
  const d3 = await run(['lossless-debreath'], false);
  check('not compressed keeps the whole plugin output', d3 !== null && d3 > 7, String(d3));

  console.log('[4] webm project + plugin returning mkv/h264, target webm');
  const ws1 = await probeStreams(WSRC, FF);
  const ws2 = await probeStreams(WSRC2, FF);
  fs.rmSync(WOUT, { force: true });
  fs.rmSync(WSAVED, { force: true });
  const wres = await handlers['export:project'](event, {
    timelines: [
      { sourcePath: WSRC, segments: [[0, 2]], videoTimebase: null, hasThumbnail: false, streams: ws1, rotation: 0 },
      { sourcePath: WSRC2, segments: [[0, 2]], videoTimebase: null, hasThumbnail: false, streams: ws2, rotation: 0 }
    ],
    outputPath: WOUT, ffmpeg: FF, compress: false, resolution: 'origin', quality: 'low', gpu: false, duration: 4,
    tools: ['lossless-debreath']
  });
  const wsaved = fs.existsSync(WSAVED) ? await probeStreams(WSAVED, FF) : null;
  check('webm target export succeeds', !!(wres && wres.ok), (wres && wres.error) || 'no result');
  check('saved in the plugin container', !!(wres && wres.out === WSAVED) && fs.existsSync(WSAVED) && !fs.existsSync(WOUT), (wres && wres.out) || 'no out');
  check('video is the plugin codec', !!wsaved && wsaved.some((s) => s.codec_type === 'video' && s.codec_name === 'h264'), wsaved ? JSON.stringify(wsaved.map((s) => s.codec_name)) : 'no file');

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });

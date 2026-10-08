const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { startExport, applyTools } = require('../lib/export');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(os.tmpdir(), 'keycut-export-tools-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

const FAKE = path.join(WORK, 'fake-tool.js');
fs.writeFileSync(FAKE, `
const fs = require('fs');
const path = require('path');
const input = process.argv[2];
if (process.env.FAKE_ORDER) fs.appendFileSync(process.env.FAKE_ORDER, process.env.FAKE_ID + '\\n');
if (process.env.FAKE_ARGS) fs.appendFileSync(process.env.FAKE_ARGS, process.env.FAKE_ID + ' ' + process.argv.slice(2).join(' ') + '\\n');
const out = path.join(process.cwd(), path.basename(input));
fs.copyFileSync(input, out);
console.log('detector   : fake');
console.log('breaths    : 0 region(s), 0.00 s');
console.log('output     : ' + out);
`, 'utf8');

const ORDER = path.join(WORK, 'order.txt');
const ARGS = path.join(WORK, 'args.txt');

function makeTool(id) {
  return {
    id,
    label: id,
    cmd: [process.execPath, FAKE],
    env: Object.assign({}, process.env, { FAKE_ID: id, FAKE_ORDER: ORDER, FAKE_ARGS: ARGS }),
    args: ['-l', '45'],
    outputRe: /^output\s*:\s*(.+?)\s*$/m,
    progressMarks: [[/detector\s*:/, 0.1, 'Detecting'], [/^breaths\s*:/m, 0.5, 'Writing']]
  };
}

function probeDuration(p) {
  const r = spawnSync(FF, ['-hide_banner', '-i', p], { windowsHide: true });
  const e = r.stderr.toString();
  const m = e.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
}

(async () => {
  const src = path.join(WORK, 'src.mp4');
  const g = spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  if (g.status !== 0) { console.error('fixture failed', g.stderr.toString()); process.exit(1); }

  console.log('[1] lossless export runs tool after mux (no compress)');
  const events1 = [];
  const out1 = path.join(WORK, 'out1.mp4');
  await startExport({
    src, segments: [[0, 2]], out: out1, tmpDir: path.join(WORK, 'tmp1'), ffmpeg: FF,
    onProgress: (p) => events1.push(p), streams: null, compress: false, tools: [makeTool('A')]
  });
  check('output produced', fs.existsSync(out1) && fs.statSync(out1).size > 0);
  check('tool phase emitted', events1.some((e) => e.phase === 'tool' && e.id === 'A'));
  check('tool progress marks (0.1, 0.5)', events1.some((e) => e.phase === 'tool' && e.progress === 0.1) && events1.some((e) => e.phase === 'tool' && e.progress === 0.5));
  check('tool progress reaches 1 on completion', events1.some((e) => e.phase === 'tool' && e.progress === 1));
  check('phase detail labels emitted', events1.some((e) => e.phase === 'tool' && e.detail === 'Detecting') && events1.some((e) => e.phase === 'tool' && e.detail === 'Writing'), JSON.stringify(events1.filter((e) => e.phase === 'tool')));
  check('progress marks are not duplicated', events1.filter((e) => e.phase === 'tool' && e.progress === 0.1).length === 1 && events1.filter((e) => e.phase === 'tool' && e.progress === 0.5).length === 1, JSON.stringify(events1.filter((e) => e.phase === 'tool').map((e) => e.progress)));
  check('no encode phase without compress', !events1.some((e) => e.phase === 'encode'));
  const d1 = probeDuration(out1);
  check('output duration ~2s', d1 !== null && Math.abs(d1 - 2) < 0.5, String(d1));
  check('tool received option args (-l 45)', fs.readFileSync(ARGS, 'utf8').includes('-l 45'), fs.readFileSync(ARGS, 'utf8'));

  console.log('[2] tools run in the order given');
  fs.writeFileSync(ORDER, '');
  const out2 = path.join(WORK, 'out2.mp4');
  await startExport({
    src, segments: [[0, 2]], out: out2, tmpDir: path.join(WORK, 'tmp2'), ffmpeg: FF,
    streams: null, compress: false, tools: [makeTool('A'), makeTool('B')]
  });
  check('order A then B', fs.readFileSync(ORDER, 'utf8').trim() === 'A\nB', JSON.stringify(fs.readFileSync(ORDER, 'utf8')));

  console.log('[3] with compress: mux -> tool -> encode');
  const events3 = [];
  const out3 = path.join(WORK, 'out3.mp4');
  await startExport({
    src, segments: [[0, 2]], out: out3, tmpDir: path.join(WORK, 'tmp3'), ffmpeg: FF,
    onProgress: (p) => events3.push(p), streams: null, compress: true, resolution: '720', quality: 'low', gpu: false, duration: 2, tools: [makeTool('A')]
  });
  const iConcat = events3.findIndex((e) => e.phase === 'concat');
  const iTool = events3.findIndex((e) => e.phase === 'tool');
  const iEncode = events3.findIndex((e) => e.phase === 'encode');
  check('output produced', fs.existsSync(out3) && fs.statSync(out3).size > 0);
  check('concat before tool', iConcat >= 0 && iTool > iConcat, JSON.stringify([iConcat, iTool, iEncode]));
  check('tool before encode (compress last)', iEncode > iTool, JSON.stringify([iConcat, iTool, iEncode]));
  const d3 = probeDuration(out3);
  check('compressed output duration ~2s', d3 !== null && Math.abs(d3 - 2) < 0.6, String(d3));

  console.log('[4] applyTools returns final path, keeps original input, cleans intermediates');
  const tmp4 = path.join(WORK, 'tmp4');
  const in4 = path.join(WORK, 'in4.mp4');
  fs.copyFileSync(src, in4);
  const final4 = await applyTools({ tools: [makeTool('A'), makeTool('B')], input: in4, tmpDir: tmp4, ffmpeg: FF });
  check('applyTools output exists', fs.existsSync(final4));
  check('applyTools kept original input', fs.existsSync(in4));
  check('applyTools removed intermediate tool_0 output', !fs.existsSync(path.join(tmp4, 'tool_0', 'in4.mp4')));
  check('applyTools final is tool_1 output', final4 === path.join(tmp4, 'tool_1', 'in4.mp4'), final4);

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

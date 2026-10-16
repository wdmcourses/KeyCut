const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeScratch, cleanupSession, pruneStale, isPidAlive } = require('../lib/tmp');
const { startExport } = require('../lib/export');
const { joinFiles } = require('../lib/concat');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(os.tmpdir(), 'keycut-tmp-test-' + process.pid);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail != null ? detail : ''); }
}

function runFF(args) {
  const r = spawnSync(FF, args, { encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) throw new Error('ffmpeg: ' + (r.error || (r.stderr || '').split('\n').slice(-2).join(' ')));
}

function makeFixture(file) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  runFF(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', '-shortest', file]);
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  console.log('[1] makeScratch: уникальность и создание базы');
  const base = path.join(WORK, 'base');
  const a = makeScratch(base, 'exp-');
  const b = makeScratch(base, 'exp-');
  check('создаёт уникальные каталоги', a !== b && fs.existsSync(a) && fs.existsSync(b));
  check('создаёт вложенную базу', fs.existsSync(base));

  console.log('[2] cleanupSession: удаляет свой, не трогает соседний');
  const root2 = path.join(WORK, 'root2');
  const s1 = path.join(root2, '111');
  const s2 = path.join(root2, '222');
  makeScratch(s1, 'x-');
  makeScratch(s2, 'x-');
  cleanupSession(s1, root2);
  check('свой каталог удалён', !fs.existsSync(s1));
  check('соседний каталог цел', fs.existsSync(s2));
  cleanupSession(s2, root2);
  check('пустой корень удалён', !fs.existsSync(root2));

  console.log('[3] pruneStale: удаляет мёртвые инстансы, живые не трогает');
  const root3 = path.join(WORK, 'root3');
  const own = path.join(root3, String(process.pid));
  const dead = path.join(root3, '2147483647');
  const junk = path.join(root3, 'not-a-pid');
  makeScratch(own, 'a-');
  makeScratch(dead, 'b-');
  makeScratch(junk, 'c-');
  check('isPidAlive(свой pid) = true', isPidAlive(process.pid) === true);
  check('isPidAlive(мёртвый pid) = false', isPidAlive(2147483647) === false);
  pruneStale(root3, process.pid);
  check('каталог своего инстанса цел', fs.existsSync(own));
  check('каталог мёртвого инстанса удалён', !fs.existsSync(dead));
  check('не-pid каталог не тронут', fs.existsSync(junk));

  console.log('[4] изоляция инстансов: очистка одного не задевает другой');
  const iroot = path.join(WORK, 'iroot');
  const inst1 = path.join(iroot, '1');
  const inst2 = path.join(iroot, '2');
  const f1 = path.join(makeScratch(inst1, 'd-'), 'file');
  const f2 = path.join(makeScratch(inst2, 'd-'), 'file');
  fs.writeFileSync(f1, 'a');
  fs.writeFileSync(f2, 'b');
  cleanupSession(inst1, iroot);
  check('артефакт другого инстанса цел', fs.existsSync(f2) && fs.readFileSync(f2, 'utf8') === 'b');
  check('артефакт своего инстанса удалён', !fs.existsSync(f1));

  console.log('[5] параллельные мюксы (экспорт): уникальные скретчи, всё чистится');
  const src = path.join(WORK, 'src.mp4');
  makeFixture(src);
  const obase = path.join(WORK, 'obase');
  const o1 = path.join(WORK, 'o1.mkv');
  const o2 = path.join(WORK, 'o2.mkv');
  const d1 = makeScratch(obase, 'exp-');
  const d2 = makeScratch(obase, 'exp-');
  const [r1, r2] = await Promise.all([
    startExport({ src, segments: [[0, 0.8]], out: o1, tmpDir: d1, ffmpeg: FF, duration: 0.8 }),
    startExport({ src, segments: [[1.0, 1.8]], out: o2, tmpDir: d2, ffmpeg: FF, duration: 0.8 })
  ]);
  check('оба экспорта успешны', !!(r1 && r1.out) && !!(r2 && r2.out) && fs.existsSync(o1) && fs.existsSync(o2));
  check('скретчи экспортов очищены', fs.readdirSync(obase).length === 0, 'leftover=' + JSON.stringify(fs.readdirSync(obase)));

  console.log('[6] параллельные мюксы (склейка): один baseDir, уникальные каталоги');
  const jbase = path.join(WORK, 'jbase');
  const j1 = path.join(WORK, 'j1');
  const j2 = path.join(WORK, 'j2');
  fs.mkdirSync(j1, { recursive: true });
  fs.mkdirSync(j2, { recursive: true });
  fs.copyFileSync(src, path.join(j1, 'a.mp4'));
  fs.copyFileSync(src, path.join(j2, 'a.mp4'));
  const [jr1, jr2] = await Promise.all([
    joinFiles({ files: [path.join(j1, 'a.mp4'), path.join(j1, 'a.mp4')], ffmpeg: FF, totalDuration: 4, baseDir: jbase }),
    joinFiles({ files: [path.join(j2, 'a.mp4'), path.join(j2, 'a.mp4')], ffmpeg: FF, totalDuration: 4, baseDir: jbase })
  ]);
  check('обе склейки успешны', !!(jr1 && jr1.ok) && !!(jr2 && jr2.ok));
  check('скретчи склеек очищены', !fs.existsSync(jbase) || fs.readdirSync(jbase).length === 0, 'leftover=' + JSON.stringify(fs.existsSync(jbase) ? fs.readdirSync(jbase) : []));

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });

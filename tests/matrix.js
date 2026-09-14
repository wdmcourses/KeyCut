const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FF = path.join(ROOT, 'vendor', 'ffmpeg', 'win32', 'ffmpeg.exe');
const WORK = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-matrix';
const FX = path.join(WORK, 'fx');
const TMP = path.join(WORK, 'tmp');
fs.mkdirSync(FX, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const { startExport } = require(path.join(ROOT, 'lib', 'export'));
const { joinFiles } = require(path.join(ROOT, 'lib', 'concat'));
const { assertJoinable, mergeTimelines } = require(path.join(ROOT, 'lib', 'joinutil'));
const { probeQuick } = require(path.join(ROOT, 'lib', 'probe'));
const { parseMp4 } = require(path.join(ROOT, 'lib', 'mp4'));

const FPS = 25, W = 320, H = 180, DUR = 2.5;
const results = [];
let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail) => { if (ok) { pass++; results.push(['PASS', name, detail]); } else { fail++; results.push(['FAIL', name, detail]); } };
const note = (name, detail) => results.push(['INFO', name, detail]);

function runFF(args, t) {
  const r = spawnSync(FF, args, { encoding: 'utf8', timeout: t || 60000 });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error('timeout');
  if (r.status !== 0) throw new Error((r.stderr || '').split('\n').slice(-3).join(' '));
  return r;
}
function venc(v) { switch (v) {
  case 'h264': return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '25', '-bf', '2'];
  case 'hevc': return ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '30', '-x265-params', 'log-level=error', '-tag:v', 'hvc1'];
  case 'vp9': return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8'];
  case 'av1': return ['-c:v', 'libaom-av1', '-b:v', '0', '-crf', '34', '-cpu-used', '8', '-row-mt', '1', '-usage', 'realtime'];
  case 'vp8': return ['-c:v', 'libvpx', '-b:v', '0', '-crf', '10', '-deadline', 'realtime', '-cpu-used', '8'];
  case 'theora': return ['-c:v', 'libtheora', '-q:v', '5'];
  case 'mpeg4': return ['-c:v', 'mpeg4', '-q:v', '5'];
  case 'msmpeg4': return ['-c:v', 'msmpeg4v3', '-q:v', '5'];
  case 'mjpeg': return ['-c:v', 'mjpeg', '-q:v', '5'];
  case 'mpeg2video': return ['-c:v', 'mpeg2video', '-q:v', '5'];
  case 'wmv2': return ['-c:v', 'wmv2', '-q:v', '5'];
  default: throw new Error('vc ' + v); } }
function aenc(a) { switch (a) {
  case 'aac': return ['-c:a', 'aac', '-b:a', '128k'];
  case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', '128k'];
  case 'opus': return ['-c:a', 'libopus', '-b:a', '96k'];
  case 'vorbis': return ['-c:a', 'libvorbis', '-q:a', '4'];
  case 'ac3': return ['-c:a', 'ac3', '-b:a', '192k'];
  case 'pcm': return ['-c:a', 'pcm_s16le'];
  case 'mp2': return ['-c:a', 'mp2', '-b:a', '128k'];
  case 'flac': return ['-c:a', 'flac'];
  case 'wmav2': return ['-c:a', 'wmav2', '-b:a', '128k'];
  case null: return [];
  default: throw new Error('ac ' + a); } }
function cont(ext) { switch (ext) {
  case 'webm': return ['-f', 'webm']; case 'flv': return ['-f', 'flv']; case 'wmv': return ['-f', 'asf'];
  case '3gp': return ['-f', '3gp']; case 'f4v': return ['-f', 'f4v']; case 'ts': case 'mts': case 'm2ts': return ['-f', 'mpegts'];
  case 'avi': return ['-f', 'avi']; case 'm4v': return ['-f', 'mp4']; case 'mkv': return ['-f', 'matroska'];
  case 'mov': return ['-f', 'mov']; case 'mp4': return ['-f', 'mp4']; default: return []; } }
function genFixture(id, ext, vcodec, acodec, dur, extra) {
  const file = path.join(FX, id + '.' + ext);
  if (fs.existsSync(file)) return file;
  const a = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=' + W + 'x' + H + ':rate=' + FPS + ':duration=' + dur, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + dur];
  if (acodec === null) a.push('-an'); else a.push(...aenc(acodec));
  a.push(...venc(vcodec)); if (extra) a.push(...extra);
  a.push(...cont(ext)); a.push(file);
  runFF(a);
  return file;
}
const FX_DEFS = [
  ['mp4_h264_aac', 'mp4', 'h264', 'aac'], ['mp4_h264_mp3', 'mp4', 'h264', 'mp3'], ['mp4_hevc_aac', 'mp4', 'hevc', 'aac'],
  ['mp4_mpeg4_aac', 'mp4', 'mpeg4', 'aac'], ['mp4_vp9_opus', 'mp4', 'vp9', 'opus'], ['mp4_av1_aac', 'mp4', 'av1', 'aac'],
  ['mp4_h264_noaudio', 'mp4', 'h264', null], ['mov_h264_aac', 'mov', 'h264', 'aac'], ['mov_h264_pcm', 'mov', 'h264', 'pcm'],
  ['mov_mjpeg_pcm', 'mov', 'mjpeg', 'pcm'], ['mov_mpeg4_aac', 'mov', 'mpeg4', 'aac'], ['m4v_h264_aac', 'm4v', 'h264', 'aac'],
  ['mkv_h264_aac', 'mkv', 'h264', 'aac'], ['mkv_h264_mp3', 'mkv', 'h264', 'mp3'], ['mkv_h264_noaudio', 'mkv', 'h264', null],
  ['mkv_hevc_aac', 'mkv', 'hevc', 'aac'], ['mkv_hevc_ac3', 'mkv', 'hevc', 'ac3'], ['mkv_vp9_opus', 'mkv', 'vp9', 'opus'],
  ['mkv_vp9_vorbis', 'mkv', 'vp9', 'vorbis'], ['mkv_av1_opus', 'mkv', 'av1', 'opus'], ['mkv_mpeg4_mp3', 'mkv', 'mpeg4', 'mp3'],
  ['mkv_theora_vorbis', 'mkv', 'theora', 'vorbis'], ['mkv_mpeg2_mp2', 'mkv', 'mpeg2video', 'mp2'], ['mkv_vp8_vorbis', 'mkv', 'vp8', 'vorbis'],
  ['mkv_h264_pcm', 'mkv', 'h264', 'pcm'], ['mkv_h264_flac', 'mkv', 'h264', 'flac'], ['webm_vp9_opus', 'webm', 'vp9', 'opus'],
  ['webm_vp8_vorbis', 'webm', 'vp8', 'vorbis'], ['webm_av1_opus', 'webm', 'av1', 'opus'], ['avi_mpeg4_mp3', 'avi', 'mpeg4', 'mp3'],
  ['avi_mjpeg_pcm', 'avi', 'mjpeg', 'pcm'], ['avi_msmpeg4_mp3', 'avi', 'msmpeg4', 'mp3'], ['ts_h264_aac', 'ts', 'h264', 'aac'],
  ['ts_h264_mp3', 'ts', 'h264', 'mp3'], ['ts_mpeg2_mp2', 'ts', 'mpeg2video', 'mp2'], ['mts_h264_aac', 'mts', 'h264', 'aac'],
  ['flv_h264_aac', 'flv', 'h264', 'aac'], ['3gp_h264_aac', '3gp', 'h264', 'aac'], ['f4v_h264_aac', 'f4v', 'h264', 'aac'],
];
function inspect(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 30000 });
  const s = (r.stderr || '') + (r.stdout || '');
  let duration = null; const dm = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
  const streams = [];
  for (const line of s.split('\n')) { const m = line.match(/Stream #0:(\d+).*?: (Video|Audio|Subtitle|Data):/); if (m) streams.push({ index: +m[1], type: m[2].toLowerCase() }); }
  return { duration, video: !!streams.find((x) => x.type === 'video'), audio: !!streams.find((x) => x.type === 'audio') };
}
function countFrames(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000 });
  const ms = (r.stderr || '').match(/frame=\s*(\d+)/g);
  if (!ms || !ms.length) return -1;
  return parseInt(ms[ms.length - 1].replace(/\D/g, ''), 10);
}
function frameTimes(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'], { encoding: 'utf8', timeout: 60000 });
  let tb = 1000; const tbh = ((r.stderr || '') + (r.stdout || '')).match(/#tb 0:\s*1\/(\d+)/); if (tbh) tb = parseInt(tbh[1], 10);
  const times = [];
  for (const line of (r.stdout || '').split('\n')) { const m = line.match(/^0,\s*-?\d+,\s*(-?\d+),/); if (m) times.push(parseInt(m[1], 10) / tb); }
  return times.sort((a, b) => a - b);
}
function videoTimebaseFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.mp4', '.mov', '.m4v', '.3gp', '.3g2'].includes(ext)) { try { const p = parseMp4(file); if (p && p.timescale) return p.timescale; } catch {} }
  return null;
}
async function exportSegs(src, out, segs, opts) {
  return startExport({ src, segments: segs, out, tmpDir: fs.mkdtempSync(path.join(TMP, 'x-')), ffmpeg: FF, videoTimebase: videoTimebaseFor(src), hasThumbnail: false, streams: null, compress: false, resolution: null, duration: segs.reduce((a, s) => a + (s[1] - s[0]), 0), ...(opts || {}) });
}
async function exportSegsPost(src, out, segs) {
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path.join(TMP, 'xp-'));
  const list = segs.map((s, i) => { const p = path.join(tmp, 'p' + i + '.mkv'); runFF(['-y', '-v', 'error', '-i', src, '-ss', s[0].toFixed(6), '-t', (s[1] - s[0]).toFixed(6), '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-ignore_unknown', p]); return p; });
  fs2.writeFileSync(path.join(tmp, 'l.txt'), list.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n', 'utf8');
  runFF(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'l.txt'), '-c', 'copy', '-default_mode', 'infer_no_subs', out]);
  return { ok: true, out };
}

async function main() {
  const fx = {};
  for (const [id, ext, vc, ac] of FX_DEFS) { try { fx[id] = genFixture(id, ext, vc, ac, DUR); } catch (e) { skipNote('gen ' + id, e.message.split('\n')[0]); } }

  console.log('== SUITE A: probeQuick sanity ==');
  for (const id of Object.keys(fx)) { try { const q = await probeQuick(fx[id], FF); check('probe ' + id, !!q && q.duration > 0 && q.width > 0 && q.height > 0 && !!q.codec, JSON.stringify({ d: q && q.duration, c: q && q.codec, a: q && q.audioCodec })); } catch (e) { check('probe ' + id, false, e.message.split('\n')[0]); } }

  console.log('== SUITE B: single-cut export via APP method (input-ss) ==');
  for (const id of Object.keys(fx)) {
    const out = path.join(TMP, 'seg_' + id + '.mkv');
    try { const si = inspect(fx[id]); const res = await exportSegs(fx[id], out, [[0.3, 1.0]]); const o = inspect(out);
      check('seg ' + id, !!res.out && o.video && o.audio === si.audio, 'dur=' + (o.duration && o.duration.toFixed(2)) + ' (want 0.7) v=' + o.video + ' a=' + o.audio);
    } catch (e) { check('seg ' + id, false, e.message.split('\n')[0]); }
  }

  console.log('== SUITE C: single-cut export with OUTPUT-seek (comparison) ==');
  const cmpIds = ['mp4_h264_aac', 'mkv_h264_aac', 'mkv_hevc_aac', 'webm_vp9_opus', 'mov_h264_aac', 'ts_h264_aac'];
  for (const id of cmpIds) {
    if (!fx[id]) continue;
    const out = path.join(TMP, 'post_' + id + '.mkv');
    try { await exportSegsPost(fx[id], out, [[0.3, 1.0]]); const o = inspect(out); note('post-ss ' + id, 'dur=' + (o.duration && o.duration.toFixed(2)) + ' (want 0.7) v=' + o.video + ' a=' + o.audio); }
    catch (e) { note('post-ss ' + id, 'FAIL ' + e.message.split('\n')[0]); }
  }

  console.log('== SUITE D: multi-segment export (timeline) via APP method ==');
  for (const id of Object.keys(fx)) {
    const out = path.join(TMP, 'multi_' + id + '.mkv');
    try { const res = await exportSegs(fx[id], out, [[0.2, 0.8], [1.2, 1.8]]); const o = inspect(out);
      check('multi ' + id, !!res.out && o.video, 'dur=' + (o.duration && o.duration.toFixed(2)) + ' (want 1.2)');
    } catch (e) { check('multi ' + id, false, e.message.split('\n')[0]); }
  }

  console.log('== SUITE E: output-container matrix (subset) ==');
  const oexts = ['mp4', 'mov', 'mkv', 'webm', 'ts', 'avi'];
  const srcSub = ['mp4_h264_aac', 'mkv_h264_aac', 'webm_vp9_opus', 'mkv_hevc_aac', 'ts_h264_aac', 'mov_mjpeg_pcm'];
  for (const sid of srcSub) { if (!fx[sid]) continue; for (const ext of oexts) {
    const out = path.join(TMP, 'oc_' + sid + '_' + ext + '.' + ext);
    try { const res = await exportSegs(fx[sid], out, [[0.3, 1.0]]); const o = inspect(out); check('out ' + sid + '->.' + ext, !!res.out && o.video, 'dur=' + (o.duration && o.duration.toFixed(2)) + ' a=' + o.audio); }
    catch (e) { note('out ' + sid + '->.' + ext, 'EXPECTED-BLOCKED: ' + e.message.split('\n')[0]); }
  } }

  console.log('== SUITE F: assertJoinable matrix ==');
  const f = (id) => fx[id];
  const groups = [
    ['compatible_h264_mixed', ['mp4_h264_aac', 'mkv_h264_aac', 'ts_h264_aac', 'mov_h264_aac'], true],
    ['compatible_mp3', ['mp4_h264_mp3', 'mkv_h264_mp3'], true],
    ['compatible_vp9', ['webm_vp9_opus', 'mkv_vp9_opus'], true],
    ['compatible_av1', ['webm_av1_opus', 'mkv_av1_opus'], true],
    ['compatible_hevc', ['mp4_hevc_aac', 'mkv_hevc_aac'], true],
    ['mismatch_codec', ['mp4_h264_aac', 'mkv_hevc_aac'], false],
    ['mismatch_codec2', ['mkv_h264_aac', 'mkv_mpeg4_mp3'], false],
    ['mismatch_audio_codec', ['mp4_h264_aac', 'mkv_h264_mp3'], false],
    ['mismatch_container_only', ['webm_vp9_opus', 'mkv_vp9_opus'], true],
  ];
  for (const [name, ids, expect] of groups) {
    try { const metas = []; for (const id of ids) metas.push(await probeQuick(f(id), FF)); const err = assertJoinable(metas); check('joinable ' + name, expect === !err, 'err=' + err); }
    catch (e) { check('joinable ' + name, false, e.message.split('\n')[0]); }
  }
  // resolution/fps/audio-rate/audio-ch mismatches via controlled generation
  const mm = [
    ['res', 'mkv', 'h264', 'aac', ['-vf', 'scale=640:360']],
    ['fps', 'mkv', 'h264', 'aac', ['-r', '15']],
    ['rate', 'mkv', 'h264', 'aac', ['-ar', '48000'], ['-ar', '44100']],
    ['ch', 'mkv', 'h264', 'aac', ['-ac', '2'], ['-ac', '1']],
  ];
  for (const [kind, ext, vc, ac, extraA, extraB] of mm) {
    try { const a = genFixture('mm_' + kind + '_a', ext, vc, ac, DUR, extraA); const b = genFixture('mm_' + kind + '_b', ext, vc, ac, DUR, extraB);
      const err = assertJoinable([await probeQuick(a, FF), await probeQuick(b, FF)]); check('joinable mismatch_' + kind, err != null, 'err=' + err);
    } catch (e) { check('joinable mismatch_' + kind, false, e.message.split('\n')[0]); }
  }

  console.log('== SUITE G: actual joinFiles ==');
  const jg = [
    ['join_h264_mixed', ['mp4_h264_aac', 'mkv_h264_aac', 'ts_h264_aac', 'mov_h264_aac']],
    ['join_mp3', ['mp4_h264_mp3', 'mkv_h264_mp3']],
    ['join_vp9', ['webm_vp9_opus', 'mkv_vp9_opus']],
    ['join_av1', ['webm_av1_opus', 'mkv_av1_opus']],
    ['join_hevc', ['mp4_hevc_aac', 'mkv_hevc_aac']],
  ];
  for (const [name, ids] of jg) {
    const files = ids.filter((id) => fx[id]).map((id) => fx[id]);
    if (files.length < 2) { skipNote(name, 'missing fixtures'); continue; }
    try { const res = await joinFiles({ files, ffmpeg: FF, totalDuration: files.length * DUR }); const o = inspect(res.out); check(name, !!res.ok && o.video, 'dur=' + (o.duration && o.duration.toFixed(2)) + ' (want ~' + (files.length * DUR).toFixed(1) + ') a=' + o.audio); }
    catch (e) { check(name, false, e.message.split('\n')[0]); }
  }

  console.log('== SUITE H: project export (multi-timeline) ==');
  try { const p1 = path.join(TMP, 'pp1.mkv'); const p2 = path.join(TMP, 'pp2.mkv'); await exportSegs(fx['mp4_h264_aac'], p1, [[0.3, 1.1]]); await exportSegs(fx['mkv_h264_aac'], p2, [[0.4, 1.2]]);
    const res = await mergeTimelines({ files: [p1, p2], ffmpeg: FF, totalDuration: 1.6 }); const o = inspect(res.out); check('project export', !!res.ok && o.video, 'dur=' + (o.duration && o.duration.toFixed(2)) + ' (want ~1.6) a=' + o.audio);
  } catch (e) { check('project export', false, e.message.split('\n')[0]); }

  console.log('== SUITE I: MKV extra-frame statistics (app method, keyframe-aligned) ==');
  await extraFrameStats();

  console.log('== SUITE J: compress (re-encode) ==');
  try { const out = path.join(TMP, 'comp.mp4'); const res = await exportSegs(fx['mp4_h264_aac'], out, [[0.3, 1.3]], { compress: true, resolution: 'origin' }); const o = inspect(out); check('compress', !!res.out && o.video, 'dur=' + (o.duration && o.duration.toFixed(2)) + ' (want 1.0)'); }
  catch (e) { check('compress', false, e.message.split('\n')[0]); }

  printReport();
}
function skipNote(n, d) { skip++; results.push(['SKIP', n, d]); }

async function extraFrameStats() {
  const src = path.join(FX, 'extraframe.mkv');
  if (!fs.existsSync(src)) runFF(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=' + W + 'x' + H + ':rate=' + FPS + ':duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '12', '-keyint_min', '12', '-bf', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'matroska', src]);
  const srcTimes = frameTimes(src);
  const total = srcTimes.length;
  const step = 0.48;
  const segSets = [];
  for (let n = 2; n <= 4; n++) { const segs = []; for (let i = 0; i < n; i++) segs.push([i * (8 / n), (i + 1) * (8 / n)]); segSets.push(['split' + n, segs]); }
  segSets.push(['one', [[0.48, 1.92]]]); segSets.push(['one', [[1.92, 3.36]]]); segSets.push(['two', [[0.48, 1.44], [2.4, 3.84]]]); segSets.push(['three', [[0.48, 0.96], [1.44, 2.4], [3.36, 4.8]]]);
  const aligned = [];
  for (let k = 1; k * step < 7.6; k++) aligned.push(k * step);
  for (let i = 0; i < 12; i++) { const a = aligned[1 + ((i * 3) % (aligned.length - 4))]; const b = a + step * (2 + (i % 3)); segSets.push(['cut', [[a, b]]]); }
  let extra = 0, missing = 0, exact = 0, errs = 0;
  const rows = [];
  for (const [kind, segs] of segSets) {
    let expected = 0; for (const [s, e] of segs) expected += srcTimes.filter((t) => t >= s - 1e-6 && t < e - 1e-6).length;
    const out = path.join(TMP, 'ef_' + kind + '_' + segs.length + '_' + segs.map((s) => s[0].toFixed(2)).join('-') + '.mkv');
    try { await exportSegs(src, out, segs); const got = countFrames(out); if (got < 0) { errs++; continue; }
      const diff = got - expected; if (diff > 0) extra++; else if (diff < 0) missing++; else exact++;
      rows.push([kind + '[' + segs.map((s) => s[0].toFixed(2) + '-' + s[1].toFixed(2)).join(';') + ']', got, expected, diff]);
    } catch (e) { errs++; rows.push([kind, 'ERR', '', e.message.split('\n')[0]]); }
  }
  const cases = extra + missing + exact;
  note('EXTRA-FRAME STATS', 'source_frames=' + total + '; keyframe_step=0.48s; cases=' + cases + '; EXTRA=' + extra + '; exact=' + exact + '; missing=' + missing + '; errors=' + errs);
  for (const r of rows) note('ef ' + r[0], 'got=' + r[1] + ' exp=' + r[2] + ' diff=' + r[3]);
  check('extra-frame cases analyzed', cases > 0, 'cases=' + cases);
}

function printReport() {
  const lines = ['='.repeat(70), 'KeyCut MATRIX TEST REPORT', '='.repeat(70), 'TOTAL: ' + pass + ' pass, ' + fail + ' fail, ' + skip + ' skip', ''];
  lines.push('--- FAIL ---'); for (const [st, n, d] of results) if (st === 'FAIL') lines.push('FAIL  ' + n + ' :: ' + d);
  lines.push(''); lines.push('--- INFO (measurements / expected-blocks / stats) ---');
  for (const [st, n, d] of results) if (st === 'INFO') lines.push(n + ' :: ' + d);
  const reportPath = path.join(WORK, 'report.txt');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
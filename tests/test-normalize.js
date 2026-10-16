const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startExport, normalizeToTarget } = require('../lib/export');
const { probeVideo, probeStreams } = require('../lib/probe');

const ROOT = path.join(__dirname, '..');
const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(process.env.KEYCUT_TMP || os.tmpdir(), 'keycut-normalize');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d == null ? '' : d); } };

function run(args, allowFail) {
  const r = spawnSync(FF, args, { windowsHide: true, maxBuffer: 1e8 });
  if (r.status !== 0 && !allowFail) throw new Error('ffmpeg: ' + (r.stderr || '').toString().slice(-500));
  return r;
}

function containerOf(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8' });
  const m = ((r.stderr || '') + (r.stdout || '')).match(/Input #0,\s*(.+?),\s*from/);
  return m ? m[1] : null;
}

async function streamsOf(file) {
  const s = (await probeStreams(file, FF)) || [];
  return s.map((x) => x.codec_type + ':' + x.codec_name + (x.disposition.includes('default') ? ':default' : ''));
}

function pluginTool(outFile, container) {
  return {
    id: 'plugin',
    label: 'plugin',
    cmd: [FF, '-y', '-v', 'info', '-i'],
    args: ['-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-an', '-f', container, outFile],
    outputRe: /^Output #\d+,\s*[a-z0-9]+,\s*to\s*'(.+?)':/m,
    progressMarks: []
  };
}

(async () => {
  const av = path.join(WORK, 'av.mp4');
  run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2',
    '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-f', 'lavfi', '-i', 'sine=f=880:d=2',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', av]);
  fs.writeFileSync(path.join(WORK, 's.srt'), '1\n00:00:00,200 --> 00:00:01,200\nhi\n\n');
  const srt = path.join(WORK, 's.srt');
  const srcMp4 = path.join(WORK, 'src.mp4');
  run(['-v', 'error', '-y', '-i', av, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', '-disposition:a:1', '0', srcMp4]);
  const srcMkv = path.join(WORK, 'src.mkv');
  run(['-v', 'error', '-y', '-i', av, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', srcMkv]);
  const opusMkv = path.join(WORK, 'opus.mkv');
  run(['-v', 'error', '-y', '-i', av, '-map', '0:v', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '64k', '-strict', '-2', '-shortest', opusMkv]);
  const silentMp4 = path.join(WORK, 'silent.mp4');
  run(['-v', 'error', '-y', '-i', av, '-map', '0:v', '-c', 'copy', '-an', silentMp4]);
  const meta = await probeVideo(srcMp4, FF);

  console.log('[1] normalize: mp4 with mov_text -> mkv keeps tracks and flags');
  const finalMkv = path.join(WORK, 'final.mkv');
  const r1 = await normalizeToTarget({ ffmpeg: FF, input: srcMp4, out: finalMkv });
  check('normalize returned the output path', r1 === finalMkv && fs.existsSync(finalMkv), String(r1));
  const t1 = await streamsOf(finalMkv);
  check('container is matroska', String(containerOf(finalMkv)).startsWith('matroska'), containerOf(finalMkv));
  check('video kept', t1.some((t) => t.startsWith('video:')), t1.join(' | '));
  check('both audio tracks kept', t1.filter((t) => t.startsWith('audio:')).length === 2, t1.join(' | '));
  check('subtitle converted mov_text -> subrip', t1.some((t) => t.startsWith('subtitle:subrip')), t1.join(' | '));
  const a1 = t1.filter((t) => t.startsWith('audio:'));
  check('default disposition kept', a1[0].includes(':default') && !a1[1].includes(':default'), t1.join(' | '));

  console.log('[2] baseline: the old blind copy on the same pair');
  const rOld = run(['-y', '-v', 'error', '-i', srcMp4, '-c', 'copy', path.join(WORK, 'old.mkv')], true);
  check('old path really fails', rOld.status !== 0, 'rc=' + rOld.status);

  console.log('[3] no-op when nothing has to change');
  const noop = await normalizeToTarget({ ffmpeg: FF, input: finalMkv, out: path.join(WORK, 'same.mkv') });
  check('returns null on mkv -> mkv copy-only', noop === null && !fs.existsSync(path.join(WORK, 'same.mkv')), String(noop));

  console.log('[4] unknown target extension is left alone');
  const unknown = await normalizeToTarget({ ffmpeg: FF, input: srcMp4, out: path.join(WORK, 'x.foo') });
  check('returns null for unknown extension', unknown === null, String(unknown));

  console.log('[5] mkv with opus -> mp4 (needs -strict -2)');
  const opusMp4 = path.join(WORK, 'opus.mp4');
  await normalizeToTarget({ ffmpeg: FF, input: opusMkv, out: opusMp4 });
  const t5 = await streamsOf(opusMp4);
  check('container is mp4', /^mov,mp4/.test(String(containerOf(opusMp4))), containerOf(opusMp4));
  check('opus audio survived', t5.some((t) => t.startsWith('audio:opus')), t5.join(' | '));

  console.log('[6] avoidNegativeTs option');
  const negOut = path.join(WORK, 'neg.mkv');
  await normalizeToTarget({ ffmpeg: FF, input: srcMp4, out: negOut, avoidNegativeTs: 'make_zero' });
  check('written with make_zero', fs.existsSync(negOut) && String(containerOf(negOut)).startsWith('matroska'), containerOf(negOut));

  console.log('[7] video only source');
  const silentMkv = path.join(WORK, 'silent.mkv');
  await normalizeToTarget({ ffmpeg: FF, input: silentMp4, out: silentMkv });
  const t7 = await streamsOf(silentMkv);
  check('no audio invented', !t7.some((t) => t.startsWith('audio:')), t7.join(' | '));
  check('video kept', t7.some((t) => t.startsWith('video:')), t7.join(' | '));

  console.log('[8] startExport: plugin returns .mp4 while target is .mkv');
  const tmp8 = path.join(WORK, 't8');
  const out8 = path.join(WORK, 'out8.mkv');
  await startExport({
    src: srcMp4, segments: [[0.2, 1.6]], out: out8, tmpDir: tmp8, ffmpeg: FF,
    videoTimebase: meta.videoTimebase, hasThumbnail: meta.hasThumbnail, streams: meta.streams,
    compress: false, duration: 1.4, tools: [pluginTool(path.join(WORK, 'plug8.mp4'), 'mp4')]
  });
  const t8 = await streamsOf(out8);
  check('export produced matroska', String(containerOf(out8)).startsWith('matroska'), containerOf(out8));
  check('plugin output really used (no audio, video re-encoded)', !t8.some((t) => t.startsWith('audio:')) && t8.some((t) => t.startsWith('video:h264')), t8.join(' | '));
  check('temp dir cleaned', !fs.existsSync(tmp8));

  console.log('[9] startExport: plugin returns .mkv while target is .mp4');
  const tmp9 = path.join(WORK, 't9');
  const out9 = path.join(WORK, 'out9.mp4');
  await startExport({
    src: srcMp4, segments: [[0.2, 1.6]], out: out9, tmpDir: tmp9, ffmpeg: FF,
    videoTimebase: meta.videoTimebase, hasThumbnail: meta.hasThumbnail, streams: meta.streams,
    compress: false, duration: 1.4, tools: [pluginTool(path.join(WORK, 'plug9.mkv'), 'matroska')]
  });
  const t9 = await streamsOf(out9);
  check('export produced mp4', /^mov,mp4/.test(String(containerOf(out9))), containerOf(out9));
  check('video present', t9.some((t) => t.startsWith('video:')), t9.join(' | '));

  console.log('[10] startExport: plugin output matches the target container');
  const tmp10 = path.join(WORK, 't10');
  const out10 = path.join(WORK, 'out10.mkv');
  await startExport({
    src: srcMp4, segments: [[0.2, 1.6]], out: out10, tmpDir: tmp10, ffmpeg: FF,
    videoTimebase: meta.videoTimebase, hasThumbnail: meta.hasThumbnail, streams: meta.streams,
    compress: false, duration: 1.4, tools: [pluginTool(path.join(WORK, 'plug10.mkv'), 'matroska')]
  });
  check('fast path still works (matroska)', String(containerOf(out10)).startsWith('matroska'), containerOf(out10));
  check('output non-empty', fs.statSync(out10).size > 0);

  console.log('[11] startExport without tools is untouched');
  const tmp11 = path.join(WORK, 't11');
  const out11 = path.join(WORK, 'out11.mkv');
  await startExport({
    src: srcMkv, segments: [[0.2, 1.6]], out: out11, tmpDir: tmp11, ffmpeg: FF,
    videoTimebase: meta.videoTimebase, hasThumbnail: meta.hasThumbnail, streams: null,
    compress: false, duration: 1.4
  });
  const t11 = await streamsOf(out11);
  check('export produced matroska', String(containerOf(out11)).startsWith('matroska'), containerOf(out11));
  check('video and audio kept', t11.some((t) => t.startsWith('video:')) && t11.some((t) => t.startsWith('audio:')), t11.join(' | '));

  console.log('[12] bitmap subtitle (PGS) is dropped for an mp4 target');
  const tmp12 = path.join(WORK, 't12');
  const out12 = path.join(WORK, 'out12.mp4');
  const pgsStreams = [...(meta.streams || []), { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', disposition: ['default'] }];
  let err12 = null;
  try {
    await startExport({
      src: srcMp4, segments: [[0.2, 1.6]], out: out12, tmpDir: tmp12, ffmpeg: FF,
      videoTimebase: meta.videoTimebase, hasThumbnail: meta.hasThumbnail, streams: pgsStreams,
      compress: false, duration: 1.4
    });
  } catch (e) { err12 = e.message; }
  check('export with a bitmap subtitle entry succeeds', !err12 && fs.existsSync(out12), err12 ? err12.slice(0, 200) : 'no output');
  const t12 = await streamsOf(out12);
  check('only the text subtitle survives', t12.filter((t) => t.startsWith('subtitle:')).every((t) => t.startsWith('subtitle:mov_text')) && t12.filter((t) => t.startsWith('subtitle:')).length === 1, t12.join(' | '));

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

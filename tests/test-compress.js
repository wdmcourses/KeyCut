const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require(path.join(ROOT, 'lib/ipc'));
const { compressArgs, scaleArgs, NVENC_PHASES, X264_PHASES, AMF_PHASES, QSV_PHASES, resolveEncoder } = require(path.join(ROOT, 'lib/export'));

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-compress-test';
const SRC = path.join(DIR, 'src.mp4');
const OUT_NVENC = path.join(DIR, 'out_nvenc.mp4');
const OUT_X264 = path.join(DIR, 'out_x264.mp4');
const TMP = path.join(DIR, 'rt_tmp');

function makeFixture() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(SRC)) {
    const ff = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', 'win32', 'ffmpeg.exe');
    const res = spawnSync(ff, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', SRC
    ]);
    if (res.status !== 0) {
      console.error('Fixture generation failed:', res.stderr.toString());
      process.exit(1);
    }
  }
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra != null ? JSON.stringify(extra) : ''); }
};

const ff = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', 'win32', 'ffmpeg.exe');

function run(args) {
  const res = spawnSync(ff, args, { encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout || '') + (res.stderr || '') };
}

app.whenReady().then(async () => {
  makeFixture();
  const errors = [];
  let win;
  registerIpc(() => win, ROOT, TMP);
  ipcMain.handle('get-open-file', () => null);
  win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true }
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push('console: ' + message); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => win.webContents.executeJavaScript(c);

  console.log('[1] scaleArgs (bilinear conventions)');
  const sOrigin = scaleArgs('origin');
  check('origin uses iw:ceil(ih/4)*4', JSON.stringify(sOrigin) === JSON.stringify(['-vf', 'scale=iw:ceil(ih/4)*4:flags=bilinear']), sOrigin);
  const s720 = scaleArgs('720');
  check('720p -> width 1280', s720[1] === 'scale=1280:-2:flags=bilinear', s720);
  const s1080 = scaleArgs('1080');
  check('1080p -> width 1920', s1080[1] === 'scale=1920:-2:flags=bilinear', s1080);
  const s1440 = scaleArgs('1440');
  check('1440p -> width 2560', s1440[1] === 'scale=2560:-2:flags=bilinear', s1440);
  const s2160 = scaleArgs('2160');
  check('2160p -> width 3840', s2160[1] === 'scale=3840:-2:flags=bilinear', s2160);

  console.log('[2] NVENC phases');
  check('low = cq24', JSON.stringify(NVENC_PHASES.low) === JSON.stringify(['-rc', 'vbr_hq', '-cq', '24', '-qmin', '2', '-qmax', '41']), NVENC_PHASES.low);
  check('mid = cq22', JSON.stringify(NVENC_PHASES.mid) === JSON.stringify(['-rc', 'vbr_hq', '-cq', '22', '-qmin', '2', '-qmax', '30']), NVENC_PHASES.mid);
  check('high = cq15', JSON.stringify(NVENC_PHASES.high) === JSON.stringify(['-rc', 'vbr_hq', '-cq', '15', '-qmin', '2', '-qmax', '15']), NVENC_PHASES.high);

  console.log('[3] x264 phases');
  check('low = crf28', JSON.stringify(X264_PHASES.low) === JSON.stringify(['-crf', '28', '-qmin', '10', '-qmax', '41']), X264_PHASES.low);
  check('mid = crf22', JSON.stringify(X264_PHASES.mid) === JSON.stringify(['-crf', '22', '-qmin', '5', '-qmax', '30']), X264_PHASES.mid);
  check('high = crf16', JSON.stringify(X264_PHASES.high) === JSON.stringify(['-crf', '16', '-qmin', '5', '-qmax', '20']), X264_PHASES.high);

  console.log('[3b] AMF phases');
  check('low = qp30', JSON.stringify(AMF_PHASES.low) === JSON.stringify(['-rc', 'cqp', '-qp_i', '30', '-qp_p', '30', '-qp_b', '30']), AMF_PHASES.low);
  check('mid = qp25', JSON.stringify(AMF_PHASES.mid) === JSON.stringify(['-rc', 'cqp', '-qp_i', '25', '-qp_p', '25', '-qp_b', '25']), AMF_PHASES.mid);
  check('high = qp20', JSON.stringify(AMF_PHASES.high) === JSON.stringify(['-rc', 'cqp', '-qp_i', '20', '-qp_p', '20', '-qp_b', '20']), AMF_PHASES.high);

  console.log('[3c] QSV phases');
  check('low = global_quality 30', JSON.stringify(QSV_PHASES.low) === JSON.stringify(['-look_ahead', '0', '-global_quality', '30']), QSV_PHASES.low);
  check('mid = global_quality 25', JSON.stringify(QSV_PHASES.mid) === JSON.stringify(['-look_ahead', '0', '-global_quality', '25']), QSV_PHASES.mid);
  check('high = global_quality 20', JSON.stringify(QSV_PHASES.high) === JSON.stringify(['-look_ahead', '0', '-global_quality', '20']), QSV_PHASES.high);

  console.log('[3d] resolveEncoder probes real hardware');
  const enc = await resolveEncoder(ff);
  const allEncoders = run(['-hide_banner', '-encoders']).out;
  check('resolved encoder is one of nvenc/amf/qsv/x264', ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'].includes(enc), enc);
  if (enc !== 'libx264') {
    check('resolved encoder is compiled into ffmpeg', allEncoders.includes(enc), { enc });
    const probeRun = run(['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=1:d=0.1', '-frames:v', '1', '-c:v', enc, '-f', 'null', '-']);
    check('resolved encoder actually encodes on this machine', probeRun.ok, probeRun.out.slice(-200));
  } else {
    const anyGpu = ['h264_nvenc', 'h264_amf', 'h264_qsv'].filter((e) => allEncoders.includes(e));
    if (anyGpu.length) {
      const gpuProbe = run(['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=1:d=0.1', '-frames:v', '1', '-c:v', anyGpu[0], '-f', 'null', '-']);
      check('fallback to x264 only because GPU encoders failed probe', !gpuProbe.ok, gpuProbe.out.slice(-200));
    } else {
      check('fallback to x264 because no GPU encoders compiled', true);
    }
  }

  console.log('[4] compressArgs assembly');
  const caLow = await compressArgs({ ffmpeg: ff, resolution: '1080', quality: 'low' });
  check('has scale vf', caLow.some((a) => a === '-vf') && caLow.some((a) => a === 'scale=1920:-2:flags=bilinear'), caLow);
  check('has audio 320k/48k/stereo', caLow.includes('-c:a') && caLow.includes('aac') && caLow.includes('-b:a') && caLow.includes('320k') && caLow.includes('-ar') && caLow.includes('48000') && caLow.includes('-ac') && caLow.includes('2'), caLow);
  check('chooses nvenc or x264', caLow.includes('h264_nvenc') || caLow.includes('libx264'), caLow);
  const caMid = await compressArgs({ ffmpeg: ff, resolution: 'origin', quality: 'mid' });
  check('mid carries cq22 or crf22', caMid.includes('-cq') ? caMid.includes('22') : caMid.includes('-crf') && caMid.includes('22'), caMid);
  const caBad = await compressArgs({ ffmpeg: ff, resolution: 'origin', quality: 'bogus' });
  check('unknown quality falls back to low (cq24/crf28)', caBad.includes('24') || caBad.includes('28'), caBad);

  console.log('[4b] gpu toggle forces CPU');
  const caGpuOff = await compressArgs({ ffmpeg: ff, resolution: '720', quality: 'low', gpu: false });
  check('gpu:false forces libx264', caGpuOff.includes('libx264') && !['h264_nvenc', 'h264_amf', 'h264_qsv'].some((c) => caGpuOff.includes(c)), caGpuOff);
  check('gpu:false keeps crf28 low phase', caGpuOff.includes('-crf') && caGpuOff.includes('28'), caGpuOff);
  check('gpu:false keeps scale vf', caGpuOff.some((a) => a === 'scale=1280:-2:flags=bilinear'), caGpuOff);
  const caGpuDefault = await compressArgs({ ffmpeg: ff, resolution: '720', quality: 'low' });
  const caGpuOn = await compressArgs({ ffmpeg: ff, resolution: '720', quality: 'low', gpu: true });
  check('gpu default/true uses resolved encoder', caGpuDefault.includes('h264_nvenc') || caGpuDefault.includes('libx264'), caGpuDefault);
  check('gpu:true matches gpu default', JSON.stringify(caGpuOn) === JSON.stringify(caGpuDefault), caGpuOn);

  console.log('[5] real NVENC/CPU encode through compressArgs');
  const srcArg = SRC.replace(/\\/g, '/');
  const cargs = await compressArgs({ ffmpeg: ff, resolution: 'origin', quality: 'low' });
  const resN = run(['-y', '-v', 'error', '-i', srcArg, '-map', '0:v:0', '-map', '0:a?', ...cargs, '-movflags', '+faststart', OUT_NVENC]);
  check('nvenc/cpu encode ok', resN.ok, resN.out.slice(-200));
  if (resN.ok) {
    const probe = run(['-hide_banner', '-i', OUT_NVENC]);
    check('output has h264 video', /Video: h264/.test(probe.out), probe.out.match(/Video: [^\n]*/)?.[0]);
    check('output has aac audio', /Audio: aac/.test(probe.out), probe.out.match(/Audio: [^\n]*/)?.[0]);
  }

  console.log('[6] startExport compress path via IPC');
  await js(`window.__app.handleDroppedFile('${SRC.replace(/\\/g, '\\\\')}')`);
  await new Promise((r) => setTimeout(r, 1200));
  const resIpc = await js(`window.keycut.exportStart({sourcePath:'${SRC.replace(/\\/g, '\\\\')}', segments:[[0,2]], outputPath:'${OUT_X264.replace(/\\/g, '\\\\')}', compress:true, resolution:'origin', quality:'low'})`);
  check('ipc compress export ok', !!(resIpc && resIpc.ok), resIpc);
  if (resIpc && resIpc.ok && fs.existsSync(OUT_X264)) {
    const probe = run(['-hide_banner', '-i', OUT_X264]);
    check('ipc output has video', /Video: h264/.test(probe.out), probe.out.match(/Video: [^\n]*/)?.[0]);
  }

  console.log('[7] UI: quality buttons in export settings');
  await js(`window.__app.state.exportSettings.compress = true; window.__app.export();`);
  await new Promise((r) => setTimeout(r, 200));
  const ui = await js(`(() => {
    const row = document.getElementById('export-quality-row');
    const opts = [...document.querySelectorAll('.quality-opt')].map((b) => ({ q: b.dataset.quality, on: b.classList.contains('btn--primary') }));
    return { hidden: row.classList.contains('hidden'), opts };
  })()`);
  check('quality row visible when compress on', ui.hidden === false);
  check('low is default active', ui.opts.length === 3 && ui.opts[0].q === 'low' && ui.opts[0].on, ui.opts);
  await js(`document.querySelector('[data-quality="high"]').click()`);
  const after = await js(`({ q: window.__app.state.exportSettings.quality, highOn: document.querySelector('[data-quality="high"]').classList.contains('btn--primary'), lowOn: document.querySelector('[data-quality="low"]').classList.contains('btn--primary') })`);
  check('click high sets quality high', after.q === 'high' && after.highOn && !after.lowOn, after);
  await js(`document.querySelector('[data-quality="mid"]').click()`);
  const after2 = await js(`({ q: window.__app.state.exportSettings.quality, midOn: document.querySelector('[data-quality="mid"]').classList.contains('btn--primary') })`);
  check('click mid sets quality mid', after2.q === 'mid' && after2.midOn, after2);
  await js(`window.__app.state.exportSettings.compress = true; window.__app.toggleExportCompress();`);
  const uiOff = await js(`({ hidden: document.getElementById('export-quality-row').classList.contains('hidden'), compress: window.__app.state.exportSettings.compress })`);
  check('quality row hidden when compress off', uiOff.hidden === true && uiOff.compress === false, uiOff);

  console.log('[7b] UI: gpu toggle in export settings');
  await js(`window.__app.state.exportSettings.compress = true; window.__app.state.exportSettings.gpu = true; window.__app.export();`);
  await new Promise((r) => setTimeout(r, 200));
  const gpuOn = await js(`(() => {
    const row = document.getElementById('export-gpu-row');
    const sw = document.getElementById('export-gpu-toggle');
    return { display: row.style.display, checked: sw.checked, gpu: window.__app.state.exportSettings.gpu };
  })()`);
  check('gpu row visible when compress on', gpuOn.display !== 'none' && gpuOn.checked, gpuOn);
  await js(`document.getElementById('export-gpu-toggle').click()`);
  const gpuOff = await js(`({ gpu: window.__app.state.exportSettings.gpu, checked: document.getElementById('export-gpu-toggle').checked })`);
  check('toggle off sets gpu false', gpuOff.gpu === false && gpuOff.checked === false, gpuOff);
  await js(`window.__app.state.exportSettings.compress = true; window.__app.toggleExportCompress();`);
  const gpuHidden = await js(`({ display: document.getElementById('export-gpu-row').style.display })`);
  check('gpu row hidden when compress off', gpuHidden.display === 'none', gpuHidden);

  console.log('[8] 4.2.2 compat: no default_mode / fps_mode / display_rotation');
  const srcTxt = fs.readFileSync(path.join(ROOT, 'lib', 'export.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'lib', 'ipc.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'lib', 'concat.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'lib', 'compatPlayer.js'), 'utf8');
  check('no default_mode flag', !/default_mode/.test(srcTxt));
  check('no fps_mode flag', !/fps_mode/.test(srcTxt));
  check('no force_divisible_by flag', !/force_divisible_by/.test(srcTxt));
  check('compat uses vsync passthrough', /vsync/.test(fs.readFileSync(path.join(ROOT, 'lib', 'compatPlayer.js'), 'utf8')));

  win.destroy();
  console.log('\nCONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  console.log('RESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
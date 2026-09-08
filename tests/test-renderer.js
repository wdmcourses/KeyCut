const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { registerIpc } = require('../lib/ipc');

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-test';
const SRC = path.join(DIR, 'test.mp4');
const PROJ = path.join(DIR, 'rt.kc');
const OUT = path.join(DIR, 'rt_out.mp4');
const TMP = path.join(DIR, 'rt_tmp');


function makeFixture() {
  if (!fs.existsSync(SRC)) {
    fs.mkdirSync(DIR, { recursive: true });
    const ff = process.env.KEYCUT_FFMPEG || 'ffmpeg';
    const res = spawnSync(ff, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-g', '15', '-keyint_min', '15',
      '-c:a', 'aac', '-shortest', SRC
    ]);
    if (res.status !== 0) {
      console.error('Fixture generation failed:', res.stderr.toString());
      process.exit(1);
    }
  }
}

const errors = [];
let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
};

app.whenReady().then(async () => {
  makeFixture();
  registerIpc(() => win, ROOT, TMP);
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push('console: ' + message);
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 800));

  const js = (code) => win.webContents.executeJavaScript(code);

  
  console.log('[1] load source through IPC probe');
  const src = SRC.replace(/\\/g, '\\\\');
  await js(`window.__app.loadSource('${src}')`);
  await new Promise((r) => setTimeout(r, 1200));
  const st = await js(`({d: window.__app.state.duration, k: window.__app.state.keyTimes.length, src: !!window.__app.state.source})`);
  check('duration ~10s', Math.abs(st.d - 10) < 0.1);
  check('>= 15 keyframes', st.k >= 15);
  check('source set', st.src);
  const DUR = st.d;

  
  console.log('[2] cuts and dims');
  const r2 = await js(`(() => {
    const keys = window.__app.state.keyTimes;
    window.__app.seekTo(keys[6]); window.__app.cut();
    window.__app.seekTo(keys[8]); window.__app.cut();
    window.__app.seekTo(keys[10]); window.__app.cut();
    window.__app.seekTo(keys[7]); window.__app.deleteSegment();
    window.__app.seekTo(keys[9]); window.__app.deleteSegment();
    const m = window.__app.model;
    const DUR = m.duration;
    const expCuts = [0, keys[6], keys[8], keys[10], DUR];
    const okCuts = m.cuts.length === 5 && m.cuts.every((v, i) => Math.abs(v - expCuts[i]) < 1e-6);
    const okDel = JSON.stringify(m.deleted) === JSON.stringify([false, true, true, false]);
    const runs = m.keptRuns();
    const okRuns = runs.length === 2
      && Math.abs(runs[0][1] - keys[6]) < 1e-6
      && Math.abs(runs[1][0] - keys[10]) < 1e-6 && Math.abs(runs[1][1] - DUR) < 1e-6;
    return { okCuts, okDel, okRuns, kept: m.stats().kept };
  })()`);
  check('cuts at keyframes', r2.okCuts);
  check('deleted [false,true,true,false]', r2.okDel);
  check('keptRuns [[0,k6],[k10,end]]', r2.okRuns);

  
  console.log('[3] keyframe navigation');
  await js(`window.__app.seekTo(4.7); window.__app.nextKeyframe();`);
  const c1 = await js(`window.__app.state.cursor`);
  const akArr = await js(`window.__app.state.activeKeys`);
  const expNext = akArr.find((k) => k > c1 - 1e-6);
  check('next keyframe matches active key list', Math.abs(c1 - expNext) < 1e-6);
  await js(`window.__app.prevKeyframe();`);
  const c2 = await js(`window.__app.state.cursor`);
  const expPrev = [...akArr].reverse().find((k) => k < c1 - 1e-6);
  check('prev keyframe matches active key list', Math.abs(c2 - expPrev) < 1e-6);

  
  console.log('[4] project save/load via IPC');
  await js(`window.__app.state.projectPath = '${PROJ.replace(/\\/g, '\\\\')}'; window.__app.saveProject();`);
  await new Promise((r) => setTimeout(r, 600));
  check('project file exists', fs.existsSync(PROJ));
  const currentCuts = await js(`window.__app.model.cuts`);
  const currentDel = await js(`window.__app.model.deleted`);
  const loaded = await js(`window.keycut.loadProject('${PROJ.replace(/\\/g, '\\\\')}')`);
  const okCuts = loaded.cuts.length === currentCuts.length
    && loaded.cuts.every((v, i) => Math.abs(v - currentCuts[i]) < 1e-5);
  check('loaded cuts match', okCuts);
  check('loaded deleted match', JSON.stringify(loaded.deleted) === JSON.stringify(currentDel));

  
  console.log('[5] export via IPC (cut+concat+cleanup)');
  const res = await js(`window.keycut.exportStart({sourcePath:'${src}', segments:[[0,3],[5,6]], outputPath:'${OUT.replace(/\\/g, '\\\\')}'})`);
  check('export ok', !!(res && res.ok));
  check('tmp cleaned', !fs.existsSync(TMP));
  const durOut = await new Promise((res2) => {
    const { spawn } = require('child_process');
    const p = spawn('D:/Soft/portable/ffmpeg/ffmpeg.exe', ['-hide_banner', '-i', OUT], { windowsHide: true });
    let e = '';
    p.stderr.on('data', (d) => { e += d; });
    p.on('close', () => {
      const m2 = e.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      res2(m2 ? (+m2[1]) * 3600 + (+m2[2]) * 60 + parseFloat(m2[3]) : null);
    });
  });
  check('output duration ~4s', durOut !== null && Math.abs(durOut - 4) < 0.6);

  
  const drawn = await js(`(() => {
    const c = document.querySelector('#timeline');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] !== 0) n++;
    return n;
  })()`);
  check('timeline has pixels', drawn > 1000);

  
  console.log('[6] open .kc from OS');
  await js(`window.__app.state.source = null;`);
  await js(`window.__app.handleDroppedFile('${PROJ.replace(/\\/g, '\\\\')}')`);
  await new Promise((r) => setTimeout(r, 900));
  const osOpen = await js(`({src: !!window.__app.state.source, cuts: window.__app.model.cuts.length})`);
  check('project loaded from OS-open', osOpen.src === true && osOpen.cuts === 5);

  
  console.log('[7] help modal toggles');
  const help = await js(`(() => {
    const m = document.querySelector('#help-modal');
    window.__app.toggleHelp();
    const shown = !m.classList.contains('hidden');
    window.__app.toggleHelp();
    const hidden = m.classList.contains('hidden');
    return {
      shown,
      hidden,
      rows: document.querySelectorAll('#help-modal-body .shortcut-row').length,
      helpBtn: !!document.querySelector('#btn-help')
    };
  })()`);
  check('help button present', help.helpBtn);
  check('help modal opens', help.shown);
  check('help modal closes', help.hidden);
  check('help lists shortcuts', help.rows >= 10);

  win.destroy();
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  console.log('CONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  app.exit(fail || errors.length ? 1 : 0);
});
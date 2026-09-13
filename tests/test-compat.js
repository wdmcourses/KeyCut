const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { registerIpc } = require('../lib/ipc');

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-compat-test';
const SRC = path.join(DIR, 'compat-src.mp4');
const TMP = path.join(DIR, 'rt_tmp');

function makeFixture() {
  if (!fs.existsSync(SRC)) {
    fs.mkdirSync(DIR, { recursive: true });
    const ff = 'D:/Work/GitHub/KeyCut/vendor/ffmpeg/win32/ffmpeg.exe';
    const res = spawnSync(ff, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:v', 'libx264', '-g', '15', '-keyint_min', '15', '-pix_fmt', 'yuv420p',
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
  ipcMain.handle('get-open-file', () => null);
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
  const src = SRC.replace(/\\/g, '\\\\');

  console.log('[1] load source');
  await js(`window.__app.loadSource('${src}')`);
  await new Promise((r) => setTimeout(r, 1500));
  const st = await js(`({d: window.__app.state.duration, src: !!window.__app.state.source})`);
  check('source loaded with duration ~12s', st.src && Math.abs(st.d - 12) < 0.2);

  console.log('[2] force compat mode and stream');
  const r2 = await js(`(async () => {
    const cp = window.__app.compat;
    cp.flagSource('${src}');
    await cp.afterSource('${src}', window.__app.state.duration);
    await new Promise((r) => setTimeout(r, 2500));
    const slave = cp.slave;
    return {
      active: cp.active,
      hasSlave: !!slave,
      slaveSrc: slave ? !!slave.src : false,
      overlayVisible: cp.overlay ? cp.overlay.style.visibility !== 'hidden' : false,
      modeShown: !document.getElementById('compat-mode').classList.contains('hidden')
    };
  })()`);
  check('compat active', r2.active);
  check('slave element created with src', r2.hasSlave && r2.slaveSrc);
  check('compat-mode badge shown', r2.modeShown);

  console.log('[3] playback advances while playing');
  await js(`window.__app.play();`);
  await new Promise((r) => setTimeout(r, 2500));
  const t1 = await js(`window.__app.state.cursor`);
  await new Promise((r) => setTimeout(r, 1500));
  const t2 = await js(`window.__app.state.cursor`);
  check('master cursor advances (no stall)', t2 > t1 + 0.3);
  await js(`window.__app.pause();`);

  console.log('[4] pause hides overlay when master shows real file');
  const r4 = await js(`(() => {
    const cp = window.__app.compat;
    return {
      isDummy: cp.masterIsDummy,
      overlayVisibility: cp.overlay ? cp.overlay.style.visibility : 'no-overlay'
    };
  })()`);
  check('masterIsDummy false (real file kept)', r4.isDummy === false);
  check('overlay hidden on pause', r4.overlayVisibility === 'hidden');

  console.log('[5] dummy generation produces small file');
  const r5 = await js(`(async () => {
    const cp = window.__app.compat;
    const p = await window.keycut.compatEnsureDummy({ src: '${src}', duration: 12 });
    if (!p || !p.ok || !p.dummyPath) return { ok: false };
    const st = require ? null : null;
    return { ok: true, path: p.dummyPath };
  })()`);
  check('dummy ensure ok', r5.ok);
  if (r5.ok) {
    const sz = fs.statSync(r5.path).size;
    check('dummy file small (<200KB for 12s)', sz < 200 * 1024);
  }

  console.log('[6] stop cleans up');
  await js(`window.__app.compat.stop()`);
  const r6 = await js(`(() => {
    const cp = window.__app.compat;
    return { active: cp.active, hasSlave: !!cp.slave, modeShown: !document.getElementById('compat-mode').classList.contains('hidden') };
  })()`);
  check('compat stopped', !r6.active && !r6.hasSlave && !r6.modeShown);

  win.destroy();
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  console.log('CONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  app.exit(fail || errors.length ? 1 : 0);
});
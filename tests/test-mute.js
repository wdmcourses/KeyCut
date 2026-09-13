const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { registerIpc } = require('../lib/ipc');

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-mute-test';
const A = path.join(DIR, 'a.mp4');
const B = path.join(DIR, 'b.mp4');
const TMP = path.join(DIR, 'rt_tmp');
const FF = 'D:/Work/GitHub/KeyCut/vendor/ffmpeg/win32/ffmpeg.exe';

function makeFixture(p, dur, freq) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(DIR, { recursive: true });
    const res = spawnSync(FF, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=' + dur,
      '-f', 'lavfi', '-i', 'sine=frequency=' + freq + ':duration=' + dur,
      '-c:v', 'libx264', '-g', '15', '-keyint_min', '15',
      '-c:a', 'aac', '-shortest', p
    ]);
    if (res.status !== 0) { console.error('fixture fail', p, res.stderr.toString()); process.exit(1); }
  }
}

const errors = [];
let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
};

app.whenReady().then(async () => {
  makeFixture(A, 8, 440);
  makeFixture(B, 8, 880);
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
  const ea = A.replace(/\\/g, '\\\\');
  const eb = B.replace(/\\/g, '\\\\');

  console.log('[1] load A via loadSource');
  await js(`window.__app.loadSource('${ea}')`);
  await new Promise((r) => setTimeout(r, 1500));
  const s1 = await js(`({muted: window.__app.video.muted, src: !!window.__app.state.source})`);
  check('A loaded, not muted', s1.src && s1.muted === false);

  console.log('[2] enter compat on A directly (simulates Preparing)');
  await js(`window.__app.compat.flagSource('${ea}'); window.__app.compat.afterSource('${ea}', window.__app.state.duration);`);
  await new Promise((r) => setTimeout(r, 2500));
  const s2 = await js(`({muted: window.__app.video.muted, active: window.__app.compat.active, isDummy: window.__app.compat.masterIsDummy})`);
  check('compat active', s2.active);
  check('master muted during compat', s2.muted === true);

  console.log('[3] stop compat (simulates switching to another timeline)');
  await js(`window.__app.compat.stop()`);
  await new Promise((r) => setTimeout(r, 300));
  const s3 = await js(`({muted: window.__app.video.muted, active: window.__app.compat.active, volume: window.__app.video.volume})`);
  check('master UNMUTED after stop', s3.muted === false);
  check('volume intact', s3.volume === 1);
  check('compat inactive', s3.active === false);

  console.log('[4] play A after compat stop - verify audio plays');
  const s4 = await js(`(async () => {
    window.__app.togglePlay();
    await new Promise((r) => setTimeout(r, 1500));
    const res = { paused: window.__app.video.paused, muted: window.__app.video.muted, t: window.__app.video.currentTime };
    window.__app.pause();
    return res;
  })()`);
  check('A plays, unmuted, advances', s4.paused === false && s4.muted === false && s4.t > 0);

  console.log('[5] switch master src to B while compat active (mimics applyTimeline), then back');
  await js(`(async () => {
    const v = window.__app.video;
    v.src = ${JSON.stringify('file:///' + eb.replace(/\\/g, '/'))};
    v.load();
    await new Promise((r) => setTimeout(r, 1000));
    const mutedDuringLoad = v.muted;
    window.__app.compat.stop();
    await new Promise((r) => setTimeout(r, 200));
    return { mutedDuringLoad, mutedAfterStop: v.muted };
  })()`);
  const s5 = await js(`({muted: window.__app.video.muted})`);
  check('master unmuted after src switch + stop', s5.muted === false);

  console.log('[6] fallback scenario: real master -> switch to dummy -> stop, must still unmute');
  await js(`(async () => {
    const cp = window.__app.compat;
    cp.flagSource('${ea}');
    await cp.afterSource('${ea}', window.__app.state.duration);
    await new Promise((r) => setTimeout(r, 2000));
    // now simulate fallback to dummy: ensure a dummy file and switch master to it
    const d = await window.keycut.compatEnsureDummy({ src: '${ea}', duration: window.__app.state.duration });
    if (d && d.ok && d.dummyPath) await cp._switchMasterToDummy(d.dummyPath);
    await new Promise((r) => setTimeout(r, 800));
    return { mutedBeforeStop: window.__app.video.muted, weMuted: cp._weMuted, isDummy: cp.masterIsDummy };
  })()`);
  await js(`window.__app.compat.stop()`);
  const s6 = await js(`({muted: window.__app.video.muted, weMuted: window.__app.compat._weMuted})`);
  check('master unmuted after real->dummy->stop (prevMuted not clobbered)', s6.muted === false);
  check('_weMuted reset', s6.weMuted === false);

  win.destroy();
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  console.log('CONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('TEST CRASH', e); app.exit(1); });
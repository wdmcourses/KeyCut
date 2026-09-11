const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { registerIpc } = require('../lib/ipc');

const ROOT = path.join(__dirname, '..');
const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-fit';
const TMP = path.join(DIR, 'rt_tmp');
const ff = process.env.KEYCUT_FFMPEG || 'D:/Work/GitHub/KeyCut/vendor/ffmpeg/win32/ffmpeg.exe';

function makeVideo(name, w, h) {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(DIR, { recursive: true });
    const res = spawnSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=2`, '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', p]);
    if (res.status !== 0) console.error('gen fail', name, res.stderr.toString());
  }
  return p;
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail || ''); }
};

app.whenReady().then(async () => {
  makeVideo('v1440.mp4', 2560, 1440);
  makeVideo('v1080.mp4', 1920, 1080);
  registerIpc(() => win, ROOT, TMP);
  ipcMain.handle('get-open-file', () => null);
  ipcMain.handle('source:lock', () => true);
  const win = new BrowserWindow({
    width: 1600, height: 1000, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true }
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 800));
  const js = (code) => win.webContents.executeJavaScript(code);

  console.log('[1] 1440p pixel-perfect after loadSource');
  const s1440 = path.join(DIR, 'v1440.mp4').replace(/\\/g, '\\\\');
  await js(`window.__app.loadSource('${s1440}')`);
  await new Promise((r) => setTimeout(r, 1500));
  const r1440 = await js(`(() => { const v = document.getElementById('video'); const r = v.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), vw: v.videoWidth, vh: v.videoHeight }; })()`);
  console.log('  1440p rect:', JSON.stringify(r1440));
  check('1440p rect == 2560x1440', r1440.w === 2560 && r1440.h === 1440, `got ${r1440.w}x${r1440.h}`);

  console.log('[2] 1080p pixel-perfect after loadSource');
  const s1080 = path.join(DIR, 'v1080.mp4').replace(/\\/g, '\\\\');
  await js(`window.__app.loadSource('${s1080}')`);
  await new Promise((r) => setTimeout(r, 1500));
  const r1080 = await js(`(() => { const v = document.getElementById('video'); const r = v.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), vw: v.videoWidth, vh: v.videoHeight }; })()`);
  console.log('  1080p rect:', JSON.stringify(r1080));
  check('1080p rect == 1920x1080', r1080.w === 1920 && r1080.h === 1080, `got ${r1080.w}x${r1080.h}`);

  console.log('\nRESULT PASS=' + pass + ' FAIL=' + fail);
  app.exit(pass > 0 && fail === 0 ? 0 : 1);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { spawnSync } = require('child_process');
const fs = require('fs');

const OUT = 'C:/Users/alex/AppData/Local/Temp/opencode/bench/dummy-test.mkv';
const FF = 'D:/Work/GitHub/KeyCut/vendor/ffmpeg/win32/ffmpeg.exe';

app.whenReady().then(async () => {
  spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=8000', '-t', '61726', '-c:a', 'flac', OUT], { stdio: 'ignore' });
  const win = new BrowserWindow({ width: 300, height: 200, show: false });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = 'file:///' + ${JSON.stringify(OUT)}.replace(/\\\\/g, '/');
    v.load();
    await new Promise((r) => {
      let done = false;
      const f = () => { if (!done) { done = true; r(); } };
      v.addEventListener('loadedmetadata', f);
      setTimeout(f, 5000);
    });
    const dur = v.duration;
    let seekOk = false;
    try { v.currentTime = 30000; await new Promise((r) => setTimeout(r, 300)); seekOk = Math.abs(v.currentTime - 30000) < 1; } catch {}
    return { dur, seekOk, readyState: v.readyState, error: v.error ? v.error.code : null };
  })()`);
  console.log('RESULT:', JSON.stringify(res));
  app.exit(0);
});
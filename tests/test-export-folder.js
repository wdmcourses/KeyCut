const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = 'D:/Work/GitHub/KeyCut';
const { registerIpc } = require(path.join(ROOT, 'lib/ipc'));

const DIR = 'C:/Users/alex/AppData/Local/Temp/keycut-export-folder';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const SRC = path.join(DIR, 'test.mp4');
const SRC2 = path.join(DIR, 'test2.mp4');
const OUTDIR = path.join(DIR, 'out');
fs.mkdirSync(OUTDIR, { recursive: true });
const PROJ = path.join(DIR, 'proj.kc');

const ff = 'D:/Work/GitHub/KeyCut/vendor/ffmpeg/win32/ffmpeg.exe';
function makeVideo(p, dur) {
  const res = spawnSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=' + dur, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + dur, '-c:v', 'libx264', '-g', '15', '-keyint_min', '15', '-c:a', 'aac', '-shortest', p]);
  if (res.status !== 0) { console.error('gen fail', res.stderr.toString()); process.exit(1); }
}
function probeDur(p) {
  const r = spawnSync(ff, ['-hide_banner', '-i', p], { windowsHide: true });
  const e = r.stderr.toString();
  const m = e.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
}

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, d || ''); } };

app.whenReady().then(async () => {
  makeVideo(SRC, 10);
  makeVideo(SRC2, 5);
  const size = fs.statSync(SRC).size;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<keycut ver="2">
  <export compress="0" res="origin" blocks="0"/>
  <timelines active="1">
    <timeline id="1" name="test.mp4">
      <src rel="${SRC.replace(/\\/g, '/')}">test.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="10.000000"/></cuts>
      <markers></markers>
    </timeline>
    <timeline id="2" name="test2.mp4">
      <src rel="${SRC2.replace(/\\/g, '/')}">test2.mp4</src>
      <video dur="5.000000" w="640" h="360" fps="30.000000" size="${size}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="5.000000"/></cuts>
      <markers></markers>
    </timeline>
  </timelines>
</keycut>`;
  fs.writeFileSync(PROJ, xml, 'utf8');

  const errors = [];
  let win;
  registerIpc(() => win, ROOT, path.join(DIR, 'rt_tmp'));
  ipcMain.handle('get-open-file', () => null);
  ipcMain.handle('file:renameLocked', async (_e, { oldPath, newPath }) => {
    try {
      if (!fs.existsSync(oldPath)) return { ok: false, error: 'Source file not found' };
      if (fs.existsSync(newPath)) return { ok: false, error: 'Target file already exists' };
      await fs.promises.rename(oldPath, newPath);
      return { ok: true, path: newPath };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.removeHandler('dialog:pickFolder');
  let folderValue = OUTDIR;
  ipcMain.handle('dialog:pickFolder', () => folderValue);
  win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push('console: ' + message); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => win.webContents.executeJavaScript(c);
  const esc = (p) => p.replace(/\\/g, '\\\\');

  await js(`window.__app.handleDroppedFile('${esc(PROJ)}')`);
  await new Promise((r) => setTimeout(r, 1500));
  check('project opened with 2 timelines', (await js(`window.__app.state.timelines.length`)) === 2);

  console.log('[0] Export Project stays in folder mode after cancelling the folder picker');
  folderValue = null;
  await js(`window.__app.exportProject()`);
  await new Promise((r) => setTimeout(r, 200));
  await js(`window.__app.doExport()`);
  await new Promise((r) => setTimeout(r, 300));
  check('mode stays project after folder cancel', (await js(`window.__app._exportMode`)) === 'project');
  folderValue = OUTDIR;
  await js(`window.__app.doExport()`);
  let waited0 = 0;
  while (waited0 < 120) {
    const busy = await js(`window.__app.state.exporting`);
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 500));
    waited0++;
  }
  check('re-press after cancel re-exports to the folder', waited0 < 120 && fs.readdirSync(OUTDIR).length >= 2);

  for (const f of fs.readdirSync(OUTDIR)) fs.rmSync(path.join(OUTDIR, f), { force: true });
  await js(`window.__app.exportProjectFolder(null)`);
  let waited = 0;
  while (waited < 120) {
    const busy = await js(`window.__app.state.exporting`);
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 500));
    waited++;
  }
  check('export finished', waited < 120);
  console.log('  status:', await js(`document.getElementById('status-text').textContent`));
  console.log('  outdir contents:', JSON.stringify(fs.readdirSync(OUTDIR)));
  console.log('  source:', await js(`window.__app.state.source`));
  console.log('  export modal:', await js(`document.getElementById('export-modal-status').textContent`));
  const out1 = path.join(OUTDIR, 'test.mp4');
  const out2 = path.join(OUTDIR, 'test2.mp4');
  check('output 1 exists', fs.existsSync(out1));
  check('output 2 exists', fs.existsSync(out2));
  if (fs.existsSync(out1)) {
    const d1 = probeDur(out1);
    check('output 1 duration ~10s (own source)', d1 !== null && Math.abs(d1 - 10) < 0.6, String(d1));
  }
  if (fs.existsSync(out2)) {
    const d2 = probeDur(out2);
    check('output 2 duration ~5s (own source)', d2 !== null && Math.abs(d2 - 5) < 0.6, String(d2));
  }

  console.log('[1] Combine timelines into one video exports a single file (not separately)');
  for (const f of fs.readdirSync(OUTDIR)) fs.rmSync(path.join(OUTDIR, f), { force: true });
  ipcMain.removeHandler('dialog:saveExport');
  const COMBINED = path.join(OUTDIR, 'combined.mkv');
  ipcMain.handle('dialog:saveExport', () => COMBINED);
  await js(`window.__app._exportJoin = true`);
  await js(`window.__app.exportProjectFolder(null)`);
  let waited1 = 0;
  while (waited1 < 240) {
    const busy = await js(`window.__app.state.exporting`);
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 500));
    waited1++;
  }
  check('combine export finished', waited1 < 240);
  console.log('  combined status:', await js(`document.getElementById('status-text').textContent`));
  const files1 = fs.readdirSync(OUTDIR);
  console.log('  outdir contents:', JSON.stringify(files1));
  check('single combined file produced', fs.existsSync(COMBINED));
  check('no separate per-timeline files', files1.length === 1, JSON.stringify(files1));
  if (fs.existsSync(COMBINED)) {
    const dc = probeDur(COMBINED);
    check('combined duration ~15s (10+5)', dc !== null && Math.abs(dc - 15) < 1.2, String(dc));
  }

  win.destroy();
  console.log('\nCONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
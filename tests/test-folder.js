const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require(path.join(ROOT, 'lib', 'ipc'));

const FF = process.env.KEYCUT_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', process.platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WORK = path.join(os.tmpdir(), 'keycut-folder-test');
const ROOTDIR = path.join(WORK, 'root');
const SUB = path.join(ROOTDIR, 'sub');
const EMPTY = path.join(WORK, 'empty');

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

function makeVideo(p, dur) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const r = spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=' + dur, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + dur, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]);
  if (r.status !== 0) { console.error('fixture failed', r.stderr.toString()); process.exit(1); }
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('\nTEST TIMEOUT'); app.exit(1); }, 90000);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(SUB, { recursive: true });
  fs.mkdirSync(EMPTY, { recursive: true });
  makeVideo(path.join(ROOTDIR, 'a.mp4'), 1);
  makeVideo(path.join(ROOTDIR, 'b.mov'), 1);
  makeVideo(path.join(SUB, 'c.mkv'), 1);
  fs.writeFileSync(path.join(ROOTDIR, 'note.txt'), 'x');
  fs.writeFileSync(path.join(ROOTDIR, 'image.png'), 'x');
  const proj = path.join(WORK, 'proj.kc');
  fs.writeFileSync(proj, 'x');

  let win;
  registerIpc(() => win, ROOT, path.join(WORK, 'rt_tmp'));
  ipcMain.handle('get-open-file', () => null);
  ipcMain.handle('file:renameLocked', async () => ({ ok: false, error: 'n/a' }));
  win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));
  const js = (c) => win.webContents.executeJavaScript(c);
  const esc = (p) => p.replace(/\\/g, '\\\\');

  console.log('[1] collectPaths scans a folder recursively');
  const collected = await js(`window.keycut.collectPaths(['${esc(ROOTDIR)}'])`);
  const names = collected.videos.map((p) => path.basename(p));
  check('found 3 videos recursively', collected.videos.length === 3, JSON.stringify(names));
  check('sorted naturally', JSON.stringify(names) === JSON.stringify(['a.mp4', 'b.mov', 'c.mkv']), JSON.stringify(names));
  check('non-video files ignored', !names.includes('note.txt') && !names.includes('image.png'));
  check('folder reported', collected.folders.length === 1 && collected.folders[0] === ROOTDIR);

  console.log('[2] collectPaths separates projects and videos');
  const mixed = await js(`window.keycut.collectPaths(['${esc(path.join(ROOTDIR, 'a.mp4'))}', '${esc(proj)}'])`);
  check('video kept', mixed.videos.length === 1 && path.basename(mixed.videos[0]) === 'a.mp4');
  check('project kept', mixed.projects.length === 1 && mixed.projects[0] === proj);

  console.log('[3] dropping a folder adds timelines and opens the panel');
  const before = await js('window.__app.state.timelines.length');
  await js(`window.__app.handleCollectedPaths(${JSON.stringify(collected)})`);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await js('window.__app.state.timelines.length');
  check('timelines added from folder', after === before + 3, 'before=' + before + ' after=' + after);
  check('timelines panel visible', (await js("!document.getElementById('timelines-panel').classList.contains('hidden')")) === true);
  check('status mentions added count', /Added 3 timelines/.test(await js("document.getElementById('status-text').textContent")), await js("document.getElementById('status-text').textContent"));

  console.log('[4] dropping an empty folder reports nothing to edit');
  const n0 = await js('window.__app.state.timelines.length');
  await js(`window.__app.handleCollectedPaths({ videos: [], projects: [], folders: ['${esc(EMPTY)}'] })`);
  await new Promise((r) => setTimeout(r, 150));
  check('no timelines added', (await js('window.__app.state.timelines.length')) === n0);
  check('status explains empty folder', /No editable files/.test(await js("document.getElementById('status-text').textContent")), await js("document.getElementById('status-text').textContent"));

  console.log('[5] duplicate files are de-duplicated');
  const dup = await js(`window.keycut.collectPaths(['${esc(path.join(ROOTDIR, 'a.mp4'))}', '${esc(path.join(ROOTDIR, 'a.mp4'))}'])`);
  check('dedup', dup.videos.length === 1, JSON.stringify(dup.videos));

  win.destroy();
  clearTimeout(watchdog);
  console.log('\nCONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require(path.join(ROOT, 'lib/ipc'));

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('\nTEST TIMEOUT after 60s'); app.exit(1); }, 60000);
  let win;
  registerIpc(() => win, ROOT, path.join('C:/Users/alex/AppData/Local/Temp/opencode/keycut-runs-test', 'rt_tmp'));
  ipcMain.handle('get-open-file', () => null);
  ipcMain.handle('file:renameLocked', async () => ({ ok: false, error: 'n/a' }));
  win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('RENDERER ERR:', m); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => win.webContents.executeJavaScript(c);

  const t = {
    cuts: [0, 100, 200, 300],
    deleted: [false, true, false],
    markers: [{ t: 150, off: false }, { t: 250, off: true }]
  };

  const runs = await js(`window.__app.runsForTimelineData(${JSON.stringify(t)})`);
  const allValid = runs.every(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s <= e);
  check('no inverted runs (start <= end)', allValid, JSON.stringify(runs));
  check('off-marker clips the run correctly', JSON.stringify(runs) === JSON.stringify([[0, 100], [250, 300]]), JSON.stringify(runs));

  const t2 = {
    cuts: [0, 100, 200, 300],
    deleted: [false, false, false],
    markers: [{ t: 100, off: true }]
  };
  const runs2 = await js(`window.__app.runsForTimelineData(${JSON.stringify(t2)})`);
  check('off-marker at a cut boundary splits runs', JSON.stringify(runs2) === JSON.stringify([[100, 200], [200, 300]]), JSON.stringify(runs2));

  const t3 = {
    cuts: [0, 100, 200, 300],
    deleted: [true, false, true],
    markers: []
  };
  const runs3 = await js(`window.__app.runsForTimelineData(${JSON.stringify(t3)})`);
  check('no markers keeps kept runs only', JSON.stringify(runs3) === JSON.stringify([[100, 200]]), JSON.stringify(runs3));

  win.destroy();
  clearTimeout(watchdog);
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
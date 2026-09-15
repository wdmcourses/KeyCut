const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require(path.join(ROOT, 'lib/ipc'));

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-src-fallback-test';
const SRC = path.join(DIR, 'test.mp4');
const RELOK = path.join(DIR, 'reload.kc');
const RELBAD_ABSOK = path.join(DIR, 'relbad_absok.kc');
const BOTH_BAD = path.join(DIR, 'both_bad.kc');
const SAVE_OUT = path.join(DIR, 'saved.kc');

function makeFixture() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(SRC)) {
    const ff = process.env.KEYCUT_FFMPEG || 'D:/Work/GitHub/KeyCut/vendor/ffmpeg/win32/ffmpeg.exe';
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
  const size = fs.statSync(SRC).size;
  const relGood = path.relative(DIR, SRC).split(path.sep).join('/');
  const relBad = 'does_not_exist.mp4';
  const absGood = SRC.replace(/\\/g, '/');
  const xml = (file, rel, abs, active) => `<?xml version="1.0" encoding="UTF-8"?>
<keycut ver="2">
  <export compress="0" res="origin" blocks="0"/>
  <timelines active="${active}">
    <timeline id="1" name="test.mp4">
      <src rel="${rel}" abs="${abs}">test.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="2.500000"/><c t="4.000000"/><c t="10.000000"/></cuts>
      <markers><m t="1.500000" n="part_1" c="#7bd88f"/></markers>
    </timeline>
  </timelines>
</keycut>`;
  fs.writeFileSync(RELOK, xml(RELOK, relGood, absGood, '1'), 'utf8');
  fs.writeFileSync(RELBAD_ABSOK, xml(RELBAD_ABSOK, relBad, absGood, '1'), 'utf8');
  fs.writeFileSync(BOTH_BAD, xml(BOTH_BAD, relBad, path.join(DIR, 'also_missing.mp4').replace(/\\/g, '/'), '1'), 'utf8');
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra != null ? JSON.stringify(extra) : ''); }
};

app.whenReady().then(async () => {
  makeFixture();
  const errors = [];
  let win;
  registerIpc(() => win, ROOT, DIR);
  ipcMain.handle('get-open-file', () => null);
  win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true }
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push('console: ' + message); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => win.webContents.executeJavaScript(c);
  const esc = (p) => p.replace(/\\/g, '\\\\');
  const waitFor = async (expr, timeout = 10000, step = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await js(expr)) return true;
      await new Promise((r) => setTimeout(r, step));
    }
    return false;
  };

  console.log('[1] valid rel + valid abs -> rel wins (rel-first)');
  await js(`window.__app.handleDroppedFile('${esc(RELOK)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  let s = await js(`({src: window.__app.state.source, missing: window.__app.state.sourceMissing, cuts: (window.__app.model.cuts||[]).length, mk: (window.__app.timeline.markers||[]).length})`);
  const expectedRel = path.join(DIR, 'test.mp4').replace(/\\/g, '/');
  check('rel path used as source', !!s.src && s.src.replace(/\\/g, '/').toLowerCase() === expectedRel.toLowerCase(), s.src);
  check('not missing', s.missing === false);
  check('structure loaded', s.cuts === 4 && s.mk === 1);

  console.log('[2] broken rel + valid abs -> fallback to abs');
  await js(`window.__app.handleDroppedFile('${esc(RELBAD_ABSOK)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  s = await js(`({src: window.__app.state.source, missing: window.__app.state.sourceMissing, cuts: (window.__app.model.cuts||[]).length, mk: (window.__app.timeline.markers||[]).length})`);
  check('abs path used as source', !!s.src && s.src.replace(/\\/g, '/').toLowerCase() === SRC.replace(/\\/g, '/').toLowerCase(), s.src);
  check('not missing after fallback', s.missing === false);
  check('structure loaded after fallback', s.cuts === 4 && s.mk === 1);

  console.log('[3] broken rel + broken abs -> missing (markup shown)');
  await js(`window.__app.handleDroppedFile('${esc(BOTH_BAD)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  s = await js(`({missing: window.__app.state.sourceMissing, cuts: (window.__app.model.cuts||[]).length, mk: (window.__app.timeline.markers||[]).length})`);
  check('marked missing', s.missing === true);
  check('markup shown', s.cuts === 4 && s.mk === 1);

  console.log('[4] save writes abs and keeps rel');
  await js(`window.__app.handleDroppedFile('${esc(RELOK)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  await js(`window.__app.saveProjectTo('${esc(SAVE_OUT)}')`);
  await new Promise((r) => setTimeout(r, 800));
  const xml4 = fs.readFileSync(SAVE_OUT, 'utf8');
  const srcTag = (xml4.match(/<src\s+([^>]*?)>/) || ['', ''])[1];
  const attrs4 = {};
  for (const a of srcTag.matchAll(/(\w+)="([^"]*)"/g)) attrs4[a[1]] = a[2];
  check('saved has abs attr', !!attrs4.abs && attrs4.abs.replace(/\\/g, '/').toLowerCase() === SRC.replace(/\\/g, '/').toLowerCase(), attrs4.abs);
  check('saved has non-empty rel', !!attrs4.rel, attrs4.rel);

  console.log('[5] save after abs fallback rewrites rel to the found path');
  await js(`window.__app.handleDroppedFile('${esc(RELBAD_ABSOK)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  await js(`window.__app.saveProjectTo('${esc(SAVE_OUT)}')`);
  await new Promise((r) => setTimeout(r, 800));
  const xml5 = fs.readFileSync(SAVE_OUT, 'utf8');
  const srcTag5 = (xml5.match(/<src\s+([^>]*?)>/) || ['', ''])[1];
  const attrs5 = {};
  for (const a of srcTag5.matchAll(/(\w+)="([^"]*)"/g)) attrs5[a[1]] = a[2];
  check('rel rewritten to valid relative path after fallback', !!attrs5.rel && attrs5.rel !== 'does_not_exist.mp4', attrs5.rel);
  check('abs matches current src', attrs5.abs && attrs5.abs.replace(/\\/g, '/').toLowerCase() === SRC.replace(/\\/g, '/').toLowerCase(), attrs5.abs);

  console.log('[6] watcher does not mark missing while abs is alive');
  await js(`window.__app.handleDroppedFile('${esc(RELBAD_ABSOK)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  await js(`window.__app.checkTimelinesExist()`);
  const m6 = await js(`window.__app.state.timelines.map(t => ({missing: !!t.missing}))`);
  check('timeline stays available via abs', m6.length === 1 && m6[0].missing === false, m6);

  win.destroy();
  console.log('\nCONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
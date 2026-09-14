const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require(path.join(ROOT, 'lib/ipc'));

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-missing-test';
const SRC = path.join(DIR, 'test.mp4');
const RELOC = path.join(DIR, 'moved.mp4');
const PROJ = path.join(DIR, 'missing.kc');
const VIEWPROJ = path.join(DIR, 'viewstate.kc');
const SAVEPROJ = path.join(DIR, 'saveall.kc');
const SAVE_OUT = path.join(DIR, 'saveall_out.kc');
const TMP = path.join(DIR, 'rt_tmp');

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
  fs.copyFileSync(SRC, RELOC);
  const missingSrc = path.join(DIR, 'nonexistent.mp4').replace(/\\/g, '/');
  const writeProj = (file, dur, active, extra) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<keycut ver="2">
  <export compress="0" res="origin" blocks="0"/>
  <timelines active="${active}">
    <timeline id="1" name="missing.mp4">
      <src rel="${missingSrc}">missing.mp4</src>
      <video dur="${dur}.000000" w="640" h="360" fps="30.000000" size="${size}"/>
      <view cursor="${extra.cursor}" zoom="${extra.zoom}" start="${extra.viewStart}"/>
      <cuts><c t="0.000000"/><c t="2.500000"/><c t="4.000000"/><c t="${dur}.000000"/></cuts>
      <markers><m t="1.500000" n="part_1" c="#7bd88f"/></markers>
    </timeline>
    <timeline id="2" name="test.mp4">
      <src rel="${SRC.replace(/\\/g, '/')}">test.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="3.000000"/><c t="7.000000"/><c t="10.000000"/></cuts>
      <markers></markers>
    </timeline>
  </timelines>
</keycut>`;
    fs.writeFileSync(file, xml, 'utf8');
  };
  writeProj(PROJ, 10, 1, { cursor: '0.000000', zoom: '0.000000', viewStart: '0.000000' });
  writeProj(VIEWPROJ, 600, 1, { cursor: '200.000000', zoom: '122.500000', viewStart: '150.000000' });
  const size2 = fs.statSync(SRC).size;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<keycut ver="2">
  <export compress="0" res="origin" blocks="0"/>
  <timelines active="1">
    <timeline id="1" name="missing.mp4">
      <src rel="${missingSrc}">missing.mp4</src>
      <video dur="600.000000" w="640" h="360" fps="30.000000" size="${size2}"/>
      <view cursor="200.000000" zoom="50.000000" start="100.000000"/>
      <cuts><c t="0.000000"/><c t="150.000000"/><c t="400.000000"/><c t="600.000000"/></cuts>
      <markers><m t="1.500000" n="part_1" c="#7bd88f"/></markers>
    </timeline>
    <timeline id="2" name="test.mp4">
      <src rel="${SRC.replace(/\\/g, '/')}">test.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size2}"/>
      <view cursor="4.500000" zoom="88.000000" start="3.000000"/>
      <cuts><c t="0.000000"/><c t="3.000000"/><c t="7.000000"/><c t="10.000000"/></cuts>
      <markers></markers>
    </timeline>
  </timelines>
</keycut>`;
  fs.writeFileSync(SAVEPROJ, xml, 'utf8');
}

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
};

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
  const esc = (p) => p.replace(/\\/g, '\\\\');
  const waitFor = async (expr, timeout = 10000, step = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await js(expr)) return true;
      await new Promise((r) => setTimeout(r, step));
    }
    return false;
  };

  console.log('[1] open project on a missing timeline');
  await js(`window.__app.handleDroppedFile('${esc(PROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  let s = await js(`({id: window.__app.state.activeTimelineId, missing: window.__app.state.sourceMissing, cuts: (window.__app.model.cuts||[]).length, mk: (window.__app.timeline.markers||[]).length, dur: window.__app.state.duration, n: window.__app.state.timelines.length})`);
  check('active timeline is the missing one', s.id === 1 && s.missing === true);
  check('structure shown on first load', s.cuts === 4 && s.mk === 1);
  check('duration preserved from project', Math.abs(s.dur - 10) < 0.1);
  check('no extra timeline item', s.n === 2);

  console.log('[1b] missing timeline rename button is disabled');
  const rn = await js(`(() => {
    const rows = document.querySelectorAll('#tl-list .fl-item');
    const row = rows[0];
    const btn = row.querySelector('.fl-rename');
    return { disabled: btn.disabled, cls: btn.classList.contains('disabled') };
  })()`);
  check('rename button disabled on missing item', rn.disabled === true && rn.cls === true);

  console.log('[2] switch away (edit normal), then back to the missing timeline');
  await js(`window.__app.openTimelineById(2)`);
  await new Promise((r) => setTimeout(r, 1200));
  await js(`window.__app.seekTo(1.0); window.__app.timeline.addMarkerAt(window.__app.state.cursor); window.__app.model.snapshot(); window.__app.markDirty();`);
  await js(`window.__app.openTimelineById(1)`);
  await new Promise((r) => setTimeout(r, 1200));
  s = await js(`({id: window.__app.state.activeTimelineId, missing: window.__app.state.sourceMissing, cuts: (window.__app.model.cuts||[]).length, mk: (window.__app.timeline.markers||[]).length, dur: window.__app.state.duration})`);
  check('back on the missing timeline', s.id === 1 && s.missing === true);
  check('structure restored on revisit', s.cuts === 4 && s.mk === 1);
  check('duration preserved on revisit', Math.abs(s.dur - 10) < 0.1);
  const xml1 = fs.readFileSync(PROJ, 'utf8');
  check('project file keeps video metadata (not zeroed)', /<video dur="10\.\d+" w="640" h="360"/.test(xml1));

  console.log('[3] per-file view state (zoom/viewStart/caret) preserved on the missing timeline');
  await js(`window.__app.handleDroppedFile('${esc(VIEWPROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  const view0 = await js(`({pps: window.__app.timeline.pxPerSec, vs: window.__app.timeline.viewStart, cur: window.__app.state.cursor})`);
  check('zoom applied from project (not fit default)', view0.pps > 50);
  check('viewStart restored from project', Math.abs(view0.vs - 150) < 1e-6);
  check('caret restored from project', Math.abs(view0.cur - 200) < 1e-6);
  await js(`window.__app.openTimelineById(2)`);
  await new Promise((r) => setTimeout(r, 1200));
  await js(`window.__app.openTimelineById(1)`);
  await new Promise((r) => setTimeout(r, 1200));
  const view1 = await js(`({pps: window.__app.timeline.pxPerSec, vs: window.__app.timeline.viewStart, cur: window.__app.state.cursor})`);
  check('zoom preserved across switch', Math.abs(view1.pps - view0.pps) < 1e-6);
  check('viewStart preserved across switch', Math.abs(view1.vs - view0.vs) < 1e-6);
  check('caret preserved across switch', Math.abs(view1.cur - view0.cur) < 1e-6);

  console.log('[4] open the missing file at a new path -> reuse the missing item (no window resize)');
  await js(`window.__app.handleDroppedFile('${esc(PROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  await js(`(() => { const A = window.__app; A.__fitCalls = 0; const o = A.fitWindowToVideo.bind(A); A.fitWindowToVideo = async function() { this.__fitCalls++; return o(); }; return true; })()`);
  const winBefore = await js(`window.outerWidth + 'x' + window.outerHeight`);
  await js(`window.__app.loadSource('${esc(RELOC)}')`);
  await waitFor(`!!window.__app.state.source && !window.__app.state.sourceMissing`);
  const fitCalls = await js(`window.__app.__fitCalls`);
  const winAfter = await js(`window.outerWidth + 'x' + window.outerHeight`);
  check('reuse does not resize the editor', fitCalls === 0 && winAfter === winBefore);
  const phText = await js(`document.querySelector('#video-placeholder .placeholder-text').textContent`);
  check('placeholder text reset after locating the file', phText !== 'Source file missing — locate it in the Timelines panel', JSON.stringify(phText));
  s = await js(`({id: window.__app.state.activeTimelineId, missing: window.__app.state.sourceMissing, cuts: (window.__app.model.cuts||[]).length, mk: (window.__app.timeline.markers||[]).length, n: window.__app.state.timelines.length, src: window.__app.state.source})`);
  check('missing item reused (id stays 1)', s.id === 1);
  check('missing flag cleared', s.missing === false);
  check('no new timeline item added', s.n === 2);
  check('structure preserved through reuse', s.cuts === 4 && s.mk === 1);
  check('source updated to the located path', s.src === RELOC.replace(/\\/g, '\\'));

  console.log('[5] tlAddPaths fixes a missing timeline instead of adding a new one');
  await js(`window.__app.state.dirty = false;`);
  await js(`window.__app.handleDroppedFile('${esc(PROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  await js(`window.__app.openTimelineById(1)`);
  await new Promise((r) => setTimeout(r, 1200));
  let m5 = await js(`window.__app.state.timelines.map(t => ({id:t.id, missing:!!t.missing}))`);
  check('missing timeline present after reopen', m5.some((t) => t.missing === true));
  const n5 = await js(`window.__app.state.timelines.length`);
  await js(`window.__app.state.cursor = 5.5; window.__app.timeline.cursor = 5.5; window.__app.timeline.pxPerSec = 200; window.__app.timeline.viewStart = 2;`);
  await js(`window.__app.tlAddPaths(['${esc(RELOC)}'])`);
  await waitFor(`!!window.__app.state.source && !window.__app.state.sourceMissing`);
  m5 = await js(`window.__app.state.timelines.map(t => ({id:t.id, missing:!!t.missing, cuts:t.cuts && t.cuts.length}))`);
  check('no new timeline added (n unchanged)', (await js(`window.__app.state.timelines.length`)) === n5);
  check('missing timeline fixed', m5.every((t) => t.missing === false), JSON.stringify(m5));
  const fixed = m5.find((t) => t.id === 1);
  check('missing timeline markup preserved', fixed.cuts === 4, String(fixed && fixed.cuts));
  const actId5 = await js(`window.__app.state.activeTimelineId`);
  const actSrc5 = await js(`window.__app.state.source`);
  const actMiss5 = await js(`window.__app.state.sourceMissing`);
  console.log('  [debug] activeId=' + actId5 + ' source=' + actSrc5 + ' missing=' + actMiss5);
  check('active missing timeline opened after fix', actId5 === 1, String(actId5));
  check('active source loaded', (await js(`!!window.__app.state.source && !window.__app.state.sourceMissing`)) === true);
  const ph5 = await js(`document.querySelector('#video-placeholder .placeholder-text').textContent`);
  check('placeholder restored after fixing active missing', ph5 !== 'Source file missing — locate it in the Timelines panel', JSON.stringify(ph5));
  const cur5 = await js(`window.__app.state.cursor`);
  const pps5 = await js(`window.__app.timeline.pxPerSec`);
  check('caret preserved after fixing via drag', Math.abs(cur5 - 5.5) < 0.3, String(cur5));
  check('zoom preserved after fixing via drag', Math.abs(pps5 - 200) > 1, String(pps5));

  console.log('[6] save WITHOUT switching preserves positions of ALL timelines');
  await js(`window.__app.handleDroppedFile('${esc(SAVEPROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  const before6 = await js(`window.__app.state.timelines.map(t => ({id:t.id, cursor:t.cursor, zoom:t.zoom, viewStart:t.viewStart, cuts:t.cuts && t.cuts.length}))`);
  check('both timelines loaded with their positions', before6.length === 2 && before6.every((t) => t.cuts === 4), JSON.stringify(before6));
  const eff6 = await js(`({pps: window.__app.timeline.pxPerSec, vs: window.__app.timeline.viewStart, cur: window.__app.state.cursor})`);
  await js(`window.__app.saveProjectTo('${esc(SAVE_OUT)}')`);
  await new Promise((r) => setTimeout(r, 800));
  const xml6 = fs.readFileSync(SAVE_OUT, 'utf8');
  const block61 = (xml6.match(/<timeline id="1"[\s\S]*?<\/timeline>/) || [''])[0];
  const block62 = (xml6.match(/<timeline id="2"[\s\S]*?<\/timeline>/) || [''])[0];
  const viewOf = (block, id) => {
    const m = block.match(/<view\s+([^>]*?)\/>/);
    const a = {};
    if (m) for (const x of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[x[1]] = parseFloat(x[2]);
    return a;
  };
  const v61 = viewOf(block61);
  const v62 = viewOf(block62);
  check('saved: active timeline view matches effective state', Math.abs(v61.zoom - eff6.pps) < 0.001 && Math.abs(v61.start - eff6.vs) < 0.001 && Math.abs(v61.cursor - eff6.cur) < 0.001, JSON.stringify({ saved: v61, eff: eff6 }));
  check('saved: non-active timeline view preserved (not zeroed)', Math.abs(v62.cursor - 4.5) < 1e-6 && Math.abs(v62.zoom - 88) < 1e-6 && Math.abs(v62.start - 3) < 1e-6, JSON.stringify(v62));
  await js(`window.__app.handleDroppedFile('${esc(SAVE_OUT)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  const views6 = await js(`window.__app.state.timelines.map(t => ({id:t.id, cursor:t.cursor, zoom:t.zoom, viewStart:t.viewStart}))`);
  const t16 = views6.find((t) => t.id === 1);
  const t26 = views6.find((t) => t.id === 2);
  check('reopen: active timeline cursor/zoom/viewStart intact', !!t16 && Math.abs(t16.cursor - v61.cursor) < 1e-6 && Math.abs(t16.zoom - v61.zoom) < 1e-6 && Math.abs(t16.viewStart - v61.start) < 1e-6, JSON.stringify(t16));
  check('reopen: non-active timeline cursor/zoom/viewStart intact', !!t26 && Math.abs(t26.cursor - 4.5) < 1e-6 && Math.abs(t26.zoom - 88) < 1e-6 && Math.abs(t26.viewStart - 3) < 1e-6, JSON.stringify(t26));

  console.log('[7] timeline with empty <src rel=""> is treated as missing');
  const EMPTYPROJ = path.join(DIR, 'emptyrel.kc');
  const size7 = fs.statSync(SRC).size;
  const xml7 = `<?xml version="1.0" encoding="UTF-8"?>
<keycut ver="2">
  <export compress="0" res="origin" blocks="0"/>
  <timelines active="1">
    <timeline id="1" name="lost.mp4">
      <src rel="">lost.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size7}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="10.000000"/></cuts>
      <markers></markers>
    </timeline>
    <timeline id="2" name="test.mp4">
      <src rel="${SRC.replace(/\\/g, '/')}">test.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size7}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="10.000000"/></cuts>
      <markers></markers>
    </timeline>
  </timelines>
</keycut>`;
  fs.writeFileSync(EMPTYPROJ, xml7, 'utf8');
  await js(`window.__app.handleDroppedFile('${esc(EMPTYPROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  const m7 = await js(`window.__app.state.timelines.map(t => ({id:t.id, missing:!!t.missing, src:t.src}))`);
  check('empty-src timeline marked missing', m7.length === 2 && m7[0].missing === true && m7[0].src === '', JSON.stringify(m7));
  check('normal timeline not marked missing', m7[1].missing === false, JSON.stringify(m7));
  const row7 = await js(`(() => { const rows = document.querySelectorAll('#tl-list .fl-item'); const r = rows[0]; return { missing: r.classList.contains('missing'), locate: !!r.querySelector('.fl-locate'), renameDisabled: r.querySelector('.fl-rename').disabled }; })()`);
  check('empty-src row shows missing styling and Browse', row7.missing === true && row7.locate === true && row7.renameDisabled === true, JSON.stringify(row7));

  console.log('[8] source watch: deleting a timeline file externally marks it missing');
  const WATCHPROJ = path.join(DIR, 'watch.kc');
  const watchCopy = path.join(DIR, 'watch_src.mp4');
  fs.copyFileSync(SRC, watchCopy);
  const size8 = fs.statSync(watchCopy).size;
  const xml8 = `<?xml version="1.0" encoding="UTF-8"?>
<keycut ver="2">
  <export compress="0" res="origin" blocks="0"/>
  <timelines active="1">
    <timeline id="1" name="watch_src.mp4">
      <src rel="${watchCopy.replace(/\\/g, '/')}">watch_src.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size8}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="10.000000"/></cuts>
      <markers></markers>
    </timeline>
    <timeline id="2" name="test.mp4">
      <src rel="${SRC.replace(/\\/g, '/')}">test.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size8}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="10.000000"/></cuts>
      <markers></markers>
    </timeline>
  </timelines>
</keycut>`;
  fs.writeFileSync(WATCHPROJ, xml8, 'utf8');
  await js(`window.__app.handleDroppedFile('${esc(WATCHPROJ)}')`);
  await new Promise((r) => setTimeout(r, 1500));
  const init8 = await js(`({missing: !!window.__app.state.timelines[0].missing, sourceMissing: window.__app.state.sourceMissing, src: window.__app.state.source})`);
  check('watch: timeline present initially', init8.missing === false && init8.sourceMissing === false && !!init8.src, JSON.stringify(init8));
  fs.rmSync(watchCopy, { force: true });
  await waitFor(`!!window.__app.state.timelines[0].missing`, 10000, 200);
  const m8 = await js(`window.__app.state.timelines.map(t => ({id:t.id, missing:!!t.missing}))`);
  check('watch: deleted file marked missing', m8[0].missing === true, JSON.stringify(m8));
  check('watch: other file stays available', m8[1].missing === false, JSON.stringify(m8));
  fs.copyFileSync(SRC, watchCopy);
  await waitFor(`!window.__app.state.timelines[0].missing`, 10000, 200);
  const back8 = await js(`window.__app.state.timelines.map(t => ({id:t.id, missing:!!t.missing}))`);
  check('watch: restored file unmarked', back8[0].missing === false && back8[1].missing === false, JSON.stringify(back8));

  win.destroy();
  console.log('\nCONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
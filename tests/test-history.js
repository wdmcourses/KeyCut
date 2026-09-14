const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require(path.join(ROOT, 'lib/ipc'));

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-history-test';
const SRC = path.join(DIR, 'test.mp4');
const PROJ = path.join(DIR, 'proj.kc');
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
    if (res.status !== 0) { console.error('Fixture generation failed:', res.stderr.toString()); process.exit(1); }
  }
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
      <markers><m t="2.000000" n="part_1" c="#7bd88f"/><m t="5.000000" n="part_2" c="#8e588c"/></markers>
    </timeline>
  </timelines>
</keycut>`;
  fs.writeFileSync(PROJ, xml, 'utf8');
}

let pass = 0, fail = 0;
const check = (name, cond, d) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, d || ''); }
};

app.whenReady().then(async () => {
  makeFixture();
  const errors = [];
  let win;
  registerIpc(() => win, ROOT, TMP);
  ipcMain.handle('get-open-file', () => null);
  win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push('console: ' + message); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => win.webContents.executeJavaScript(c);
  const esc = (p) => p.replace(/\\/g, '\\\\');
  const marks = () => js(`window.__app.timeline.markers.map(m => ({id:m.id, t:m.t, name:m.name, off:!!m.off}))`);
  const hIndex = () => js(`window.__app.model.historyIndex`);
  const undoN = async (n) => { let i = 0; for (; i < n; i++) { if (!(await js(`window.__app.model.undo()`))) break; } return i; };
  const redoN = async (n) => { let i = 0; for (; i < n; i++) { if (!(await js(`window.__app.model.redo()`))) break; } return i; };

  await js(`window.__app.loadSource('${esc(SRC)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  const DUR = await js(`window.__app.state.duration`);
  const keys = await js(`window.__app.state.keyTimes`);
  const k1 = keys[5], k2 = keys[8];

  console.log('[1] marker add/delete undo/redo');
  await js(`window.__app.timeline.addMarkerAt(2); window.__app.timeline.addMarkerAt(4);`);
  let mk = await marks();
  check('2 markers added', mk.length === 2);
  const hBefore = await hIndex();
  for (const m of mk) await js(`window.__app.deleteActiveMarker(${m.id})`);
  mk = await marks();
  check('markers deleted', mk.length === 0);
  await undoN(2);
  mk = await marks();
  check('undo restores both markers', mk.length === 2);
  await redoN(2);
  mk = await marks();
  check('redo clears them again', mk.length === 0);
  check('history index back at latest after undo/redo cycle', (await hIndex()) === hBefore + 2);

  console.log('[2] rename does NOT create a history entry');
  await js(`window.__app.timeline.addMarkerAt(2);`);
  mk = await marks();
  const h0 = await hIndex();
  await js(`(() => { const t = window.__app.timeline; t.markers[0].name = 'renamed'; t.needsRender = true; t.tick(); return true; })()`);
  check('renaming alone adds no history step', (await hIndex()) === h0);

  console.log('[3] cuts and deleted are in the same history chain');
  await js(`window.__app.model.reset(${DUR}); window.__app.timeline.markers = []; window.__app.model.snapshot();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`);
  const state1 = await js(`({cuts: window.__app.model.cuts.length, del: window.__app.model.deleted})`);
  check('cut+delete applied', state1.cuts === 4 && state1.del[1] === true);
  await undoN(1);
  const sUndo = await js(`window.__app.model.deleted`);
  check('undo restores the segment', sUndo[1] === false);
  await redoN(1);
  const sRedo = await js(`window.__app.model.deleted`);
  check('redo re-deletes the segment', sRedo[1] === true);

  console.log('[4] marker off toggle undo/redo');
  await js(`window.__app.timeline.addMarkerAt(1);`);
  await js(`(() => { const m = window.__app.timeline.markers[0]; m.off = true; window.__app.model.snapshot(); return true; })()`);
  mk = await marks();
  check('marker off set', mk[0].off === true);
  await undoN(1);
  mk = await marks();
  check('undo restores off=false', mk[0].off === false);
  await redoN(1);
  mk = await marks();
  check('redo re-applies off=true', mk[0].off === true);

  console.log('[5] marker drag commits one undo step');
  const beforeDrag = await hIndex();
  await js(`(() => { const t = window.__app.timeline; t.moveMarkerTo(t.markers[0].id, 3); t._lastBubbleId = null; if (t.model) t.model.snapshot(); return true; })()`);
  const afterDrag = await hIndex();
  check('drag creates one history entry', afterDrag === beforeDrag + 1);

  console.log('[6] mixed chain: undo everything then redo everything');
  const total = await hIndex();
  const undone = await undoN(100);
  check('undo reached the initial state', undone === total);
  const sInit = await js(`({cuts: window.__app.model.cuts.length, mk: window.__app.timeline.markers.length})`);
  check('initial state: 2 cuts, no markers', sInit.cuts === 2 && sInit.mk === 0);
  const redone = await redoN(100);
  check('redo back to the latest state', redone === total);

  console.log('[7] very last undo keeps markers loaded from a project (regression)');
  await js(`window.__app.state.dirty = false;`);
  await js(`window.__app.handleDroppedFile('${esc(PROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  mk = await marks();
  check('project markers loaded (2)', mk.length === 2);
  await js(`window.__app.timeline.addMarkerAt(3)`);
  mk = await marks();
  check('marker added (3)', mk.length === 3);
  const n = await undoN(100);
  check('undo returned to the initial project state', n === 1);
  mk = await marks();
  check('very last undo keeps project markers (2, not wiped)', mk.length === 2);
  check('very last undo keeps marker names/order', JSON.stringify(mk.map((m) => m.name)) === JSON.stringify(['part_1', 'part_2']));

  console.log('[8] marker name cannot be empty');
  await js(`window.__app.timeline.addMarkerAt(1);`);
  const r8 = await js(`(() => {
    const t = window.__app.timeline;
    const m = t.markers[t.markers.length - 1];
    const orig = m.name;
    window.__app.markerBubble(m);
    const inp = document.getElementById('marker-name');
    inp.value = '';
    inp.dispatchEvent(new Event('input'));
    const warn = document.getElementById('marker-warn');
    const res = { name: m.name, warnVisible: !warn.classList.contains('hidden'), warnText: warn.textContent, kept: m.name === orig };
    window.__app.hideMarkerBubble();
    return res;
  })()`);
  check('clearing the name shows a warning', r8.warnVisible === true, r8.warnText);
  check('marker name not emptied', r8.kept === true && !!r8.name);
  check('warning text mentions empty', /empty/i.test(r8.warnText));

  console.log('[9] Escape cancels marker rename, Enter commits');
  await js(`window.__app.timeline.addMarkerAt(1.5);`);
  const r9a = await js(`(() => {
    const t = window.__app.timeline;
    const m = t.markers[t.markers.length - 1];
    const orig = m.name;
    window.__app.markerBubble(m);
    const inp = document.getElementById('marker-name');
    inp.value = 'renamed_escape';
    inp.dispatchEvent(new Event('input'));
    const afterInput = m.name;
    inp.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
    return { orig, afterInput, afterEsc: m.name };
  })()`);
  check('typing writes a valid new name', r9a.afterInput === 'renamed_escape', JSON.stringify(r9a));
  check('Escape reverts to the original name', r9a.afterEsc === r9a.orig && r9a.afterEsc !== 'renamed_escape', JSON.stringify(r9a));

  await js(`window.__app.timeline.addMarkerAt(1.7);`);
  const r9b = await js(`(() => {
    const t = window.__app.timeline;
    const m = t.markers[t.markers.length - 1];
    const orig = m.name;
    window.__app.markerBubble(m);
    const inp = document.getElementById('marker-name');
    inp.value = 'renamed_enter';
    inp.dispatchEvent(new Event('input'));
    inp.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true }));
    return { orig, afterEnter: m.name };
  })()`);
  check('Enter commits the new name', r9b.afterEnter === 'renamed_enter' && r9b.afterEnter !== r9b.orig, JSON.stringify(r9b));

  console.log('[10] export segment shows the time range');
  await js(`window.__app.timeline.addMarkerAt(2); window.__app.timeline.addMarkerAt(4);`);
  const r10 = await js(`(() => {
    const t = window.__app.timeline;
    const sorted = t.sortedMarkers();
    const last = sorted[sorted.length - 1];
    let prev = 0;
    for (const mm of sorted) { if (mm.id === last.id) break; prev = mm.t; }
    window.__app.openSegmentExport(last.id);
    const rangeEl = document.getElementById('export-segment-range');
    const parse = (s) => { const [mm, ss] = s.split(':'); return (+mm) * 60 + (+ss); };
    return {
      visible: !rangeEl.classList.contains('hidden'),
      from: document.getElementById('export-segment-from').textContent,
      to: document.getElementById('export-segment-to').textContent,
      prev, mT: last.t,
      fromT: parse(document.getElementById('export-segment-from').textContent),
      toT: parse(document.getElementById('export-segment-to').textContent)
    };
  })()`);
  await js(`document.getElementById('export-settings-modal').classList.add('hidden');`);
  check('segment range shown in export settings', r10.visible === true, JSON.stringify(r10));
  check('range from matches previous marker time', Math.abs(r10.fromT - r10.prev) < 0.01, JSON.stringify(r10));
  check('range to matches the marker time', Math.abs(r10.toT - r10.mT) < 0.01, JSON.stringify(r10));

  win.destroy();
  console.log('\nCONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
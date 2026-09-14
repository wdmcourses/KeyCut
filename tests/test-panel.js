const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require(path.join(ROOT, 'lib/ipc'));

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-panel-test';
const SRC = path.join(DIR, 'test.mp4');
const SRC2 = path.join(DIR, 'test2.mp4');
const SRC3 = path.join(DIR, 'test3.mp4');
const PROJ = path.join(DIR, 'proj.kc');
const TMP = path.join(DIR, 'rt_tmp');

function makeFixture() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const ff = process.env.KEYCUT_FFMPEG || 'D:/Work/GitHub/KeyCut/vendor/ffmpeg/win32/ffmpeg.exe';
  for (const [p, freq] of [[SRC, 440], [SRC2, 660], [SRC3, 880]]) {
    if (!fs.existsSync(p)) {
      const res = spawnSync(ff, [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=10',
        '-f', 'lavfi', '-i', 'sine=frequency=' + freq + ':duration=10',
        '-c:v', 'libx264', '-g', '15', '-keyint_min', '15',
        '-c:a', 'aac', '-shortest', p
      ]);
      if (res.status !== 0) { console.error('Fixture generation failed:', res.stderr.toString()); process.exit(1); }
    }
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
      <markers></markers>
    </timeline>
    <timeline id="2" name="test2.mp4">
      <src rel="${SRC2.replace(/\\/g, '/')}">test2.mp4</src>
      <video dur="10.000000" w="640" h="360" fps="30.000000" size="${size}"/>
      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>
      <cuts><c t="0.000000"/><c t="10.000000"/></cuts>
      <markers></markers>
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
  const startedAt = Date.now();
  const watchdog = setTimeout(() => {
    console.log('\nTEST TIMEOUT after 90s — aborting (possible hang)');
    app.exit(1);
  }, 90000);
  makeFixture();
  const errors = [];
  let win;
  registerIpc(() => win, ROOT, TMP);
  ipcMain.handle('get-open-file', () => null);
  ipcMain.handle('file:renameLocked', async (_e, { oldPath, newPath }) => {
    try {
      if (!fs.existsSync(oldPath)) return { ok: false, error: 'Source file not found' };
      if (fs.existsSync(newPath)) return { ok: false, error: 'Target file already exists' };
      await fs.promises.rename(oldPath, newPath);
      return { ok: true, path: newPath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push('console: ' + message); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => win.webContents.executeJavaScript(c);
  const esc = (p) => p.replace(/\\/g, '\\\\');
  const panelHidden = () => js(`document.querySelector('#timelines-panel').classList.contains('hidden')`);
  const activeId = () => js(`window.__app.state.activeTimelineId`);
  const waitFor = async (expr, timeout = 8000, step = 100) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await js(expr)) return true;
      await new Promise((r) => setTimeout(r, step));
    }
    return false;
  };
  const clickRow = (i) => js(`(() => { const rows = document.querySelectorAll('#tl-list .fl-item'); const r = rows[${i}]; if (!r) return 'no-row:' + rows.length; const n = r.querySelector('.fl-name'); if (!n) return 'no-name'; n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return 'ok'; })()`);
  const clickRename = (i) => js(`(() => { const rows = document.querySelectorAll('#tl-list .fl-item'); const r = rows[${i}]; if (!r) return 'no-row'; r.querySelector('.fl-rename').click(); return 'ok'; })()`);
  const clickInput = () => js(`(() => { const el = document.querySelector('.fl-rename-input'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return !!el; })()`);
  const inputPresent = () => js(`!!document.querySelector('.fl-rename-input')`);

  await js(`window.__app.handleDroppedFile('${esc(PROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  check('project opened, active = timeline 1', (await activeId()) === 1);

  console.log('[0a] window title follows KeyCut | project | timeline');
  const title0 = await js(`window.__app._titleRaw`);
  check('title = "KeyCut | proj.kc | test.mp4"', title0 === 'KeyCut | proj.kc | test.mp4', JSON.stringify(title0));

  console.log('[0b] loadPlacedVideo (Set keys insert) does not resize the window');
  await js(`(() => { const A = window.__app; A.__fitCalls = 0; const o = A.fitWindowToVideo.bind(A); A.fitWindowToVideo = async function(){ this.__fitCalls++; return o(); }; return true; })()`);
  await js(`window.__app.loadPlacedVideo('${esc(SRC)}', [0,10], [false], [], 0, null, null)`);
  await new Promise((r) => setTimeout(r, 1200));
  check('no resize on placed keyframed video', (await js(`window.__app.__fitCalls`)) === 0);
  await js(`window.__app.openTimelineById(1)`);
  await new Promise((r) => setTimeout(r, 1200));

  console.log('[1] clicking the already-active timeline keeps the panel open');
  await js(`window.__app.toggleTimelinesPanel(true)`);
  check('panel open', (await panelHidden()) === false);
  console.log('  clickRow(0) ->', await clickRow(0));
  await new Promise((r) => setTimeout(r, 200));
  check('active stays timeline 1', (await activeId()) === 1);
  check('panel still open after clicking active', (await panelHidden()) === false);

  console.log('[2] clicking a different timeline selects it but keeps the panel open');
  console.log('  clickRow(1) ->', await clickRow(1));
  await new Promise((r) => setTimeout(r, 300));
  console.log('  active after 300ms:', await activeId(), 'panel hidden:', await panelHidden());
  await new Promise((r) => setTimeout(r, 900));
  console.log('  active after 1200ms:', await activeId(), 'panel hidden:', await panelHidden());
  check('active switched to timeline 2', (await activeId()) === 2);
  check('panel stays open after selecting another timeline', (await panelHidden()) === false);

  console.log('[2b] clicking the right-side actions and surrounding row does not open the timeline');
  await js(`window.__app.toggleTimelinesPanel(true)`);
  const before2b = await activeId();
  await js(`(() => {
    const rows = document.querySelectorAll('#tl-list .fl-item');
    const actions = rows[0].querySelector('.fl-actions');
    if (actions) actions.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const badge = rows[0].querySelector('.fl-badge');
    if (badge) badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  check('active unchanged after clicking actions/around', (await activeId()) === before2b);
  check('timeline 0 still present', (await js(`window.__app.state.timelines.length`)) >= 2);

  console.log('[3] renaming: clicking inside the item being renamed does not load/close');
  await js(`window.__app.toggleTimelinesPanel(true)`);
  await clickRename(1);
  await new Promise((r) => setTimeout(r, 100));
  check('rename input present', (await inputPresent()) === true);
  const hadInput = await clickInput();
  check('clicked the rename input', hadInput === true);
  await new Promise((r) => setTimeout(r, 300));
  check('active still timeline 2', (await activeId()) === 2);
  check('panel still open while renaming', (await panelHidden()) === false);
  check('rename input still present after in-input click', (await inputPresent()) === true);

  console.log('[4] committing the rename renames the real file on disk');
  await js(`(() => { const el = document.querySelector('.fl-rename-input'); el.value = 'renamed'; el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await new Promise((r) => setTimeout(r, 800));
  check('rename committed', (await inputPresent()) === false);
  const name = await js(`document.querySelector('#tl-list .fl-item:nth-child(2) .fl-name').textContent`);
  check('timeline display renamed to "renamed"', name === 'renamed');
  const tlName = await js(`window.__app.state.timelines[1].name`);
  check('model name is the new full filename', tlName === 'renamed.mp4');
  const tlSrc = await js(`window.__app.state.timelines[1].src`);
  check('timeline src points to renamed file', tlSrc.replace(/\\/g, '/').endsWith('/renamed.mp4'));
  check('state.source updated for active timeline', (await js(`window.__app.state.source.replace(/\\\\/g, '/')`)).endsWith('/renamed.mp4'));
  check('renamed file exists on disk', fs.existsSync(path.join(DIR, 'renamed.mp4')));
  check('old file gone on disk', !fs.existsSync(SRC2));
  const projText = fs.readFileSync(PROJ, 'utf8');
  check('project file references renamed.mp4', /renamed\.mp4/.test(projText));

  console.log('[5] rename collision is rejected');
  await js(`window.__app.toggleTimelinesPanel(true)`);
  await clickRename(0);
  await new Promise((r) => setTimeout(r, 100));
  await js(`(() => { const el = document.querySelector('.fl-rename-input'); el.value = 'renamed'; el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await new Promise((r) => setTimeout(r, 500));
  const tl0Src = await js(`window.__app.state.timelines[0].src`);
  check('timeline 0 file was NOT renamed to the colliding name', tl0Src.replace(/\\/g, '/').endsWith('/test.mp4'));
  check('collision target file still exists', fs.existsSync(path.join(DIR, 'renamed.mp4')));
  const popup5 = await js(`document.querySelector('#confirm-message').textContent`);
  check('popup informs about the name collision', /already uses|already exists/i.test(popup5), popup5);
  check('rename popup action button says Close', (await js(`document.querySelector('#confirm-ok').textContent`)) === 'Close');
  check('cancel button hidden in alert popup', (await js(`document.querySelector('#confirm-cancel').classList.contains('hidden')`)) === true);
  await js(`document.querySelector('#confirm-ok').click()`);
  await new Promise((r) => setTimeout(r, 150));
  check('alert popup closed after OK', (await js(`document.querySelector('#confirm-modal').classList.contains('hidden')`)) === true);

  console.log('[5c] rename to an existing file on disk shows a popup');
  const BLOCKED = path.join(DIR, 'blocked.mp4');
  if (!fs.existsSync(BLOCKED)) fs.copyFileSync(SRC, BLOCKED);
  await js(`window.__app.toggleTimelinesPanel(true)`);
  await clickRename(0);
  await new Promise((r) => setTimeout(r, 100));
  await js(`(() => { const el = document.querySelector('.fl-rename-input'); el.value = 'blocked'; el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await new Promise((r) => setTimeout(r, 400));
  const popup5c = await js(`document.querySelector('#confirm-message').textContent`);
  check('popup shown when target file exists on disk', /already exists/i.test(popup5c), popup5c);
  const tl0Src5c = await js(`window.__app.state.timelines[0].src`);
  check('timeline 0 NOT renamed to the existing file', tl0Src5c.replace(/\\/g, '/').endsWith('/test.mp4'));
  await js(`document.querySelector('#confirm-ok').click()`);
  await new Promise((r) => setTimeout(r, 150));
  check('disk-exists popup closed after OK', (await js(`document.querySelector('#confirm-modal').classList.contains('hidden')`)) === true);

  console.log('[5b] repeated rename and renaming the active timeline work');
  const commitRename = (val) => js(`(() => { const el = document.querySelector('.fl-rename-input'); if (!el) return false; el.value = '${val}'; el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await clickRename(1);
  await new Promise((r) => setTimeout(r, 100));
  await commitRename('renamed2');
  await new Promise((r) => setTimeout(r, 800));
  let tl2n = await js(`window.__app.state.timelines[1].name`);
  check('repeated rename: timeline 2 -> renamed2.mp4', tl2n === 'renamed2.mp4', tl2n);
  check('renamed2 file exists', fs.existsSync(path.join(DIR, 'renamed2.mp4')));
  check('renamed.mp4 gone after second rename', !fs.existsSync(path.join(DIR, 'renamed.mp4')));
  await clickRename(1);
  await new Promise((r) => setTimeout(r, 100));
  await commitRename('active_renamed');
  await new Promise((r) => setTimeout(r, 900));
  tl2n = await js(`window.__app.state.timelines[1].name`);
  check('active timeline renamed -> active_renamed.mp4', tl2n === 'active_renamed.mp4', tl2n);
  check('state.source updated to active_renamed.mp4', (await js(`window.__app.state.source.replace(/\\\\/g, '/')`)).endsWith('/active_renamed.mp4'));
  check('active_renamed file exists', fs.existsSync(path.join(DIR, 'active_renamed.mp4')));
  const projText2 = fs.readFileSync(PROJ, 'utf8');
  check('project saved with active_renamed.mp4', /active_renamed\.mp4/.test(projText2));

  console.log('[6] no save file -> project stays dirty across timeline switches');
  await js(`window.__app.state.projectPath = null;`);
  await js(`window.__app.openTimelineById(1)`);
  await new Promise((r) => setTimeout(r, 1200));
  check('switch to another timeline keeps dirty (no save file)', (await js(`window.__app.state.dirty`)) === true);
  await js(`window.__app.openTimelineById(2)`);
  await new Promise((r) => setTimeout(r, 1200));
  check('switch back also keeps dirty', (await js(`window.__app.state.dirty`)) === true);
  check('title shows the dirty star', (await js(`document.title`)).startsWith('* '));

  console.log('[7] clicking the video area closes the panel');
  await js(`window.__app.toggleTimelinesPanel(true)`);
  check('panel open', (await panelHidden()) === false);
  await js(`(() => { document.querySelector('#video-wrap').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);
  await new Promise((r) => setTimeout(r, 150));
  check('panel closed after clicking video area', (await panelHidden()) === true);

  console.log('[7b] pressing the timeline canvas closes the panel on first press');
  await js(`window.__app.toggleTimelinesPanel(true)`);
  check('panel open before canvas press', (await panelHidden()) === false);
  await js(`(() => { document.querySelector('#timeline').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); return true; })()`);
  await new Promise((r) => setTimeout(r, 150));
  check('panel closed on first canvas press', (await panelHidden()) === true);

  console.log('[8] hotkey W toggles the panel');
  await js(`window.__app.toggleTimelinesPanel(false)`);
  check('panel closed before W', (await panelHidden()) === true);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true }));`);
  await new Promise((r) => setTimeout(r, 150));
  check('panel opened by W', (await panelHidden()) === false);
  check('timelines button shows pressed state when open', (await js(`document.querySelector('#btn-timelines').classList.contains('active')`)) === true);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true }));`);
  await new Promise((r) => setTimeout(r, 150));
  check('panel closed by W again', (await panelHidden()) === true);
  check('timelines button pressed state cleared when closed', (await js(`document.querySelector('#btn-timelines').classList.contains('active')`)) === false);

  console.log('[9] concat Insert does not resize the editor with a project open');
  await js(`window.__app.state.projectPath = '${esc(PROJ)}';`);
  await js(`(() => { const A = window.__app; A.__fitCalls = 0; const o = A.fitWindowToVideo.bind(A); A.fitWindowToVideo = async function(){ this.__fitCalls++; return o(); }; return true; })()`);
  const winBefore = await js(`window.outerWidth + 'x' + window.outerHeight`);
  const nBefore = await js(`window.__app.state.timelines.length`);
  await js(`(() => { const A = window.__app; A._concatResult = '${esc(SRC)}'; return A.concatInsert(); })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const nAfter = await js(`window.__app.state.timelines.length`);
  const winAfter = await js(`window.outerWidth + 'x' + window.outerHeight`);
  check('joined timeline inserted', nAfter === nBefore + 1);
  check('no resize on concat insert', (await js(`window.__app.__fitCalls`)) === 0 && winAfter === winBefore);

  console.log('[10] concat Insert adds a fresh timeline, not the active markup/zoom');
  await js(`window.__app.openTimelineById(1)`);
  await new Promise((r) => setTimeout(r, 1200));
  const keys = await js(`window.__app.state.keyTimes`);
  const k = keys[5];
  await js(`window.__app.seekTo(${k}); window.__app.cut(); window.__app.timeline.addMarkerAt(2);`);
  await js(`window.__app.timeline.pxPerSec = 300; window.__app.timeline.viewStart = 1;`);
  await js(`window.__app.state.projectPath = '${esc(PROJ)}'; window.__app.saveProject();`);
  await new Promise((r) => setTimeout(r, 800));
  const active = await js(`({cuts: window.__app.model.cuts.length, mk: window.__app.timeline.markers.length, pps: window.__app.timeline.pxPerSec})`);
  check('active timeline has distinct markup (3 cuts, 1 marker)', active.cuts === 3 && active.mk === 1, JSON.stringify(active));
  const nBefore2 = await js(`window.__app.state.timelines.length`);
  fs.copyFileSync(SRC, SRC2);
  await js(`(() => { const A = window.__app; A._concatResult = '${esc(SRC2)}'; return A.concatInsert(); })()`);
  await waitFor(`window.__app.state.activeTimelineId === ${nBefore2 + 1} && window.__app.timeline.duration > 0`, 25000, 200);
  const ins = await js(`({id: window.__app.state.activeTimelineId, n: window.__app.state.timelines.length})`);
  check('new timeline added', ins.n === nBefore2 + 1);
  check('joined timeline becomes active', ins.id === nBefore2 + 1, String(ins.id));
  const fresh = await js(`({cuts: window.__app.model.cuts.length, mk: window.__app.timeline.markers.length, pps: window.__app.timeline.pxPerSec})`);
  check('opened new timeline has fresh markup (2 cuts)', fresh.cuts === 2, String(fresh.cuts));
  check('opened new timeline has no markers', fresh.mk === 0, String(fresh.mk));
  check('opened new timeline zoom is fit, not active zoom (300)', Math.abs(fresh.pps - 300) > 1, String(fresh.pps));

  console.log('[11] drag gating: panel drag is disabled while the Join window is open');
  await js(`window.__app.concatVideos()`);
  check('panel busy (drag disabled) while concat open', (await js(`window.__app._fileList.busy()`)) === true);
  await js(`(() => { document.querySelector('#concat-modal').classList.add('hidden'); return true; })()`);
  check('panel not busy after concat closed', (await js(`window.__app._fileList.busy()`)) === false);

  console.log('[12] adding files is blocked while an operation is running');
  const nBusy = await js(`window.__app.state.timelines.length`);
  await js(`window.__app.state.exporting = true;`);
  await js(`window.__app.tlAddPaths(['${esc(SRC2)}'])`);
  await js(`window.__app.concatAddPaths(['${esc(SRC2)}'])`);
  await new Promise((r) => setTimeout(r, 300));
  const nBusyAfter = await js(`window.__app.state.timelines.length`);
  const concatFiles = await js(`window.__app._concatFiles.length`);
  check('tlAddPaths blocked during export', nBusyAfter === nBusy);
  check('concatAddPaths blocked during export', concatFiles === 0);
  await js(`window.__app.state.exporting = false;`);
  await js(`window.__app.tlAddPaths(['${esc(SRC3)}'])`);
  const tlAdded = await waitFor(`window.__app.state.timelines.length === ${nBusy + 1}`);
  check('tlAddPaths works after export ends', tlAdded);

  console.log('[13] openFiles warns when a project file is mixed into the selection');
  ipcMain.removeHandler('dialog:chooseFiles');
  ipcMain.handle('dialog:chooseFiles', () => [PROJ, SRC]);
  await js(`window.__app.openFiles()`);
  await new Promise((r) => setTimeout(r, 300));
  const warnKc = await js(`document.getElementById('status-text').textContent`);
  check('warning shown for mixed .kc + video selection', /project file/i.test(warnKc), warnKc);
  ipcMain.removeHandler('dialog:chooseFiles');

  console.log('[14] instant reorder: fast drag on the handle reorders immediately (no native DnD delay)');
  const ord0 = await js(`Array.from(document.querySelectorAll('#tl-list .fl-item .fl-name')).map(n => n.textContent)`);
  check('panel has rows to reorder', ord0.length >= 3, JSON.stringify(ord0));
  const first0 = ord0[0];
  const actBefore = await activeId();
  const dragRes = await js(`(() => {
    const rows = document.querySelectorAll('#tl-list .fl-item');
    if (rows.length < 2) return 'need-2-rows';
    const handle = rows[0].querySelector('.fl-drag');
    if (!handle) return 'no-handle';
    const hr = handle.getBoundingClientRect();
    const sx = hr.left + hr.width / 2, sy = hr.top + hr.height / 2;
    const last = rows[rows.length - 1].getBoundingClientRect();
    const ty = last.bottom - 1;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx, clientY: ty }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: sx, clientY: ty }));
    return 'ok';
  })()`);
  check('fast drag dispatched', dragRes === 'ok', dragRes);
  await new Promise((r) => setTimeout(r, 300));
  const ord1 = await js(`Array.from(document.querySelectorAll('#tl-list .fl-item .fl-name')).map(n => n.textContent)`);
  console.log('  [debug14] ord0=' + JSON.stringify(ord0) + ' ord1=' + JSON.stringify(ord1));
  check('row0 moved to the end on immediate drag', ord1[ord1.length - 1] === first0 && ord1[0] !== first0, JSON.stringify(ord1));
  check('remaining order preserved', ord1.join(',') === ord0.slice(1).concat(ord0[0]).join(','), JSON.stringify(ord1));
  check('active timeline unchanged after reorder', (await activeId()) === actBefore, String(actBefore) + ' -> ' + (await activeId()));

  console.log('[14b] dragging by the name area reorders; a simple click on the name opens the timeline');
  const ordB0 = await js(`Array.from(document.querySelectorAll('#tl-list .fl-item .fl-name')).map(n => n.textContent)`);
  const firstB = ordB0[0];
  await js(`(() => {
    const rows = document.querySelectorAll('#tl-list .fl-item');
    const name = rows[0].querySelector('.fl-name');
    const nr = name.getBoundingClientRect();
    const sx = nr.left + nr.width / 2, sy = nr.top + nr.height / 2;
    const last = rows[rows.length - 1].getBoundingClientRect();
    const ty = last.bottom - 1;
    name.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx, clientY: sy + 10 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx, clientY: ty }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: sx, clientY: ty }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const ordB1 = await js(`Array.from(document.querySelectorAll('#tl-list .fl-item .fl-name')).map(n => n.textContent)`);
  check('name-area drag moved the row to the end', ordB1[ordB1.length - 1] === firstB && ordB1[0] !== firstB, JSON.stringify(ordB1));
  await js(`(() => { window.__app.__openCalls = []; const o = window.__app.openTimelineById.bind(window.__app); window.__app.openTimelineById = async function(id) { window.__app.__openCalls.push(id); return o(id); }; return true; })()`);
  await js(`window.__app._fileList._suppressClickUntil = 0;`);
  const clickAct = await js(`(() => {
    const rows = document.querySelectorAll('#tl-list .fl-item');
    const name = rows[0].querySelector('.fl-name');
    const nr = name.getBoundingClientRect();
    const sx = nr.left + nr.width / 2, sy = nr.top + nr.height / 2;
    name.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 }));
    name.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 }));
    name.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: sx, clientY: sy }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 2200));
  const tl0Id = await js(`window.__app.state.timelines[0].id`);
  const dbgB = await js(`({ before: window.__app.state.activeTimelineId, row0name: document.querySelector('#tl-list .fl-item .fl-name').textContent, tl0name: window.__app.state.timelines[0].name, tl0id: window.__app.state.timelines[0].id, busy: window.__app._fileList.busy(), openCalls: window.__app.__openCalls, missing: window.__app.state.sourceMissing })`);
  check('simple click on the name opened the timeline', (await activeId()) === tl0Id, String(tl0Id) + ' -> ' + (await activeId()) + ' dbg=' + JSON.stringify(dbgB));

  console.log('[15] Enter triggers the default (primary) button in popup windows');
  await js(`(() => { window.__app.__r15 = null; const p = window.__app.showAlert('Enter should confirm this', { title: 'Test' }); p.then(() => { window.__app.__r15 = 'closed'; }); return true; })()`);
  await new Promise((r) => setTimeout(r, 100));
  check('alert popup open', (await js(`!document.querySelector('#confirm-modal').classList.contains('hidden')`)) === true);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true }));`);
  await new Promise((r) => setTimeout(r, 150));
  check('Enter confirmed the popup (closed)', (await js(`document.querySelector('#confirm-modal').classList.contains('hidden')`)) === true);
  check('alert promise resolved', (await js(`window.__app.__r15`)) === 'closed');
  await js(`(() => { window.__app.__r16 = null; const p = window.__app.confirmDialog('Enter should accept (OK), Escape should cancel', { title: 'Test', okText: 'OK' }); p.then((v) => { window.__app.__r16 = v; }); return true; })()`);
  await new Promise((r) => setTimeout(r, 100));
  check('confirm dialog open', (await js(`!document.querySelector('#confirm-modal').classList.contains('hidden')`)) === true);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true }));`);
  await new Promise((r) => setTimeout(r, 150));
  check('Enter resolved the confirm dialog with ok=true', (await js(`window.__app.__r16`)) === true, String(await js(`window.__app.__r16`)));

  console.log('[16] export project: combine toggle reflects join compatibility');
  await js(`window.__app.state.dirty = false;`);
  await js(`window.__app.handleDroppedFile('${esc(PROJ)}')`);
  await new Promise((r) => setTimeout(r, 1200));
  await js(`window.__app.exportProject()`);
  await new Promise((r) => setTimeout(r, 700));
  const dbg16 = await js(`({ row: document.querySelector('#export-join-row').className, modal: !document.querySelector('#export-settings-modal').classList.contains('hidden'), toggleDisabled: document.querySelector('#export-join-toggle').disabled, sourceMissing: window.__app.state.sourceMissing, n: window.__app.state.timelines.length })`);
  console.log('  [debug16]', JSON.stringify(dbg16));
  check('combine row shown in project export', (await js(`!document.querySelector('#export-join-row').classList.contains('hidden')`)) === true);
  check('combine toggle enabled for compatible timelines', (await js(`!document.querySelector('#export-join-toggle').disabled`)) === true);
  check('no combine reason when available', (await js(`document.querySelector('#export-join-reason').classList.contains('hidden')`)) === true);
  await js(`document.querySelector('#export-settings-cancel').click()`);
  await new Promise((r) => setTimeout(r, 150));
  await js(`window.__app.state.timelines = [window.__app.state.timelines[0]]; window.__app.updateProjectJoinAvailability()`);
  await new Promise((r) => setTimeout(r, 200));
  check('combine toggle disabled with a single timeline', (await js(`document.querySelector('#export-join-toggle').disabled`)) === true);
  const reason16 = await js(`document.querySelector('#export-join-reason').textContent`);
  check('combine reason mentions 2 timelines', /2 timelines/i.test(reason16), reason16);
  check('combine row is dimmed when unavailable', (await js(`document.querySelector('#export-join-label-row').classList.contains('disabled')`)) === true);
  await js(`document.querySelector('#export-settings-cancel').click()`);

  win.destroy();
  clearTimeout(watchdog);
  console.log('\nCONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
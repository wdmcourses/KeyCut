const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');
const { registerIpc } = require('../lib/ipc');

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-test';
const SRC = path.join(DIR, 'test.mp4');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
};

app.whenReady().then(async () => {
  let win;
  registerIpc(() => win, ROOT, path.join(DIR, 'rt_tmp'));
  win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true }
  });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('RENDERER ERR:', m); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => win.webContents.executeJavaScript(c);
  await js(`window.__app.loadSource('${SRC.replace(/\\/g, '\\\\')}')`);
  await new Promise((r) => setTimeout(r, 1200));

  const sendKey = (code, key, shift = false) => js(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${key}', bubbles: true, cancelable: true, ctrlKey: false, shiftKey: ${shift} }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${key}', bubbles: true, cancelable: true, ctrlKey: false, shiftKey: ${shift} }));
    return true;
  })()`);
  const sendHoldStart = (code, key) => js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${key}', bubbles: true, cancelable: true }));`);
  const sendKeyUp = (code, key) => js(`window.dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${key}', bubbles: true, cancelable: true }));`);
  const sendCtrl = (code, key, shift = false) => js(`(() => {
    const ev = new KeyboardEvent('keydown', { code: '${code}', key: '${key}', bubbles: true, cancelable: true, ctrlKey: true, shiftKey: ${shift} });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`);

  const clickAt = (t, y, shift = false, alt = false) => js(`(() => {
    const c = document.querySelector('#timeline');
    const r = c.getBoundingClientRect();
    const x = (${t} - window.__app.timeline.viewStart) * window.__app.timeline.pxPerSec;
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + x, clientY: r.top + ${y}, bubbles: true, cancelable: true, shiftKey: ${shift}, altKey: ${alt} }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return null;
  })()`);

  const keys = await js(`window.__app.state.keyTimes`);
  const DUR = await js(`window.__app.state.duration`);
  const k1 = keys[5], k2 = keys[8], k3 = keys[11];
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

  
  console.log('[0] caret snaps to keyframes');
  await js(`window.__app.seekTo(${k2 + 0.1})`);
  const c0 = await js(`window.__app.state.cursor`);
  check(`seekTo snaps to ${k2}`, near(c0, k2));

  
  console.log('[1] C cuts at keyframe');
  await js(`window.__app.seekTo(${k1})`);
  await sendKey('KeyC', 'c');
  const cuts1 = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  check('C cuts at keyframe -> [0,k1,10]', cuts1.length === 3 && near(cuts1[1], k1));

  
  console.log('[2] click selects segment');
  await clickAt(k2, 48); 
  const sel = await js(`({idx: window.__app.timeline.selectedIndex, cursor: window.__app.state.cursor})`);
  check('selected segment index = 1 ([k1,10])', sel.idx === 1);
  check('cursor snapped to k2', near(sel.cursor, k2));

  
  console.log('[3] X dims the selected segment');
  await sendKey('KeyX', 'x');
  const del1 = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('deleted -> [false,true]', del1.length === 2 && del1[0] === false && del1[1] === true);

  
  console.log('[4] R restores the dimmed segment');
  await sendKey('KeyR', 'r');
  const del2 = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('restored -> [false,false]', del2.length === 2 && del2[0] === false && del2[1] === false);

  
  console.log('[5] undo / redo history');
  await sendCtrl('KeyZ', 'z'); 
  const afterUndo = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('Ctrl+Z undoes restore -> [false,true]', afterUndo[1] === true);
  await sendCtrl('KeyZ', 'z'); 
  const afterUndo2 = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('Ctrl+Z undoes dim -> [false,false]', afterUndo2[1] === false);
  await sendCtrl('KeyZ', 'z', true); 
  const afterRedo = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('Ctrl+Shift+Z redoes -> [false,true]', afterRedo[1] === true);

  
  console.log('[6] S / F keyframe navigation');
  await js(`window.__app.seekTo(0)`);
  await sendKey('KeyF', 'f');
  const fCur = await js(`window.__app.state.cursor`);
  check('F -> next keyframe', near(fCur, keys[1]));
  await sendKey('KeyS', 's');
  const sCur = await js(`window.__app.state.cursor`);
  check('S -> prev keyframe', near(sCur, 0));

  
  console.log('[7] dimmed segments skipped in playback');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut();`); 
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  const g1 = await js(`window.__app.guardTarget(${k2})`);
  check('guard pauses at cut-out tail (from k2)', g1 && g1.type === 'pause' && near(g1.at, k1));
  const g2 = await js(`window.__app.guardTarget(${k1 / 2})`);
  check('guard on kept frame -> null', g2 === null);

  const fk1 = await js(`window.__app.firstKeptTime(${k1 / 2})`);
  check('firstKeptTime in kept stays', near(fk1, k1 / 2));
  const fk2 = await js(`window.__app.firstKeptTime(${k1})`);
  check('firstKeptTime at dimmed start -> 10', near(fk2, DUR));
  const fk3 = await js(`window.__app.firstKeptTime(${(k1 + k2) / 2})`);
  check('firstKeptTime inside dimmed -> 10', near(fk3, DUR));

  
  console.log('[8] Space toggles playback');
  await js(`window.__app.video.pause(); window.__app.scrubEnd(); window.__app.seekTo(${k1 / 2})`);
  await sendKey('Space', ' ');
  const playing = await js(`!window.__app.video.paused`);
  check('video playing after Space (kept area)', playing);
  await sendKey('Space', ' ');
  await js(`window.__app.video.pause(); window.__app.scrubEnd(); window.__app.seekTo(${k1})`);
  await sendKey('Space', ' ');
  const stayedPaused = await js(`window.__app.video.paused`);
  check('Space at cut-out tail does nothing', stayedPaused);

  
  console.log('[9] gray area = single unit');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.seekTo(${(k1 + k2) / 2}); window.__app.deleteSegment();`); 
  const ak = await js(`window.__app.state.activeKeys`);
  const interiorGray = keys.filter((k) => k > k1 && k < k2);
  check('no gray-interior keys in activeKeys', !interiorGray.some((k) => ak.includes(k)));
  check('gray boundaries + ends in activeKeys', ak.includes(k1) && ak.includes(k2) && ak.includes(0) && ak.includes(DUR));
  await js(`window.__app.seekTo(${(k1 + k2) / 2})`);
  const cGray = await js(`window.__app.state.cursor`);
  check('caret in gray snaps to a boundary', near(cGray, k1) || near(cGray, k2));
  await js(`window.__app.seekTo(${k1})`);
  await sendKey('KeyF', 'f');
  const afterF = await js(`window.__app.state.cursor`);
  check('F from gray start jumps straight to gray end', near(afterF, k2));

  
  console.log('[10] scrub blip + drop API');
  await js(`window.__app.scrubEnd(); window.__app.scrubBlip(${k1 / 2})`);
  const blip = await js(`window.__app.lastScrubTime`);
  check('scrub blip recorded on kept keyframe', near(blip, k1 / 2));
  await js(`window.__app.scrubEnd(); window.__app.scrubBlip(${(k1 + k2) / 2})`);
  const blipGray = await js(`window.__app.lastScrubTime`);
  check('no scrub blip in gray area', blipGray < 0);
  const hasDrop = await js(`typeof window.keycut.getFilePath === 'function' && typeof window.keycut.confirmOpen === 'function'`);
  check('drop APIs exposed', hasDrop);
  await js(`window.__app.state.source = null;`);
  await js(`window.__app.handleDroppedFile('${SRC.replace(/\\/g, '\\\\')}')`);
  await new Promise((r) => setTimeout(r, 1200));
  const droppedLoaded = await js(`!!window.__app.state.source`);
  check('dropped file loads', droppedLoaded);

  
  console.log('[11] playback guard');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  const mid = (k1 + k2) / 2;
  const gMid = await js(`window.__app.guardTarget(${mid})`);
  check('guard seeks over mid gray -> k2', gMid && gMid.type === 'seek' && near(gMid.at, k2));
  const gStart = await js(`window.__app.guardTarget(${k1})`);
  check('guard catches gray start boundary -> seek k2', gStart && gStart.type === 'seek' && near(gStart.at, k2));
  const gKept = await js(`window.__app.guardTarget(${k1 / 2})`);
  check('guard keeps kept position -> null', gKept === null);
  
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  const gTail = await js(`window.__app.guardTarget(${mid})`);
  check('guard pauses at cut-out tail -> k1', gTail && gTail.type === 'pause' && near(gTail.at, k1));

  
  console.log('[12] multi-select + merge');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut(); window.__app.seekTo(${k3}); window.__app.cut();`);
  
  await clickAt(k1 / 2, 48);
  const sel0 = await js(`window.__app.timeline.selected`);
  check('click selects single [0,0]', sel0[0] === 0 && sel0[1] === 0);
  await clickAt((k2 + k3) / 2, 48, true); 
  const sel1 = await js(`window.__app.timeline.selected`);
  check('shift+click extends to [0,2]', sel1[0] === 0 && sel1[1] === 2);
  await sendKey('KeyV', 'v');
  const afterU = await js(`({cuts: window.__app.model.cuts, del: window.__app.model.deleted})`);
  check('U merges [0,2] -> cuts [0,k3,10]', afterU.cuts.length === 3 && near(afterU.cuts[1], k3));
  check('merged block kept', afterU.del.every((d) => d === false));

  
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut(); window.__app.seekTo(${k3}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  await clickAt(k1 / 2, 48); 
  await clickAt((k2 + k3) / 2, 48, true); 
  const sGray = await js(`window.__app.timeline.selected`);
  check('selection does not cross gray -> [0,0]', sGray[0] === 0 && sGray[1] === 0);
  const mergeBlocked = await js(`window.__app.model.mergeRange(0, 2)`);
  check('merge blocked across gray', mergeBlocked === false);
  const singleMerge = await js(`window.__app.model.mergeRange(0, 0)`);
  check('merge single block no-op', singleMerge === false);

  
  console.log('[13] smooth caret, cut at nearest keyframe');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.timeline.selectedIndex = null; window.__app.refreshActiveKeys();`);
  const smoothT = k1 + 0.3; 
  await js(`window.__app.video.pause(); window.__app.video.currentTime = ${smoothT};`);
  await js(`window.__app.guardPlayback();`);
  const smoothCur = await js(`window.__app.state.cursor`);
  check('caret stays smooth during playback', near(smoothCur, smoothT));
  await sendKey('KeyC', 'c');
  const nearestKey = keys[6];
  const cCuts = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  check('C cuts at nearest keyframe', cCuts.length === 3 && near(cCuts[1], nearestKey));
  const caretAfter = await js(`window.__app.state.cursor`);
  check('caret moves to the cut keyframe', near(caretAfter, nearestKey));

  
  console.log('[14] extend blue into gray (boundary resize)');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.timeline.selectedIndex = null; window.__app.refreshActiveKeys();`);
  await js(`window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  
  const part = keys[7]; 
  const r1 = await js(`window.__app.model.moveBoundary(1, ${part})`);
  let cuts = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  check('partial extend: boundary moves to key', r1 === 1 && near(cuts[1], part));
  
  const r2 = await js(`window.__app.model.moveBoundary(1, ${k2})`);
  cuts = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  const del = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('full consume: gray gone, kept merged', r2 === 2 && cuts.length === 3 && near(cuts[1], k2) && del.every((d) => d === false));
  
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 0; window.__app.deleteSegment();`); 
  const r3 = await js(`window.__app.model.moveBoundary(1, ${k1 / 2})`);
  cuts = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  check('extend left: boundary moves into gray', r3 === 1 && cuts[1] > 0 && cuts[1] < k1);
  
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  const r4 = await js(`window.__app.model.moveBoundary(1, ${k1 + 0.1})`);
  check('no resize between two kept blocks', r4 === 0);
  
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  const hitK = await js(`(() => {
    const T = window.__app.timeline;
    const px = (${k1} + 0.01 - T.viewStart) * T.pxPerSec;
    return T.resizeBoundaryAt(px);
  })()`);
  check('resize handle detected at kept|gray boundary', hitK === 1);

  
  console.log('[15] shrink blue into gray');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  const shrinkKey = keys[3]; 
  const rShrink = await js(`window.__app.model.moveBoundary(1, ${shrinkKey})`);
  cuts = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  check('shrink blue: boundary moves left into blue', rShrink === 1 && cuts[1] < k1 && cuts[1] > 0);
  
  const rConsume = await js(`window.__app.model.moveBoundary(1, 0)`);
  cuts = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  const dConsume = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('consume blue fully -> merged gray [0,k2]', rConsume === 2 && cuts.length === 3 && near(cuts[1], k2) && dConsume[0] === true);

  
  console.log('[16] scrub stops playback');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.video.pause(); window.__app.scrubEnd(); window.__app.seekTo(${k1 / 2});`);
  await sendKey('Space', ' ');
  const playingBefore = await js(`!window.__app.video.paused`);
  check('video playing', playingBefore);
  await clickAt(k1 / 2, 48); 
  const pausedAfter = await js(`window.__app.video.paused`);
  check('mousedown on timeline pauses playback', pausedAfter);

  
  console.log('[17] skip seek mute');
  await js(`window.__app.video.muted = false;`);
  await js(`window.__app.skipTo(5, false);`);
  const mutedDuring = await js(`window.__app.video.muted`);
  check('muted during skip seek', mutedDuring === true);
  await js(`window.__app.video.dispatchEvent(new Event('seeked'));`);
  const mutedAfter = await js(`window.__app.video.muted`);
  check('unmuted after seeked', mutedAfter === false);

  
  console.log('[18] merge gray blocks');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut(); window.__app.seekTo(${k3}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment(); window.__app.timeline.selectedIndex = 2; window.__app.deleteSegment();`); 
  
  await clickAt((k1 + k2) / 2, 48); 
  await clickAt((k2 + k3) / 2, 48, true); 
  const gSel = await js(`window.__app.timeline.selected`);
  check('gray run multi-select [1,2]', gSel[0] === 1 && gSel[1] === 2);
  await sendKey('KeyV', 'v');
  const gCuts = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  const gDel = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('U merges gray [1,2] -> cuts [0,k1,k3,10] gray', gCuts.length === 4 && near(gCuts[1], k1) && near(gCuts[2], k3) && gDel[1] === true);

  
  console.log('[19] tap + hold frame navigation');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys(); window.__app.timeline.selectedIndex = null;`);
  await js(`window.__app.video.pause(); window.__app.scrubEnd(); window.__app.cancelStepPause(); window.__app.seekTo(2.5);`);
  await sendKey('Space', ' '); 
  const playing1 = await js(`!window.__app.video.paused`);
  check('playing before tap', playing1);
  
  await sendKey('KeyS', 's');
  const tap1 = await js(`({paused: window.__app.video.paused, cur: window.__app.state.cursor})`);
  check('tap S pauses + steps back to 2.0', tap1.paused === true && near(tap1.cur, 2.0));
  await new Promise((r) => setTimeout(r, 500));
  const tap2 = await js(`!window.__app.video.paused`);
  check('tap S resumes after ~200ms', tap2);
  
  await js(`window.__app.video.pause(); window.__app.scrubEnd(); window.__app.cancelStepPause(); window.__app.seekTo(5);`);
  await sendKey('Space', ' ');
  await sendHoldStart('KeyS');
  await new Promise((r) => setTimeout(r, 700)); 
  const holdCur = await js(`window.__app.state.cursor`);
  check('hold S scans backward (cursor < 5)', holdCur < 5);
  const holdPaused = await js(`window.__app.video.paused`);
  check('hold S keeps video paused while scanning', holdPaused === true);
  const blipDuring = await js(`window.__app.lastScrubTime`);
  check('scan plays short audio blips', blipDuring >= 0);
  const resumedState = await js(`(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyS', key: 's', bubbles: true, cancelable: true }));
    return { cur: window.__app.state.cursor, playing: !window.__app.video.paused };
  })()`);
  const curIsKey = keys.some((k) => Math.abs(k - resumedState.cur) < 1e-6);
  check('release resumes from keyframe start', curIsKey);
  check('release resumes playback', resumedState.playing);
  
  await js(`window.__app.video.pause(); window.__app.scrubEnd(); window.__app.cancelStepPause(); window.__app.seekTo(1);`);
  await sendHoldStart('KeyF');
  await new Promise((r) => setTimeout(r, 600));
  const fHoldCur = await js(`window.__app.state.cursor`);
  check('hold F scans forward (cursor > 1)', fHoldCur > 1);
  await sendKeyUp('KeyF');
  const fStillPaused = await js(`window.__app.video.paused`);
  check('hold F (paused mode) does not resume', fStillPaused === true);
  await js(`window.__app.video.pause(); window.__app.cancelStepPause();`);

  
  console.log('[20] playhead stays in frame');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys(); window.__app.timeline.selectedIndex = null;`);
  await js(`window.__app.timeline.pxPerSec = 1000; window.__app.timeline.clampView(); window.__app.timeline.needsRender = true; window.__app.timeline.tick();`);
  const v0 = await js(`({start: window.__app.timeline.viewStart, w: window.__app.timeline.w / window.__app.timeline.pxPerSec})`);
  const farT = v0.start + v0.w + 0.5; 
  await js(`window.__app.state.cursor = ${farT}; window.__app.timeline.cursor = ${farT}; window.__app.ensureCursorVisible();`);
  const v1 = await js(`({start: window.__app.timeline.viewStart, end: window.__app.timeline.viewStart + window.__app.timeline.w / window.__app.timeline.pxPerSec})`);
  check('pan to keep playhead in view (right)', farT >= v1.start && farT <= v1.end);
  const ppsAfter = await js(`window.__app.timeline.pxPerSec`);
  check('zoom unchanged by auto-pan', Math.abs(ppsAfter - 1000) < 1e-9);
  const backT = v1.start - 0.5; 
  await js(`window.__app.state.cursor = ${backT}; window.__app.timeline.cursor = ${backT}; window.__app.ensureCursorVisible();`);
  const v2 = await js(`({start: window.__app.timeline.viewStart, end: window.__app.timeline.viewStart + window.__app.timeline.w / window.__app.timeline.pxPerSec})`);
  check('pan to keep playhead in view (left)', backT >= v2.start && backT <= v2.end);

  
  console.log('[21] firstKeptTime across a gray run');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut(); window.__app.seekTo(${k3}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  await js(`window.__app.timeline.selectedIndex = 2; window.__app.deleteSegment();`); 
  const fkRun = await js(`window.__app.firstKeptTime(${k1})`);
  check('firstKeptTime jumps the whole gray run -> k3', near(fkRun, k3));

  
  console.log('[22] exact boundary semantics');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  const justBefore = await js(`window.__app.guardTarget(${k1} - 0.001)`);
  check('no early skip inside kept tail', justBefore === null);
  const atBoundary = await js(`window.__app.guardTarget(${k1})`);
  check('guard fires exactly at the gray boundary -> seek k2', atBoundary && atBoundary.type === 'seek' && near(atBoundary.at, k2));
  const atGray = await js(`window.__app.guardTarget(${k1} + 0.001)`);
  check('guard fires inside gray too', atGray && atGray.type === 'seek' && near(atGray.at, k2));

  
  console.log('[23] skipTo mute robustness');
  await js(`window.__app.video.muted = false; window.__app.cancelSkipMute();`);
  await js(`window.__app.skipTo(5, false);`);
  await js(`window.__app.skipTo(6, false);`); 
  const mutedMid = await js(`window.__app.video.muted`);
  check('muted during overlapping skip', mutedMid === true);
  await js(`window.__app.video.dispatchEvent(new Event('seeked'));`);
  const mutedEnd = await js(`window.__app.video.muted`);
  check('unmuted after overlapping skips', mutedEnd === false);
  await js(`window.__app.video.muted = false; window.__app.cancelSkipMute(); window.__app.skipTo(5, false);`);
  await js(`window.__app.cancelSkipMute();`);
  check('cancelSkipMute restores mute', (await js(`window.__app.video.muted`)) === false);

  
  console.log('[24] transport + block navigation');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut(); window.__app.seekTo(${k3}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  await js(`window.__app.seekTo(0);`);
  await js(`window.__app.nextBlock();`);
  const nb = await js(`window.__app.state.cursor`);
  check('next block -> start of [k2,end]', near(nb, k2));
  await js(`window.__app.prevBlock();`);
  const pb = await js(`window.__app.state.cursor`);
  check('prev block -> start of [0,k1]', near(pb, 0));
  await js(`window.__app.navPause(() => window.__app.seekTo(${DUR}));`);
  const endCur = await js(`window.__app.state.cursor`);
  check('end of project -> DUR', near(endCur, DUR));
  await js(`window.__app.seekTo(0);`);
  const startCur = await js(`window.__app.state.cursor`);
  check('start of project -> 0', near(startCur, 0));

  
  
  
  console.log('[25] gray skip -> exact kept start');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys();`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  await js(`window.__app.video.pause(); window.__app.cancelSkipMute(); window.__app.video.muted = false;`);
  await js(`window.__app.video.currentTime = ${k1} + 0.5; window.__app.guardPlayback();`);
  const afterSkip = await js(`window.__app.video.currentTime`);
  check('skip lands at kept start (k2)', near(afterSkip, k2));
  check('not into gray (>= k2)', afterSkip >= k2 - 1e-6);
  check('not skipping ahead (<= k2+2ms)', afterSkip <= k2 + 0.002);
  await js(`window.__app.cancelSkipMute();`);

  
  console.log('[26] Alt+click multi-select');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys(); window.__app.timeline.selectedIndex = null;`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut(); window.__app.seekTo(${k3}); window.__app.cut();`);
  await clickAt((k1 + k2) / 2, 48, false, true); 
  await clickAt((k2 + k3) / 2, 48, false, true); 
  const altSel = JSON.parse(await js(`JSON.stringify([...window.__app.timeline.selectionIndices()].sort((a, b) => a - b))`));
  check('alt+click gathers both segments', altSel.length === 2 && altSel[0] === 1 && altSel[1] === 2);
  await sendKey('KeyX', 'x');
  const delMulti = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('X dims all multi-selected', delMulti[1] === true && delMulti[2] === true && delMulti[0] === false);
  await sendCtrl('KeyZ', 'z');
  const delUndo = JSON.parse(await js(`JSON.stringify(window.__app.model.deleted)`));
  check('undo reverts all dimmed in one step', delUndo[1] === false && delUndo[2] === false);
  await clickAt(k1 + 0.1, 48); 
  const cleared = await js(`window.__app.timeline.selectionIndices().length`);
  check('plain click clears multi-select', cleared === 1);

  
  console.log('[27] resize drag coalesced undo');
  await js(`window.__app.model.reset(${DUR}); window.__app.model.snapshot(); window.__app.refreshActiveKeys(); window.__app.timeline.selectedIndex = null;`);
  await js(`window.__app.timeline.selectedIndex = null; window.__app.seekTo(${k1}); window.__app.cut(); window.__app.seekTo(${k2}); window.__app.cut();`);
  await js(`window.__app.timeline.selectedIndex = 1; window.__app.deleteSegment();`); 
  const hBefore = await js(`window.__app.model.historyIndex`);
  await js(`(() => {
    const T = window.__app.timeline;
    T.model.suppressSnapshot = true;
    T._dragBefore = { cuts: T.model.cuts.slice(), deleted: T.model.deleted.slice() };
    T.resizeTo(2, ${k2} + 0.5);
    T.resizeTo(2, ${k2} + 0.9);
    T.endResizeDrag();
    return true;
  })()`);
  const hAfter = await js(`window.__app.model.historyIndex`);
  check('whole drag = one history entry', hAfter === hBefore + 1);
  const postDragCut = await js(`window.__app.model.cuts[2]`);
  await sendCtrl('KeyZ', 'z');
  const cutsBack = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  check('undo restores pre-drag boundary', near(cutsBack[2], k2));
  await sendCtrl('KeyZ', 'z', true);
  const cutsRedo = JSON.parse(await js(`JSON.stringify(window.__app.model.cuts)`));
  check('redo re-applies the whole drag', near(cutsRedo[2], postDragCut));

  win.destroy();
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail ? 1 : 0);
});
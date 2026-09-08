const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require('../lib/ipc');

const DIR = 'C:/Users/alex/AppData/Local/Temp/opencode/keycut-test';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

app.whenReady().then(async () => {
  let win;
  registerIpc(() => win, ROOT, path.join(DIR, 'rt_tmp'));
  win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const js = (c) => win.webContents.executeJavaScript(c);
  const esc = path.join(DIR, 'test.mp4').replace(/\\/g, '\\\\');
  await js(`window.__app.loadSource('${esc}')`);
  await new Promise((r) => setTimeout(r, 1200));

  console.log('[1] scrollbar');
  const sb = await js(`(() => {
    const T = window.__app.timeline;
    const barW = document.querySelector('#timeline-scrollbar').clientWidth;
    const thumbW = parseFloat(document.querySelector('#scrollbar-thumb').style.width);
    T.zoomAt(100, 10);
    const thumbW2 = parseFloat(document.querySelector('#scrollbar-thumb').style.width);
    T.fit();
    return { barW, thumbW, thumbW2 };
  })()`);
  check('thumb shrinks when zoomed in', sb.thumbW2 < sb.thumbW);

  console.log('[2] wheel scrolls, ctrl+wheel zooms');
  const wheel = await js(`(() => {
    const T = window.__app.timeline;
    const c = document.querySelector('#timeline');
    const r = c.getBoundingClientRect();
    T.zoomAt(100, 8);
    const before = T.viewStart;
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: r.left + 100, clientY: r.top + 10, bubbles: true, cancelable: true }));
    const after = T.viewStart;
    const viewW = T.w / T.pxPerSec;
    const ppsBefore = T.pxPerSec;
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, ctrlKey: true, clientX: r.left + 100, clientY: r.top + 10, bubbles: true, cancelable: true }));
    const ppsAfter = T.pxPerSec;
    return { before, after, viewW, ppsBefore, ppsAfter };
  })()`);
  check('wheel pans (viewStart changed)', wheel.after > wheel.before);
  check('one notch moves ~12% of view (not whole video)', Math.abs(wheel.after - wheel.before) < wheel.viewW * 0.2);
  check('ctrl+wheel zooms (pxPerSec changed)', wheel.ppsAfter > wheel.ppsBefore);

  console.log('[3] scrollbar drag repositions view');
  const drag = await js(`(() => {
    const T = window.__app.timeline;
    const bar = document.querySelector('#timeline-scrollbar');
    const br = bar.getBoundingClientRect();
    T.zoomAt(100, 20);
    const mid = br.left + br.width * 0.7;
    bar.dispatchEvent(new MouseEvent('mousedown', { clientX: mid, clientY: br.top + 8, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: mid + 40, clientY: br.top + 8, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return T.viewStart;
  })()`);
  check('scrollbar drag moves viewStart', drag > 0);

  console.log('[4] scrollbar carets resize (zoom)');
  const caret = await js(`(() => {
    const T = window.__app.timeline;
    const bar = document.querySelector('#timeline-scrollbar');
    const barW = bar.clientWidth;
    const br = bar.getBoundingClientRect();
    T.pxPerSec = 500;
    T.clampView(); T.updateScrollbar();
    const left = T.scrollLeftPx(barW);
    const ppsBefore = T.pxPerSec;
    const vsBefore = T.viewStart;
    bar.dispatchEvent(new MouseEvent('mousedown', { clientX: br.left + left + 4, clientY: br.top + 10, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: br.left + left + 30, clientY: br.top + 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { ppsBefore, ppsAfter: T.pxPerSec, vsBefore, vsAfter: T.viewStart };
  })()`);
  check('left caret resizes (zoom in)', caret.ppsAfter > caret.ppsBefore);
  check('left caret moves the view start', caret.vsAfter > caret.vsBefore);

  console.log('[5] ctrl+wheel zoom anchors at the pointer');
  const z = await js(`(() => {
    const T = window.__app.timeline;
    T.pxPerSec = 500; T.clampView();
    const tBefore = T.viewStart + 100 / T.pxPerSec;
    T.zoomAt(100, 2.5);
    const tAfter = T.viewStart + 100 / T.pxPerSec;
    return { tBefore, tAfter };
  })()`);
  check('time under pointer preserved on zoom', Math.abs(z.tBefore - z.tAfter) < 1e-6);

  console.log('[6] thumb stays inside the track with min width at extreme zoom');
  const edge = await js(`(() => {
    const T = window.__app.timeline;
    const bar = document.querySelector('#timeline-scrollbar');
    const barW = bar.clientWidth;
    const barRect = bar.getBoundingClientRect();
    T.setZoom(20000);
    T.viewStart = T.duration - T.minViewW();
    T.clampView(); T.updateScrollbar();
    const thumb = document.querySelector('#scrollbar-thumb');
    const hL = document.querySelector('#scrollbar-handle-l');
    const hR = document.querySelector('#scrollbar-handle-r');
    const tRect = thumb.getBoundingClientRect();
    const lRect = hL.getBoundingClientRect();
    const rRect = hR.getBoundingClientRect();
    return {
      barW,
      thumbLeft: tRect.left - barRect.left,
      thumbRight: tRect.right - barRect.left,
      earL: lRect.left - barRect.left,
      earR: rRect.right - barRect.left,
      naturalL: T.scrollLeftPx(barW),
      naturalR: T.scrollRightPx(barW),
      tw: tRect.width
    };
  })()`);
  check('no horizontal overflow (thumb right edge <= barW)', edge.thumbRight <= edge.barW + 0.01);
  check('thumb stays inside the track (left edge >= 0)', edge.thumbLeft >= -0.01);
  check('thumb is at least the min width (100px)', edge.tw >= 100 - 0.01);
  check('left ear sits on the true window start', Math.abs(edge.earL - edge.naturalL) < 1.5);
  check('right ear sits on the true time end', Math.abs(edge.earR - edge.naturalR) < 1.5);

  console.log('[7] ear drag still resizes when the thumb is at min width');
  const earDrag = await js(`(() => {
    const T = window.__app.timeline;
    const bar = document.querySelector('#timeline-scrollbar');
    const br = bar.getBoundingClientRect();
    const barW = bar.clientWidth;
    T.setZoom(2000);
    T.viewStart = 3;
    T.clampView(); T.updateScrollbar();
    const naturalR = T.scrollRightPx(barW);
    const vEndBefore = T.viewEnd();
    const ppsBefore = T.pxPerSec;
    bar.dispatchEvent(new MouseEvent('mousedown', { clientX: br.left + naturalR, clientY: br.top + 10, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: br.left + naturalR + 40, clientY: br.top + 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { vEndBefore, vEndAfter: T.viewEnd(), ppsBefore, pps: T.pxPerSec };
  })()`);
  check('right ear drag outward extends viewEnd', earDrag.vEndAfter > earDrag.vEndBefore);
  check('right ear drag outward zooms out (pxPerSec down)', earDrag.pps < earDrag.ppsBefore);

  win.destroy();
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail ? 1 : 0);
});
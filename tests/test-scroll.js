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
    T.zoomAt(100, 10); // zoom in
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
    T.zoomAt(100, 8); // zoom in so there is room to scroll
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
    T.zoomAt(100, 20); // zoom in so there is room to scroll
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
    T.pxPerSec = 500; // moderate zoom - plenty of room to zoom in further
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

  win.destroy();
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail ? 1 : 0);
});
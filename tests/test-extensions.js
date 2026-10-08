const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const { registerIpc } = require(path.join(ROOT, 'lib', 'ipc'));
const { listExtensions, resolveTools } = require(path.join(ROOT, 'lib', 'extensions'));
const { saveProject, loadProject } = require(path.join(ROOT, 'lib', 'project'));

const WORK = path.join(os.tmpdir(), 'keycut-ext-test');
const FAKE_ROOT = path.join(WORK, 'app');
const EXT = path.join(FAKE_ROOT, 'resources', 'lossless-debreath');

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

function installFake() {
  fs.mkdirSync(path.join(EXT, 'python'), { recursive: true });
  fs.writeFileSync(path.join(EXT, 'debreath.py'), '');
  fs.writeFileSync(path.join(EXT, 'python', 'python.exe'), '');
}
function uninstallFake() {
  fs.rmSync(path.join(EXT, 'python'), { recursive: true, force: true });
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('\nTEST TIMEOUT'); app.exit(1); }, 60000);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  app.setPath('userData', path.join(WORK, 'userData'));

  console.log('[1] registry (installed)');
  installFake();
  const list = listExtensions(FAKE_ROOT);
  check('lists one extension', list.length === 1 && list[0].id === 'lossless-debreath', JSON.stringify(list));
  check('installed true', list[0].installed === true);
  check('available true', list[0].available === true);
  check('option schema exposed', list[0].options.length === 1 && list[0].options[0].key === 'gain' && list[0].options[0].choices.join() === '15,30,45,60' && list[0].options[0].default === 30, JSON.stringify(list[0].options));

  console.log('[2] resolveTools builds cmd/env/args from options');
  const tools = resolveTools(FAKE_ROOT, [{ id: 'lossless-debreath', options: { gain: 45 } }]);
  check('one tool resolved', tools.length === 1);
  check('cmd uses bundled python', tools[0].cmd[0] === path.join(EXT, 'python', 'python.exe'), tools[0].cmd[0]);
  check('cmd entry is debreath.py', tools[0].cmd[1] === path.join(EXT, 'debreath.py'));
  check('env suppresses bytecode cache', tools[0].env && tools[0].env.PYTHONDONTWRITEBYTECODE === '1');
  check('env unbuffers stdout for live progress', tools[0].env && tools[0].env.PYTHONUNBUFFERED === '1');
  check('args carry gain (-l 45)', JSON.stringify(tools[0].args) === JSON.stringify(['-l', '45']), JSON.stringify(tools[0].args));
  const dflt = resolveTools(FAKE_ROOT, [{ id: 'lossless-debreath', options: {} }]);
  check('default gain 30', JSON.stringify(dflt[0].args) === JSON.stringify(['-l', '30']), JSON.stringify(dflt[0].args));
  const legacy = resolveTools(FAKE_ROOT, ['lossless-debreath']);
  check('legacy id-only form works', legacy.length === 1 && JSON.stringify(legacy[0].args) === JSON.stringify(['-l', '30']));

  console.log('[3] registry (not installed)');
  uninstallFake();
  const list2 = listExtensions(FAKE_ROOT);
  check('installed false without bundled runtime', list2[0].installed === false);
  check('resolveTools empty when not installed', resolveTools(FAKE_ROOT, ['lossless-debreath']).length === 0);
  installFake();

  const errors = [];
  let win;
  registerIpc(() => win, FAKE_ROOT, path.join(WORK, 'rt_tmp'));
  ipcMain.handle('get-open-file', () => null);
  win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));
  const js = (c) => win.webContents.executeJavaScript(c);

  console.log('[4] IPC ext:list');
  const ipcList = await js('window.keycut.extList()');
  check('ipc returns installed extension', Array.isArray(ipcList) && ipcList[0].installed === true);

  console.log('[5] Additional tab UI (installed -> switch + options)');
  await js('window.__app.openExportSettings()');
  await js("window.__app.switchExportTab('additional')");
  await new Promise((r) => setTimeout(r, 400));
  const ui = await js(`(() => {
    const box = document.querySelector('#export-extra-list .ext-item');
    return {
      activeTab: document.querySelector('#export-settings-tabs .tab.active').dataset.tab,
      hasSwitch: !!box.querySelector('.switch input'),
      hasDownload: !!box.querySelector('.btn--download'),
      label: box.querySelector('.switch-label').textContent,
      choices: [...box.querySelectorAll('.ext-opt-choice')].map((b) => b.textContent),
      active: box.querySelector('.ext-opt-choice.btn--primary')?.textContent,
      open: box.classList.contains('open'),
      enabled: window.__app.state.exportSettings.extensions
    };
  })()`);
  check('additional tab active', ui.activeTab === 'additional');
  check('switch shown, no download', ui.hasSwitch && !ui.hasDownload, JSON.stringify(ui));
  check('label correct', ui.label === 'Lossless DeBreath');
  check('four gain choices with unit', JSON.stringify(ui.choices) === JSON.stringify(['15 dB', '30 dB', '45 dB', '60 dB']), JSON.stringify(ui.choices));
  check('default 30 active', ui.active === '30 dB');
  check('options panel closed while off', ui.open === false);
  check('disabled by default', ui.enabled.length === 0);

  await js(`document.querySelector('#export-extra-list .ext-item .switch input').click()`);
  await new Promise((r) => setTimeout(r, 120));
  const on = await js(`(() => {
    const box = document.querySelector('#export-extra-list .ext-item');
    return { open: box.classList.contains('open'), maxH: getComputedStyle(box.querySelector('.ext-options')).maxHeight, enabled: window.__app.state.exportSettings.extensions };
  })()`);
  check('enabling opens options panel', on.open === true && on.maxH === '220px', JSON.stringify(on));
  check('enabled id stored', JSON.stringify(on.enabled) === JSON.stringify(['lossless-debreath']));

  await js(`(() => { for (const b of document.querySelectorAll('#export-extra-list .ext-opt-choice')) if (b.dataset.val === '45') b.click(); })()`);
  await new Promise((r) => setTimeout(r, 80));
  const chosen = await js(`(() => {
    const box = document.querySelector('#export-extra-list .ext-item');
    return { active: box.querySelector('.ext-opt-choice.btn--primary').textContent, opts: window.__app.state.exportSettings.extensionOptions, tools: window.__app.exportTools() };
  })()`);
  check('choice 45 becomes active', chosen.active === '45 dB');
  check('option persisted in state', chosen.opts && chosen.opts['lossless-debreath'] && chosen.opts['lossless-debreath'].gain === 45, JSON.stringify(chosen.opts));
  check('exportTools carries options', chosen.tools.length === 1 && chosen.tools[0].id === 'lossless-debreath' && chosen.tools[0].options.gain === 45, JSON.stringify(chosen.tools));

  await js("window.__app.state.exportSettings.extensions = ['lossless-debreath', 'ghost']");
  const active = await js('window.__app.activeExtensionIds()');
  check('activeExtensionIds drops non-installed ids', JSON.stringify(active) === JSON.stringify(['lossless-debreath']), JSON.stringify(active));

  console.log('[6] not installed -> Download button, no switch');
  uninstallFake();
  await js('window.__app.renderExportExtra()');
  await new Promise((r) => setTimeout(r, 150));
  const ui2 = await js(`(() => {
    const box = document.querySelector('#export-extra-list .ext-item');
    const btn = box.querySelector('.btn--download');
    return { hasSwitch: !!box.querySelector('.switch input'), hasDownload: !!btn, text: btn ? btn.textContent : null };
  })()`);
  check('download button shown', ui2.hasDownload && !ui2.hasSwitch, JSON.stringify(ui2));
  check('download label', ui2.text === 'Download', ui2.text);

  console.log('[7] project persistence (ext/extopt round-trip)');
  const projPath = path.join(WORK, 'p.kc');
  const tl = { id: 1, name: 'a.mp4', src: 'C:/x/a.mp4', video: { dur: 3, w: 320, h: 180, fps: 25, size: 1 }, cursor: 0, zoom: 0, viewStart: 0, cuts: [0, 3], deleted: [], markers: [], keyTimes: [], streams: [], pcmAudio: false, videoTimebase: null, hasThumbnail: false, compatNeeded: false };
  await saveProject(projPath, {
    activeId: 1,
    exportSettings: { compress: false, resolution: 'origin', quality: 'low', blocks: false, gpu: true, extensions: ['lossless-debreath'], extensionOptions: { 'lossless-debreath': { gain: 45 } } },
    timelines: [tl]
  });
  const raw = fs.readFileSync(projPath, 'utf8');
  check('project writes ext attribute', /ext="lossless-debreath"/.test(raw));
  check('project writes extopt attribute', /extopt="lossless-debreath\.gain=45"/.test(raw));
  const loaded = await loadProject(projPath);
  check('project restores extensions', JSON.stringify(loaded.exportSettings.extensions) === JSON.stringify(['lossless-debreath']));
  check('project restores option value as number', loaded.exportSettings.extensionOptions['lossless-debreath'].gain === 45);
  const legacyPath = path.join(WORK, 'legacy.kc');
  fs.writeFileSync(legacyPath, '<?xml version="1.0" encoding="UTF-8"?>\n<keycut ver="2">\n  <export compress="0" res="origin" q="low" blocks="0" gpu="1"/>\n  <timelines active="1">\n    <timeline id="1" name="a.mp4">\n      <src rel="a.mp4">a.mp4</src>\n      <video dur="3.000000" w="320" h="180" fps="25.000000" size="1"/>\n      <view cursor="0.000000" zoom="0.000000" start="0.000000"/>\n      <cuts><c t="0.000000"/><c t="3.000000"/></cuts>\n      <markers></markers>\n    </timeline>\n  </timelines>\n</keycut>', 'utf8');
  const legacyProj = await loadProject(legacyPath);
  check('legacy project -> no extensions', legacyProj.exportSettings.extensions.length === 0 && Object.keys(legacyProj.exportSettings.extensionOptions).length === 0);

  console.log('[8] portable fallback: userData/extensions when resources is absent');
  const udExt = path.join(WORK, 'userData', 'extensions', 'lossless-debreath');
  fs.rmSync(path.join(FAKE_ROOT, 'resources'), { recursive: true, force: true });
  fs.mkdirSync(path.join(udExt, 'python'), { recursive: true });
  fs.writeFileSync(path.join(udExt, 'debreath.py'), '');
  fs.writeFileSync(path.join(udExt, 'python', 'python.exe'), '');
  check('found in userData when resources empty', listExtensions(FAKE_ROOT)[0].installed === true);
  const toolsFb = resolveTools(FAKE_ROOT, ['lossless-debreath']);
  check('cmd resolved from userData', toolsFb.length === 1 && toolsFb[0].cmd[0] === path.join(udExt, 'python', 'python.exe'), toolsFb[0] && toolsFb[0].cmd[0]);
  installFake();
  const both = resolveTools(FAKE_ROOT, ['lossless-debreath']);
  check('resources takes precedence over userData', both.length === 1 && both[0].cmd[0] === path.join(EXT, 'python', 'python.exe'), both[0] && both[0].cmd[0]);

  console.log('[9] export done state (reuses the export window)');
  await js("window.__app.prepareExportModal(); document.getElementById('export-modal').classList.remove('hidden'); document.getElementById('export-modal-title').textContent = 'Export';");
  await js("window.__app.showExportDone('/tmp/out.mp4')");
  await new Promise((r) => setTimeout(r, 100));
  const sm = await js(`(() => {
    const m = document.getElementById('export-modal');
    const done = document.getElementById('export-done');
    return {
      modalVisible: !m.classList.contains('hidden'),
      title: document.getElementById('export-modal-title').textContent,
      doneVisible: !done.classList.contains('hidden'),
      successTitle: done.querySelector('.success-title').textContent,
      detail: document.getElementById('export-done-detail').textContent,
      hasIcon: !!done.querySelector('.success-icon svg'),
      barHidden: document.getElementById('export-modal-bar').classList.contains('hidden'),
      closeClass: document.getElementById('export-done-close').className,
      closeVisible: document.getElementById('export-done-close').style.display !== 'none'
    };
  })()`);
  check('export window reused with its title', sm.modalVisible && sm.title === 'Export');
  check('done block visible', sm.doneVisible === true);
  check('done title text', sm.successTitle === 'All operations completed');
  check('done detail shows path', sm.detail === '/tmp/out.mp4');
  check('green icon svg present', sm.hasIcon === true);
  check('progress bar hidden in done state', sm.barHidden === true);
  check('close button is standard, not green', sm.closeClass.includes('btn--sm') && !sm.closeClass.includes('success'), sm.closeClass);
  check('close button visible', sm.closeVisible === true);
  await js('window.__app.closeExportDone()');
  check('export window closed', (await js("document.getElementById('export-modal').classList.contains('hidden')")) === true);

  win.destroy();
  clearTimeout(watchdog);
  console.log('\nCONSOLE ERRORS:', errors.length ? errors.join('\n') : '(none)');
  console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
  app.exit(fail || errors.length ? 1 : 0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });

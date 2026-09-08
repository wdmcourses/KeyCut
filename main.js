const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerIpc } = require('./lib/ipc');

const APP_ROOT = path.join(__dirname);
const TMP_DIR = path.join(APP_ROOT, 'tmp');

// Portable: keep all app state inside the app folder when it is writable,
// so nothing leaks into %APPDATA% (Chromium user data, caches).
try {
  const userDataDir = path.join(APP_ROOT, 'userData');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.accessSync(userDataDir, fs.constants.W_OK);
  app.setPath('userData', userDataDir);
  fs.mkdirSync(path.join(userDataDir, 'Cache'), { recursive: true });
} catch {
  // app folder not writable (e.g. Program Files) - fall back to OS default
}

let mainWindow = null;
let pendingOpenFile = null;
let forceClose = false;

// Find a real file path among the launch arguments (the OS passes the opened
// file here, e.g. "KeyCut.exe C:\path\project.kc").
function findFileArg(argv) {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') || a === '.') continue;
    try {
      if (fs.statSync(a).isFile()) return a;
    } catch {
      // not a path / doesn't exist
    }
  }
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#15171a',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // No application menu: Alt must not open the menu bar (Alt+click is used for
  // multi-selection in the editor).
  mainWindow.removeMenu();
  // Ask the renderer before closing: it may have unsaved edits. The renderer
  // calls back with app:force-close once the user decides to discard/save.
  mainWindow.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:request-close');
  });
}

ipcMain.on('app:force-close', () => {
  forceClose = true;
  if (mainWindow) mainWindow.close();
});

// Single instance: a second launch (e.g. "Open with") forwards its file to the
// running window instead of starting a duplicate.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = findFileArg(argv);
    if (file && mainWindow) mainWindow.webContents.send('app:open-file', file);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  pendingOpenFile = findFileArg(process.argv);
  ipcMain.handle('get-open-file', () => {
    const f = pendingOpenFile;
    pendingOpenFile = null;
    return f;
  });
  registerIpc(() => mainWindow, APP_ROOT, TMP_DIR);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
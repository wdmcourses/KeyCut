const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { registerIpc } = require('./lib/ipc');

const APP_ROOT = path.join(__dirname);
const TMP_DIR = path.join(APP_ROOT, 'tmp');



try {
  const userDataDir = path.join(APP_ROOT, 'userData');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.accessSync(userDataDir, fs.constants.W_OK);
  app.setPath('userData', userDataDir);
  fs.mkdirSync(path.join(userDataDir, 'Cache'), { recursive: true });
} catch {
  
}

let mainWindow = null;
let pendingOpenFile = null;
let forceClose = false;
let lockProc = null;

function lockSource(filePath) {
  if (lockProc) {
    try { lockProc.kill(); } catch {}
    lockProc = null;
  }
  if (!filePath) return;
  const p = filePath.replace(/'/g, "''");
  const script = "$share = [IO.FileShare]::Read; $share = $share -bor [IO.FileShare]::Write; try { $fs = New-Object IO.FileStream('" + p + "', [IO.FileMode]::Open, [IO.FileAccess]::Read, $share); while ($true) { Start-Sleep -Seconds 3600 } } catch {}";
  lockProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore', windowsHide: true });
}



function findFileArg(argv) {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') || a === '.') continue;
    try {
      if (fs.statSync(a).isFile()) return a;
    } catch {
      
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
  
  
  mainWindow.removeMenu();
  
  
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
  ipcMain.handle('source:lock', (_e, filePath) => {
    lockSource(filePath);
  });
  registerIpc(() => mainWindow, APP_ROOT, TMP_DIR);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  if (lockProc) {
    try { lockProc.kill(); } catch {}
    lockProc = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
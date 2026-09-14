const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerIpc } = require('./lib/ipc');

const APP_ROOT = path.join(__dirname);
const TMP_DIR = path.join(app.getPath('temp'), 'keycut');



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

const MIN_WIN_W = 900;
const MIN_WIN_H = 560;
const MAX_PREVIEW_W = 2560;
const MAX_PREVIEW_H = 1440;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: MIN_WIN_W,
    height: MIN_WIN_H,
    minWidth: MIN_WIN_W,
    minHeight: MIN_WIN_H,
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



app.whenReady().then(() => {
  pendingOpenFile = findFileArg(process.argv);
  ipcMain.handle('get-open-file', () => {
    const f = pendingOpenFile;
    pendingOpenFile = null;
    return f;
  });
  ipcMain.handle('file:renameLocked', async (_e, { oldPath, newPath }) => {
    if (!oldPath || !newPath) return { ok: false, error: 'Missing path' };
    const doRename = async () => {
      if (!fs.existsSync(oldPath)) return { ok: false, error: 'Source file not found' };
      if (fs.existsSync(newPath)) return { ok: false, error: 'Target file already exists' };
      await fs.promises.rename(oldPath, newPath);
      return { ok: true };
    };
    let result;
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = await doRename();
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 4) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    if (!result || !result.ok) {
      const msg = result && result.error ? result.error : (lastErr ? lastErr.message : 'Rename failed');
      return { ok: false, error: msg };
    }
    return { ok: true, path: newPath };
  });
  ipcMain.on('win:set-title', (_e, title) => {
    if (mainWindow) mainWindow.setTitle(String(title || ''));
  });
  ipcMain.handle('file:delete', async (_e, filePath) => {
    if (!filePath) return { ok: false, error: 'Missing path' };
    if (!fs.existsSync(filePath)) return { ok: true, missing: true };
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.promises.unlink(filePath);
        return { ok: true };
      } catch (err) {
        lastErr = err;
        if (attempt < 4) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    return { ok: false, error: lastErr ? lastErr.message : 'Failed to delete file' };
  });
  registerIpc(() => mainWindow, APP_ROOT, TMP_DIR);
  cleanupTmp();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function cleanupTmp() {
  try {
    if (!fs.existsSync(TMP_DIR)) return;
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      for (let i = 0; i < 4; i++) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
          break;
        } catch {
          if (i < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (i + 1));
        }
      }
    }
  } catch {}
}

app.on('will-quit', () => {
  cleanupTmp();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
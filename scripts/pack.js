// Builds a portable, dependency-free app folder: copies the Electron runtime
// plus the app files into ./dist/KeyCut/. Run: node scripts/pack.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'KeyCut');
const APP_DIR = path.join(DIST, 'resources', 'app');
const APP_FILES = ['main.js', 'preload.js', 'package.json', 'lib', 'renderer', 'assets'];

const RCEDIT_URL = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';

function copy(src, dest) {
  if (fs.lstatSync(src).isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) copy(path.join(src, e), path.join(dest, e));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// rcedit replaces the exe icon resource. Download it once into vendor/rcedit/.
async function ensureRcedit() {
  if (process.platform !== 'win32') return null;
  const dir = path.join(ROOT, 'vendor', 'rcedit');
  const exe = path.join(dir, 'rcedit-x64.exe');
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(RCEDIT_URL);
  if (!res.ok) throw new Error('rcedit download failed: HTTP ' + res.status);
  fs.writeFileSync(exe, Buffer.from(await res.arrayBuffer()));
  return exe;
}

async function main() {
  const electronDir = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(electronDir)) {
    console.error('electron dist not found; run npm install first');
    process.exit(1);
  }
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  copy(electronDir, DIST);

  // Bundle a static ffmpeg flat into resources/ (next to app code) so the
  // build is fully standalone - no dependency on system ffmpeg / PATH.
  const ffmpegBin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffmpegSrc = path.join(ROOT, 'vendor', 'ffmpeg', ffmpegBin);
  if (!fs.existsSync(ffmpegSrc)) {
    console.error('Standalone ffmpeg not found: ' + ffmpegSrc);
    console.error('Run `npm run ffmpeg` to download it, then re-run the pack.');
    process.exit(1);
  }
  fs.copyFileSync(ffmpegSrc, path.join(DIST, 'resources', ffmpegBin));

  // Electron loads the application from resources/app (or app.asar) when the
  // binary is launched without an app path argument. default_app.asar is only
  // a fallback when no app is present, so it must be removed here.
  fs.rmSync(path.join(DIST, 'resources', 'default_app.asar'), { force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const f of APP_FILES) copy(path.join(ROOT, f), path.join(APP_DIR, f));

  fs.writeFileSync(path.join(APP_DIR, 'portable.txt'), 'KeyCut portable build\n');

  const exe = path.join(DIST, 'electron.exe');
  const exeName = process.platform === 'win32' ? 'KeyCut.exe' : 'KeyCut';
  if (fs.existsSync(exe)) fs.renameSync(exe, path.join(DIST, exeName));
  const finalExe = path.join(DIST, exeName);

  // Embed the app icon into the executable (Windows).
  const iconIco = path.join(ROOT, 'assets', 'icon.ico');
  if (process.platform === 'win32' && fs.existsSync(iconIco)) {
    try {
      const rcedit = await ensureRcedit();
      if (rcedit) {
        execFileSync(rcedit, [finalExe, '--set-icon', iconIco], { stdio: 'ignore' });
        console.log('App icon embedded into', exeName);
      }
    } catch (err) {
      console.warn('Could not embed the icon (non-fatal):', err.message);
    }
  }

  console.log('Portable build ready at', DIST);
  console.log('Run:', finalExe);
}

main().catch((err) => {
  console.error('pack failed:', err.message);
  process.exit(1);
});
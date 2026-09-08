// Builds portable app bundles for win32 / linux / darwin.
//   node scripts/pack.js                          # current host platform
//   node scripts/pack.js --platform=win32|linux|darwin [--arch=x64|arm64]
// Outputs dist/KeyCut-<platform>-<arch>/ plus a .zip / .tar.gz archive.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_FILES = ['main.js', 'preload.js', 'package.json', 'lib', 'renderer', 'assets'];

const PLATFORMS = {
  win32:  { ffmpegBin: 'ffmpeg.exe', archive: 'zip', bin: 'electron.exe', newBin: 'KeyCut.exe' },
  linux:  { ffmpegBin: 'ffmpeg',     archive: 'tar.gz', bin: 'electron',   newBin: 'KeyCut' },
  darwin: { ffmpegBin: 'ffmpeg',     archive: 'zip' }
};

function target() {
  const pArg = process.argv.find((a) => a.startsWith('--platform='));
  const aArg = process.argv.find((a) => a.startsWith('--arch='));
  const platform = pArg ? pArg.split('=')[1] : process.platform;
  if (!PLATFORMS[platform]) throw new Error('Unknown platform: ' + platform);
  const arch = aArg ? aArg.split('=')[1] : 'x64';
  if (platform === 'win32' && arch !== 'x64') throw new Error('win32 is x64 only');
  return { platform, arch };
}

function copy(src, dest) {
  // cpSync preserves symlinks (verbatimSymlinks) which the macOS .app bundle
  // needs (Framework Versions/Current -> A).
  try {
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    return;
  } catch (e) {
    if (!['EPERM', 'ENOTDIR', 'EINVAL'].includes(e.code)) throw e;
  }
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(fs.readlinkSync(src), dest);
  } else if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) copy(path.join(src, e), path.join(dest, e));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function download(url, outFile) {
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  console.log('Saved', (fs.statSync(outFile).size / 1048576).toFixed(1), 'MB');
}

// Electron runtime for the target platform: reuse the installed one when it
// matches the host, otherwise download the official zip.
// 7-Zip preserves symlinks (needed by the macOS .app bundle); unzip on Windows
// materializes them as plain dirs and breaks the framework links.
function extractZip(zip, out, platform) {
  if (platform === 'darwin') {
    const sevens = [
      'C:/Program Files/7-Zip/7z.exe',
      'C:/Program Files (x86)/7-Zip/7z.exe',
      process.env.ProgramFiles + '/7-Zip/7z.exe'
    ];
    for (const sz of sevens) {
      if (sz && require('fs').existsSync(sz)) {
        // 7z exits non-zero on "dangerous link" warnings but still extracts the
        // bundle with its framework symlinks intact - treat as success.
        try {
          execFileSync(sz, ['x', '-y', '-o' + out, zip], { cwd: ROOT, stdio: 'ignore' });
        } catch {
          /* keep going; marker check decides */
        }
        return;
      }
    }
  }
  // bsdtar can't read zip on Windows; unzip is the fallback.
  execFileSync('unzip', ['-q', path.relative(ROOT, zip), '-d', path.relative(ROOT, out)], { cwd: ROOT, stdio: 'inherit' });
}

async function electronDist(platform, arch) {
  if (platform === process.platform && (arch === 'x64' || arch === process.arch)) {
    const d = path.join(ROOT, 'node_modules', 'electron', 'dist');
    if (fs.existsSync(d)) return d;
  }
  const ver = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  const buildsDir = path.join(ROOT, 'vendor', 'electron-builds');
  const zip = path.join(buildsDir, 'electron-v' + ver + '-' + platform + '-' + arch + '.zip');
  const out = path.join(buildsDir, platform + '-' + arch);
  const marker = platform === 'darwin'
    ? path.join(out, 'Electron.app', 'Contents', 'Info.plist')
    : path.join(out, 'resources');
  // re-extract when missing or incomplete (an earlier failed run may have left
  // an empty dir)
  if (!fs.existsSync(out) || !fs.existsSync(marker)) {
    fs.mkdirSync(buildsDir, { recursive: true });
    if (!fs.existsSync(zip)) {
      await download('https://github.com/electron/electron/releases/download/v' + ver + '/electron-v' + ver + '-' + platform + '-' + arch + '.zip', zip);
    }
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    extractZip(zip, out, platform);
  }
  return out;
}

async function ffmpegFor(platform) {
  const cfg = PLATFORMS[platform];
  const p = path.join(ROOT, 'vendor', 'ffmpeg', platform, cfg.ffmpegBin);
  if (fs.existsSync(p)) return p;
  console.log('Fetching ffmpeg for', platform, '...');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'get-ffmpeg.js'), '--platform=' + platform], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg fetch failed for ' + platform);
  return p;
}

async function main() {
  const { platform, arch } = target();
  const cfg = PLATFORMS[platform];
  const friendly = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform;
  const DIST = path.join(ROOT, 'dist', 'KeyCut-' + friendly + '-' + arch);
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const edist = await electronDist(platform, arch);
  copy(edist, DIST);

  const ffmpeg = await ffmpegFor(platform);
  const exeName = platform === 'darwin' ? 'KeyCut.app' : cfg.newBin;

  // macOS: the electron zip contains Electron.app.
  if (platform === 'darwin') {
    const appIn = path.join(DIST, 'Electron.app');
    const appOut = path.join(DIST, 'KeyCut.app');
    if (!fs.existsSync(appIn)) throw new Error('Electron.app not found in darwin dist');
    fs.renameSync(appIn, appOut);
    const resDir = path.join(appOut, 'Contents', 'Resources');
    fs.rmSync(path.join(resDir, 'default_app.asar'), { force: true });
    fs.mkdirSync(path.join(resDir, 'app'), { recursive: true });
    for (const f of APP_FILES) copy(path.join(ROOT, f), path.join(resDir, 'app', f));
    fs.copyFileSync(ffmpeg, path.join(resDir, cfg.ffmpegBin));
    fs.writeFileSync(path.join(resDir, 'app', 'portable.txt'), 'KeyCut portable build\n');

    // Rename the app binary and patch Info.plist so it shows and runs as KeyCut.
    const macBin = path.join(appOut, 'Contents', 'MacOS', 'Electron');
    const macBinOut = path.join(appOut, 'Contents', 'MacOS', 'KeyCut');
    if (fs.existsSync(macBin) && !fs.existsSync(macBinOut)) fs.renameSync(macBin, macBinOut);
    const plistPath = path.join(appOut, 'Contents', 'Info.plist');
    let plist = fs.readFileSync(plistPath, 'utf8');
    plist = plist
      .replace(/<key>CFBundleExecutable<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleExecutable</key>\n\t<string>KeyCut</string>')
      .replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleName</key>\n\t<string>KeyCut</string>')
      .replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleDisplayName</key>\n\t<string>KeyCut</string>')
      .replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleIdentifier</key>\n\t<string>com.keycut.app</string>');
    fs.writeFileSync(plistPath, plist);
    console.log('macOS app bundle built as KeyCut.app (unsigned; sign/notarize locally for distribution).');
  } else {
    const resDir = path.join(DIST, 'resources');
    fs.rmSync(path.join(resDir, 'default_app.asar'), { force: true });
    fs.mkdirSync(path.join(resDir, 'app'), { recursive: true });
    for (const f of APP_FILES) copy(path.join(ROOT, f), path.join(resDir, 'app', f));
    fs.copyFileSync(ffmpeg, path.join(resDir, cfg.ffmpegBin));
    fs.writeFileSync(path.join(resDir, 'app', 'portable.txt'), 'KeyCut portable build\n');

    const exe = path.join(DIST, cfg.bin);
    if (!fs.existsSync(exe)) throw new Error('Expected binary missing: ' + exe);
    fs.renameSync(exe, path.join(DIST, cfg.newBin));

    if (platform === 'win32') {
      const iconIco = path.join(ROOT, 'assets', 'icon.ico');
      if (fs.existsSync(iconIco)) {
        try {
          const rceditDir = path.join(ROOT, 'vendor', 'rcedit');
          fs.mkdirSync(rceditDir, { recursive: true });
          const rcedit = path.join(rceditDir, 'rcedit-x64.exe');
          if (!fs.existsSync(rcedit)) {
            await download('https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe', rcedit);
          }
          execFileSync(rcedit, [path.join(DIST, cfg.newBin), '--set-icon', iconIco], { stdio: 'ignore' });
          console.log('App icon embedded into', cfg.newBin);
        } catch (err) {
          console.warn('Could not embed the icon (non-fatal):', err.message);
        }
      }
    }
  }

  // archive
  const label = path.basename(DIST);
  const cwd = path.join(ROOT, 'dist');
  if (cfg.archive === 'zip') {
    execFileSync('tar', ['-a', '-c', '-f', label + '.zip', label], { cwd, stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-czf', label + '.tar.gz', label], { cwd, stdio: 'inherit' });
  }

  console.log('Build ready at', DIST);
  console.log('Archive: dist/' + label + '.' + cfg.archive);
}

main().catch((err) => {
  console.error('pack failed:', err.message);
  process.exit(1);
});
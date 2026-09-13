const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const ARCHIVE = path.join(VENDOR, 'vendor.7z');

const PLATFORMS = {
  win32:  { bin: 'ffmpeg.exe', rcedit: true },
  linux:  { bin: 'ffmpeg' },
  darwin: { bin: 'ffmpeg' }
};

function targetPlatform() {
  const arg = process.argv.find((a) => a.startsWith('--platform='));
  if (arg) {
    const p = arg.split('=')[1];
    if (!PLATFORMS[p]) throw new Error('Unknown platform: ' + p + ' (use win32|linux|darwin)');
    return p;
  }
  const p = process.platform;
  if (!PLATFORMS[p]) throw new Error('Unsupported host platform: ' + p);
  return p;
}

function main() {
  const platform = targetPlatform();
  const cfg = PLATFORMS[platform];
  const dest = path.join(VENDOR, 'ffmpeg', platform, cfg.bin);
  const rcedit = path.join(VENDOR, 'rcedit', 'rcedit-x64.exe');
  if (fs.existsSync(dest) && (!cfg.rcedit || fs.existsSync(rcedit))) {
    console.log('binaries already present:', dest);
    return;
  }
  if (!fs.existsSync(ARCHIVE)) throw new Error('vendor/vendor.7z not found');
  const r = spawnSync('7z', ['x', '-y', '-o' + path.relative(ROOT, VENDOR), path.relative(ROOT, ARCHIVE)], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('7z extraction failed for ' + path.relative(ROOT, ARCHIVE));
  if (!fs.existsSync(dest)) throw new Error(dest + ' not found after extraction');
  if (cfg.rcedit && !fs.existsSync(rcedit)) throw new Error(rcedit + ' not found after extraction');
  console.log('Installed from archive:', dest);
}

main();





const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'vendor', 'ffmpeg');
const TMP_ZIP = path.join(ROOT, 'vendor', 'ffmpeg-download.zip');
const TMP_EXTRACT = path.join(ROOT, 'vendor', '.ffmpeg-extract');



const PLATFORMS = {
  win32: {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
    bin: 'ffmpeg.exe', kind: 'zip'
  },
  linux: {
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    bin: 'ffmpeg', kind: 'xz'
  },
  darwin: {
    url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    bin: 'ffmpeg', kind: 'zip'
  }
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

async function download(url, outFile) {
  process.stdout.write('Downloading ' + url + ' ...\n');
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, buf);
  process.stdout.write('Downloaded ' + (buf.length / 1048576).toFixed(1) + ' MB\n');
}

async function main() {
  const platform = targetPlatform();
  const cfg = PLATFORMS[platform];
  const outDir = path.join(OUT_DIR, platform);
  const dest = path.join(outDir, cfg.bin);
  if (fs.existsSync(dest)) {
    console.log('ffmpeg already present:', dest);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  try {
    await download(cfg.url, TMP_ZIP);

    fs.rmSync(TMP_EXTRACT, { recursive: true, force: true });
    fs.mkdirSync(TMP_EXTRACT, { recursive: true });

    let extracted = false;
    try {
      
      
      const args = cfg.kind === 'xz'
        ? ['-xJf', path.relative(ROOT, TMP_ZIP), '-C', path.relative(ROOT, TMP_EXTRACT)]
        : ['-xf', path.relative(ROOT, TMP_ZIP), '-C', path.relative(ROOT, TMP_EXTRACT)];
      execFileSync('tar', args, { cwd: ROOT, stdio: 'ignore' });
      extracted = true;
    } catch {
      try {
        execFileSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive -Path "' + TMP_ZIP + '" -DestinationPath "' + TMP_EXTRACT + '" -Force'], { stdio: 'ignore' });
        extracted = true;
      } catch {
        
      }
    }
    if (!extracted) throw new Error('failed to extract the ffmpeg archive');

    
    const found = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir)) {
        const p = path.join(dir, e);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (e === cfg.bin) found.push(p);
      }
    })(TMP_EXTRACT);

    if (!found.length) throw new Error(cfg.bin + ' not found in the archive');
    fs.copyFileSync(found[0], dest);
    process.stdout.write('Installed ' + dest + '\n');
  } finally {
    fs.rmSync(TMP_ZIP, { force: true });
    fs.rmSync(TMP_EXTRACT, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('get-ffmpeg failed:', err.message);
  process.exit(1);
});
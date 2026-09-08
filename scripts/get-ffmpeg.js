// Downloads a static ffmpeg binary into ./vendor/ffmpeg/ for the current
// platform. The portable build embeds it flat into resources/ (LosslessCut
// style). Run: node scripts/get-ffmpeg.js (npm run ffmpeg)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'vendor', 'ffmpeg');
const TMP_ZIP = path.join(ROOT, 'vendor', 'ffmpeg-download.zip');
const TMP_EXTRACT = path.join(ROOT, 'vendor', '.ffmpeg-extract');

const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const dest = path.join(OUT_DIR, binName);

function downloadUrl() {
  // Windows: BtbN static GPL build on GitHub (reliable CDN). Other platforms
  // are not wired up yet - see below.
  return 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
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
  if (process.platform !== 'win32') {
    console.error(
      'Auto-download is only implemented for Windows for now.\n' +
      'For this platform, drop a static ffmpeg binary at ' + dest + ' and re-run.'
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  try {
    await download(downloadUrl(), TMP_ZIP);

    fs.rmSync(TMP_EXTRACT, { recursive: true, force: true });
    fs.mkdirSync(TMP_EXTRACT, { recursive: true });

    // bsdtar handles zip (Windows 10+ ships tar.exe); fall back to PowerShell.
    let extracted = false;
    try {
      execFileSync('tar', ['-xf', TMP_ZIP, '-C', TMP_EXTRACT], { stdio: 'ignore' });
      extracted = true;
    } catch {
      try {
        execFileSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive -Path "' + TMP_ZIP + '" -DestinationPath "' + TMP_EXTRACT + '" -Force'], { stdio: 'ignore' });
        extracted = true;
      } catch {
        // ignore, checked below
      }
    }
    if (!extracted) throw new Error('failed to extract the ffmpeg archive');

    // locate bin/<binary> inside the extracted tree
    const found = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir)) {
        const p = path.join(dir, e);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (e === binName) found.push(p);
      }
    })(TMP_EXTRACT);

    if (!found.length) throw new Error(binName + ' not found in the archive');
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
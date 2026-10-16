const fs = require('fs');
const path = require('path');

async function removeDir(dir) {
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch {}
    await new Promise((r) => setTimeout(r, 120 * (i + 1)));
  }
  return false;
}

function rmDirSync(dir) {
  for (let i = 0; i < 4; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch {
      if (i < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (i + 1));
    }
  }
  return false;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return !!(err && err.code === 'EPERM'); }
}

function makeScratch(base, prefix) {
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

function cleanupSession(tmpDir, tmpRoot) {
  rmDirSync(tmpDir);
  try {
    if (tmpRoot && fs.existsSync(tmpRoot) && fs.readdirSync(tmpRoot).length === 0) fs.rmdirSync(tmpRoot);
  } catch {}
}

function pruneStale(tmpRoot, ownId) {
  const own = String(ownId);
  try {
    if (!fs.existsSync(tmpRoot)) return;
    for (const name of fs.readdirSync(tmpRoot)) {
      if (name === own) continue;
      if (!/^\d+$/.test(name)) continue;
      if (isPidAlive(Number(name))) continue;
      rmDirSync(path.join(tmpRoot, name));
    }
  } catch {}
}

module.exports = { removeDir, rmDirSync, isPidAlive, makeScratch, cleanupSession, pruneStale };

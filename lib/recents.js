const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_STORED = 5;
const IS_WIN = process.platform === 'win32';

function recentsFile() {
  return path.join(app.getPath('userData'), 'recent.json');
}

function norm(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return IS_WIN ? s.toLowerCase() : s;
}

function readRaw() {
  try {
    const arr = JSON.parse(fs.readFileSync(recentsFile(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeRaw(list) {
  try {
    const file = recentsFile();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {}
}

function recentsList() {
  const list = [];
  for (const r of readRaw()) {
    if (!r || !r.path) continue;
    if (!fs.existsSync(r.path)) continue;
    list.push({ path: r.path, name: r.name || path.basename(r.path), ts: r.ts || 0 });
  }
  return list.slice(0, MAX_STORED);
}

function recentsAdd(filePath) {
  if (!filePath || !/\.kc$/i.test(filePath)) return;
  const key = norm(filePath);
  const list = readRaw().filter((r) => r && r.path && norm(r.path) !== key);
  list.unshift({ path: filePath, name: path.basename(filePath), ts: Date.now() });
  writeRaw(list.slice(0, MAX_STORED));
}

function recentsClear() {
  writeRaw([]);
}

module.exports = { recentsList, recentsAdd, recentsClear };
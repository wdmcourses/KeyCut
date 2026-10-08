const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { extractArchive } = require('./archive');

const USER_AGENT = 'KeyCut';

const REGISTRY = [
  {
    id: 'lossless-debreath',
    label: 'Lossless DeBreath',
    repo: 'wdmcourses/lossless-debreath',
    assets: {
      'win32-x64': 'debreath-win-x64.zip',
      'linux-x64': 'debreath-linux-x64.tar.gz',
      'darwin-arm64': 'debreath-mac-arm64.zip'
    },
    entry: 'debreath.py',
    python: {
      win32: [['python', 'python.exe'], ['python', 'win64', 'python.exe']],
      linux: [['python', 'bin', 'python3'], ['python', 'lin64', 'bin', 'python3']],
      darwin: [['python', 'bin', 'python3'], ['python', 'mac', 'bin', 'python3']]
    },
    args: [],
    options: [
      {
        key: 'gain',
        label: 'Breath reduction',
        type: 'choice',
        default: 60,
        unit: 'dB',
        choices: [20, 40, 60, 80, 100],
        args: (v) => ['-l', String(v)]
      }
    ],
    outputRe: /^output\s*:\s*(.+?)\s*$/m,
    progressMarks: [
      [/detector\s*:/, 0.1, 'Detecting'],
      [/^breaths\s*:/m, 0.5, 'Processing']
    ]
  }
];

function platformKey() {
  return process.platform + '-' + process.arch;
}

function resourcesRoot(appRoot) {
  try {
    if (app && app.isPackaged) return process.resourcesPath;
  } catch {}
  return path.join(appRoot, 'resources');
}

function userExtensionsRoot() {
  return path.join(app.getPath('userData'), 'extensions');
}

function extensionRoots(appRoot) {
  return [resourcesRoot(appRoot), userExtensionsRoot()];
}

function findExtDir(appRoot, id) {
  for (const root of extensionRoots(appRoot)) {
    const dir = path.join(root, id);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function installRoot() {
  const dir = userExtensionsRoot();
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function resolvePython(def, dir) {
  const rels = (def.python && def.python[process.platform]) || [];
  for (const rel of rels) {
    const p = path.join(dir, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isInstalled(appRoot, def) {
  const dir = findExtDir(appRoot, def.id);
  if (!dir) return false;
  if (!fs.existsSync(path.join(dir, def.entry))) return false;
  return !!resolvePython(def, dir);
}

function listExtensions(appRoot) {
  const key = platformKey();
  return REGISTRY.map((def) => ({
    id: def.id,
    label: def.label,
    installed: isInstalled(appRoot, def),
    available: !!def.assets[key],
    options: (def.options || []).map((o) => ({
      key: o.key,
      label: o.label,
      type: o.type,
      unit: o.unit || '',
      default: o.default,
      choices: o.choices || null
    }))
  }));
}

function resolveTools(appRoot, enabled) {
  if (!Array.isArray(enabled) || !enabled.length) return [];
  const out = [];
  for (const item of enabled) {
    const id = typeof item === 'string' ? item : (item && item.id);
    const opts = (item && item.options) || {};
    const def = REGISTRY.find((d) => d.id === id);
    if (!def || !isInstalled(appRoot, def)) continue;
    const dir = findExtDir(appRoot, def.id);
    if (!dir) continue;
    const py = resolvePython(def, dir);
    if (!py) continue;
    const args = [...(def.args || [])];
    for (const opt of (def.options || [])) {
      const v = opts[opt.key] != null ? opts[opt.key] : opt.default;
      if (opt.args) args.push(...opt.args(v));
    }
    out.push({
      id: def.id,
      label: def.label,
      cmd: [py, path.join(dir, def.entry)],
      env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
      args,
      outputRe: def.outputRe || null,
      progressMarks: def.progressMarks || []
    });
  }
  return out;
}

async function downloadBuffer(url, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      received += chunk.length;
      if (onProgress && total) onProgress(Math.min(received / total, 0.99));
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }
  return Buffer.concat(chunks);
}

function ensureExec(dir) {
  if (process.platform === 'win32') return;
  for (const rel of [['python', 'bin'], ['python', 'lin64', 'bin'], ['python', 'mac', 'bin']]) {
    const binDir = path.join(dir, ...rel);
    try {
      for (const name of fs.readdirSync(binDir)) {
        try { fs.chmodSync(path.join(binDir, name), 0o755); } catch {}
      }
    } catch {}
  }
  try { fs.chmodSync(path.join(dir, 'debreath'), 0o755); } catch {}
}

async function downloadExtension(appRoot, id, onProgress) {
  const def = REGISTRY.find((d) => d.id === id);
  if (!def) return { ok: false, error: 'Unknown extension: ' + id };
  const key = platformKey();
  const assetName = def.assets[key];
  if (!assetName) return { ok: false, error: 'No build available for ' + key };

  let release;
  try {
    const res = await fetch('https://api.github.com/repos/' + def.repo + '/releases/latest', {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return { ok: false, error: 'GitHub API error: HTTP ' + res.status };
    release = await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const asset = (release.assets || []).find((a) => a.name === assetName);
  if (!asset) return { ok: false, error: 'Release asset not found: ' + assetName };

  let buf;
  try {
    buf = await downloadBuffer(asset.browser_download_url, onProgress);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const root = installRoot();
  if (!root) return { ok: false, error: 'Install location is not writable' };
  const dest = path.join(root, def.id);
  const tmp = dest + '.tmp-' + Date.now();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    extractArchive(buf, tmp, assetName);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { ok: false, error: err.message };
  }
  ensureExec(dest);
  return { ok: true, version: release.tag_name || null, installed: isInstalled(appRoot, def) };
}

module.exports = { listExtensions, downloadExtension, resolveTools, resourcesRoot, REGISTRY };

const fs = require('fs');
const path = require('path');

const VIDEO_EXT_RE = /\.(mp4|mov|mkv|webm|m4v|avi|ts|mts|m2ts|flv|wmv)$/i;
const MAX_FILES = 5000;
const MAX_DEPTH = 16;

function collectVideos(root, out, depth) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(root, e.name);
    if (e.isDirectory()) collectVideos(full, out, depth + 1);
    else if (e.isFile() && VIDEO_EXT_RE.test(e.name)) out.push(full);
  }
}

function collectDropped(paths) {
  const videos = [];
  const projects = [];
  const folders = [];
  const seen = new Set();
  const addVideo = (p) => {
    const k = p.replace(/\\/g, '/').toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    videos.push(p);
  };
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      folders.push(p);
      const found = [];
      collectVideos(p, found, 0);
      for (const f of found) addVideo(f);
    } else if (/\.kc$/i.test(p)) {
      projects.push(p);
    } else if (VIDEO_EXT_RE.test(p)) {
      addVideo(p);
    }
  }
  return { videos, projects, folders };
}

module.exports = { collectDropped };

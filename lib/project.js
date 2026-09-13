const fs = require('fs');
const path = require('path');

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(6) : '0.000000');

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

function relativeRel(fromFile, toFile) {
  if (!path.isAbsolute(toFile)) return null;
  const r = path.relative(path.dirname(fromFile), toFile);
  if (path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/');
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescape(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attrsOf(s) {
  const attrs = {};
  for (const a of s.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return attrs;
}

function writeTimelineBlock(ws, filePath, tl) {
  const srcRel = relativeRel(filePath, tl.src);
  const v = tl.video || {};
  let srcSize = v.size || 0;
  try {
    const st = fs.statSync(tl.src);
    if (st && st.size) srcSize = st.size;
  } catch {}
  return [
    '    <timeline id="' + tl.id + '" name="' + xmlEscape(String(tl.name || '')) + '"' + (tl.compatNeeded ? ' compat="1"' : '') + '>\n',
    '      <src rel="' + (srcRel || '') + '">' + xmlEscape(basename(tl.src)) + '</src>\n',
    '      <video dur="' + fmt(v.dur) + '" w="' + (v.w || 0) + '" h="' + (v.h || 0) + '" fps="' + fmt(v.fps) + '" size="' + srcSize + '"/>\n',
    '      <view cursor="' + fmt(tl.cursor) + '" zoom="' + fmt(tl.zoom) + '" start="' + fmt(tl.viewStart) + '"/>\n',
    '      <cuts>'
  ].join('');
}

function timelineCutsXml(tl) {
  const cuts = tl.cuts || [];
  const deleted = tl.deleted || [];
  let s = '';
  for (let i = 0; i < cuts.length; i++) {
    const isDeleted = i < deleted.length && deleted[i];
    s += '<c t="' + fmt(cuts[i]) + '"' + (isDeleted ? ' d="1"' : '') + '/>';
  }
  return s;
}

function timelineMarkersXml(tl) {
  let s = '<markers>';
  for (const m of (tl.markers || [])) {
    s += '<m t="' + fmt(m.t) + '" n="' + xmlEscape(String(m.name || '')) + '" c="' + (m.color || '#7bd88f') + '"' + (m.off ? ' o="1"' : '') + '/>';
  }
  s += '</markers>';
  return s;
}

function timelineKeysXml(tl) {
  let s = '<keys>';
  const keys = tl.keyTimes || [];
  for (const k of keys) {
    if (Number.isFinite(k)) s += '<k t="' + fmt(k) + '"/>';
  }
  s += '</keys>';
  return s;
}

function timelineMetaXml(tl) {
  const st = tl.streams || [];
  if (!st.length && !tl.pcmAudio && tl.videoTimebase == null && !tl.hasThumbnail) return '';
  let s = '  <meta' + (tl.pcmAudio ? ' pcm="1"' : '') + (tl.videoTimebase != null ? ' vtb="' + tl.videoTimebase + '"' : '') + (tl.hasThumbnail ? ' thumb="1"' : '') + '>';
  for (const x of st) {
    s += '<stream idx="' + x.index + '" type="' + xmlEscape(String(x.codec_type || '')) + '" codec="' + xmlEscape(String(x.codec_name || '')) + '"' + (x.sample_rate ? ' rate="' + x.sample_rate + '"' : '') + '>' + xmlEscape(String((x.disposition || []).join(','))) + '</stream>';
  }
  s += '</meta>';
  return s;
}

async function saveProject(filePath, data) {
  const ws = fs.createWriteStream(filePath, { encoding: 'utf8' });
  const done = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('finish', resolve);
  });

  async function write(s) {
    if (!ws.write(s)) {
      await new Promise((res) => ws.once('drain', res));
    }
  }

  ws.write('<?xml version="1.0" encoding="UTF-8"?>\n');
  ws.write('<keycut ver="2">\n');
  const ex = data.exportSettings || {};
  ws.write('  <export compress="' + (ex.compress ? '1' : '0') + '" res="' + xmlEscape(String(ex.resolution || 'origin')) + '" blocks="' + (ex.blocks ? '1' : '0') + '"/>\n');
  const wb = data.winBounds || {};
  ws.write('  <window' + (Number.isFinite(wb.x) ? ' x="' + wb.x + '"' : '') + (Number.isFinite(wb.y) ? ' y="' + wb.y + '"' : '') + (Number.isFinite(wb.w) ? ' w="' + wb.w + '"' : '') + (Number.isFinite(wb.h) ? ' h="' + wb.h + '"' : '') + '/>\n');
  ws.write('  <timelines active="' + (data.activeId != null ? data.activeId : '') + '">\n');

  const timelines = data.timelines || [];
  let s = '';
  for (const tl of timelines) {
    s += writeTimelineBlock(ws, filePath, tl);
    if (s.length > 65536) { await write(s); s = ''; }
    s += timelineCutsXml(tl);
    if (s.length > 65536) { await write(s); s = ''; }
    s += '</cuts>\n';
    s += timelineMarkersXml(tl);
    if (s.length > 65536) { await write(s); s = ''; }
    s += '\n';
    s += timelineKeysXml(tl);
    if (s.length > 65536) { await write(s); s = ''; }
    s += '\n';
    s += timelineMetaXml(tl);
    if (s.length > 65536) { await write(s); s = ''; }
    s += '\n    </timeline>\n';
  }
  await write(s);
  ws.write('  </timelines>\n');
  ws.write('</keycut>\n');
  ws.end();
  await done;
}

function parseTimelineBlock(blockText) {
  const result = {
    id: null, name: '', src: null, srcRel: null, srcAbs: null, srcName: null,
    video: null, cuts: [], deleted: [], cursor: 0, zoom: 0, viewStart: 0, markers: [], keyTimes: [],
    streams: [], pcmAudio: false, videoTimebase: null, hasThumbnail: false, compatNeeded: false
  };
  const m = blockText.match(/<timeline\s+([^>]*?)>([\s\S]*?)<\/timeline>/);
  if (!m) return null;
  const attrs = attrsOf(m[1]);
  result.id = attrs.id !== undefined ? parseInt(attrs.id, 10) : null;
  result.name = attrs.name !== undefined ? unescape(attrs.name) : '';
  result.compatNeeded = attrs.compat === '1';
  const inner = m[2];

  const src = inner.match(/<src\s+([^>]*?)>([^<]*)<\/src>/);
  if (src) {
    const sa = attrsOf(src[1]);
    result.srcRel = sa.rel !== undefined ? sa.rel : null;
    result.srcName = src[2] !== undefined ? unescape(src[2]) : null;
  }
  const video = inner.match(/<video\s+([^>]*?)\/>/);
  if (video) {
    const va = attrsOf(video[1]);
    result.video = {
      dur: parseFloat(va.dur),
      w: parseInt(va.w, 10) || 0,
      h: parseInt(va.h, 10) || 0,
      fps: parseFloat(va.fps) || 0,
      size: parseInt(va.size, 10) || 0
    };
  }
  const meta = inner.match(/<meta\s+([^>]*?)>([\s\S]*?)<\/meta>/);
  if (meta) {
    const ma = attrsOf(meta[1]);
    result.pcmAudio = ma.pcm === '1';
    result.videoTimebase = ma.vtb != null && ma.vtb !== '' ? parseInt(ma.vtb, 10) : null;
    result.hasThumbnail = ma.thumb === '1';
    for (const sx of meta[2].matchAll(/<stream\s+([^>]*?)>([^<]*)<\/stream>/g)) {
      const sa = attrsOf(sx[1]);
      const disposition = sx[2] ? unescape(sx[2]).split(',').filter(Boolean) : [];
      result.streams.push({
        index: parseInt(sa.idx, 10) || 0,
        codec_type: unescape(sa.type || ''),
        codec_name: unescape(sa.codec || ''),
        sample_rate: sa.rate != null ? parseInt(sa.rate, 10) : null,
        disposition
      });
    }
  }
  const view = inner.match(/<view\s+([^>]*?)\/>/);
  if (view) {
    const va = attrsOf(view[1]);
    result.cursor = parseFloat(va.cursor) || 0;
    result.zoom = parseFloat(va.zoom) || 0;
    result.viewStart = parseFloat(va.start) || 0;
  }
  for (const c of inner.matchAll(/<c\s+t="([0-9.]+)"(?:\s+d="([01])")?\/>/g)) {
    result.cuts.push(parseFloat(c[1]));
    result.deleted.push(c[2] === '1');
  }
  if (result.deleted.length && result.deleted.length === result.cuts.length) result.deleted.pop();
  for (const mk of inner.matchAll(/<m\s+([^>]*?)\/>/g)) {
    const ma = attrsOf(mk[1]);
    result.markers.push({ t: parseFloat(ma.t) || 0, name: ma.n || '', color: ma.c || '#7bd88f', off: ma.o === '1' });
  }
  for (const k of inner.matchAll(/<k\s+t="([0-9.]+)"\/>/g)) {
    result.keyTimes.push(parseFloat(k[1]));
  }
  result.src = result.srcAbs || result.srcRel;
  if (result.src == null && result.srcName != null) result.src = '';
  return result;
}

async function readProjectXml(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, text) => {
      if (err) return reject(err);
      resolve(text);
    });
  });
}

function parseGlobal(text) {
  const result = { timelines: [], activeId: null, winBounds: null, exportSettings: { compress: false, resolution: 'origin', blocks: false } };
  const exportM = text.match(/<export\s+([^>]*?)\/>/);
  if (exportM) {
    const ea = attrsOf(exportM[1]);
    result.exportSettings = {
      compress: ea.compress === '1',
      resolution: ea.res || 'origin',
      blocks: ea.blocks === '1'
    };
  }
  const winM = text.match(/<window\s+([^>]*?)\/>/);
  if (winM) {
    const wa = attrsOf(winM[1]);
    result.winBounds = {
      x: Number.isFinite(parseFloat(wa.x)) ? parseFloat(wa.x) : undefined,
      y: Number.isFinite(parseFloat(wa.y)) ? parseFloat(wa.y) : undefined,
      w: Number.isFinite(parseFloat(wa.w)) ? parseFloat(wa.w) : undefined,
      h: Number.isFinite(parseFloat(wa.h)) ? parseFloat(wa.h) : undefined
    };
  }
  const tlWrap = text.match(/<timelines\s+([^>]*?)>([\s\S]*?)<\/timelines>/);
  if (tlWrap) {
    const ta = attrsOf(tlWrap[1]);
    result.activeId = ta.active !== undefined && ta.active !== '' ? parseInt(ta.active, 10) : null;
    const blocks = tlWrap[2].match(/<timeline\s+([^>]*?)>[\s\S]*?<\/timeline>/g) || [];
    for (const b of blocks) {
      const tl = parseTimelineBlock(b);
      if (tl) result.timelines.push(tl);
    }
  }
  return result;
}

async function loadProject(filePath) {
  const text = await readProjectXml(filePath);
  const parsed = parseGlobal(text);
  if (!parsed.timelines.length && parsed.activeId == null && !text.includes('<timeline')) {
    throw new Error('Not a valid .kc project file');
  }
  const list = parsed.timelines.map((tl) => ({
    id: tl.id,
    name: tl.name,
    src: tl.src,
    srcRel: tl.srcRel,
    srcName: tl.srcName,
    video: tl.video
  }));
  return {
    timelines: list,
    activeId: parsed.activeId,
    winBounds: parsed.winBounds,
    exportSettings: parsed.exportSettings
  };
}

async function loadProjectTimeline(filePath, id) {
  const text = await readProjectXml(filePath);
  const parsed = parseGlobal(text);
  const found = parsed.timelines.find((tl) => tl.id === id);
  if (!found) throw new Error('Timeline not found in project: ' + id);
  return found;
}

async function loadProjectTimelines(filePath, ids) {
  const text = await readProjectXml(filePath);
  const parsed = parseGlobal(text);
  const wanted = ids && ids.length ? new Set(ids) : null;
  return parsed.timelines.filter((tl) => !wanted || wanted.has(tl.id));
}

module.exports = { saveProject, loadProject, loadProjectTimeline, loadProjectTimelines };
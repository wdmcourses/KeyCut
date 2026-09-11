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
  ws.write('<keycut ver="1">\n');
  const srcRel = relativeRel(filePath, data.src);
  ws.write('  <src rel="' + (srcRel || '') + '">' + xmlEscape(basename(data.src)) + '</src>\n');
  const v = data.video;
  let srcSize = 0;
  try { srcSize = fs.statSync(data.src).size; } catch {}
  ws.write('  <video dur="' + fmt(v.dur) + '" w="' + v.w + '" h="' + v.h + '" fps="' + fmt(v.fps) + '" size="' + srcSize + '"/>\n');
  ws.write('  <view cursor="' + fmt(data.cursor) + '" zoom="' + fmt(data.zoom) + '" start="' + fmt(data.viewStart) + '"/>\n');
  const ex = data.exportSettings || {};
  ws.write('  <export compress="' + (ex.compress ? '1' : '0') + '" res="' + xmlEscape(String(ex.resolution || 'origin')) + '" blocks="' + (ex.blocks ? '1' : '0') + '"/>\n');
  const wb = data.winBounds || {};
  ws.write('  <window' + (Number.isFinite(wb.x) ? ' x="' + wb.x + '"' : '') + (Number.isFinite(wb.y) ? ' y="' + wb.y + '"' : '') + (Number.isFinite(wb.w) ? ' w="' + wb.w + '"' : '') + (Number.isFinite(wb.h) ? ' h="' + wb.h + '"' : '') + '/>\n');
  ws.write('  <markers>');
  for (const m of (data.markers || [])) {
    ws.write('<m t="' + fmt(m.t) + '" n="' + xmlEscape(String(m.name || '')) + '" c="' + (m.color || '#7bd88f') + '"' + (m.off ? ' o="1"' : '') + '/>');
  }
  ws.write('</markers>\n');

  ws.write('  <keys>');
  const keys = data.keys;
  let s = '';
  for (let i = 0; i < keys.length; i++) {
    s += '<k t="' + fmt(keys[i]) + '"/>';
    if (s.length > 65536) { await write(s); s = ''; }
  }
  await write(s);
  ws.write('</keys>\n');

  ws.write('  <cuts>');
  const cuts = data.cuts;
  const deleted = data.deleted;
  s = '';
  for (let i = 0; i < cuts.length; i++) {
    const isDeleted = i < deleted.length && deleted[i];
    s += '<c t="' + fmt(cuts[i]) + '"' + (isDeleted ? ' d="1"' : '') + '/>';
    if (s.length > 65536) { await write(s); s = ''; }
  }
  await write(s);
  ws.write('</cuts>\n');

  ws.write('</keycut>\n');
  ws.end();
  await done;
}

async function loadProject(filePath) {
  return new Promise((resolve, reject) => {
    const result = { src: null, srcRel: null, srcAbs: null, srcName: null, video: null, winBounds: null, keys: [], cuts: [], deleted: [], cursor: 0, zoom: 0, viewStart: 0, markers: [], exportSettings: { compress: false, resolution: 'origin', blocks: false } };
    let leftover = '';
    let sawSrc = false;

    const re = /<src\s+([^>]*?)>([^<]*)<\/src>|<src\s+([^>]*?)\/>|<src>(.*?)<\/src>|<video\s+([^>]*?)\/>|<view\s+([^>]*?)\/>|<export\s+([^>]*?)\/>|<k\s+t="([0-9.]+)"\/>|<c\s+t="([0-9.]+)"(?:\s+d="([01])")?\/>|<m\s+([^>]*?)\/>|<window\s+([^>]*?)\/>/g;

    const unescape = (s) => s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

    const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    rs.on('error', reject);
    rs.on('data', (chunk) => {
      const text = leftover + chunk;
      
      const lastLt = text.lastIndexOf('<');
      const complete = lastLt === -1 ? '' : text.slice(0, lastLt);
      leftover = lastLt === -1 ? '' : text.slice(lastLt);

      re.lastIndex = 0;
      let m;
      while ((m = re.exec(complete)) !== null) {
        if (m[1] !== undefined) {
          sawSrc = true;
          const attrs = {};
          for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.srcRel = attrs.rel !== undefined ? attrs.rel : null;
          result.srcName = m[2] !== undefined ? unescape(m[2]) : null;
        } else if (m[3] !== undefined) {
          sawSrc = true;
          const attrs = {};
          for (const a of m[3].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.srcRel = attrs.rel !== undefined ? attrs.rel : null;
        } else if (m[4] !== undefined) {
          sawSrc = true;
          result.srcAbs = unescape(m[4]);
          result.srcName = unescape(m[4]);
        } else if (m[5] !== undefined) {
          const attrs = {};
          for (const a of m[5].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.video = {
            dur: parseFloat(attrs.dur),
            w: parseInt(attrs.w, 10) || 0,
            h: parseInt(attrs.h, 10) || 0,
            fps: parseFloat(attrs.fps) || 0,
            size: parseInt(attrs.size, 10) || 0
          };
        } else if (m[6] !== undefined) {
          const attrs = {};
          for (const a of m[6].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.cursor = parseFloat(attrs.cursor) || 0;
          result.zoom = parseFloat(attrs.zoom) || 0;
          result.viewStart = parseFloat(attrs.start) || 0;
        } else if (m[7] !== undefined) {
          const attrs = {};
          for (const a of m[7].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.exportSettings = {
            compress: attrs.compress === '1',
            resolution: attrs.res || 'origin',
            blocks: attrs.blocks === '1'
          };
        } else if (m[8] !== undefined) {
          result.keys.push(parseFloat(m[8]));
        } else if (m[9] !== undefined) {
          result.cuts.push(parseFloat(m[9]));
          result.deleted.push(m[10] === '1');
        } else if (m[11] !== undefined) {
          const attrs = {};
          for (const a of m[11].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.markers.push({ t: parseFloat(attrs.t) || 0, name: attrs.n || '', color: attrs.c || '#7bd88f', off: attrs.o === '1' });
        } else if (m[12] !== undefined) {
          const attrs = {};
          for (const a of m[12].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.winBounds = {
            x: Number.isFinite(parseFloat(attrs.x)) ? parseFloat(attrs.x) : undefined,
            y: Number.isFinite(parseFloat(attrs.y)) ? parseFloat(attrs.y) : undefined,
            w: Number.isFinite(parseFloat(attrs.w)) ? parseFloat(attrs.w) : undefined,
            h: Number.isFinite(parseFloat(attrs.h)) ? parseFloat(attrs.h) : undefined
          };
        }
      }
    });
    rs.on('end', () => {
      
      if (result.deleted.length && result.deleted.length === result.cuts.length) result.deleted.pop();
      result.src = result.srcAbs || result.srcRel;
      if (result.src == null && result.srcName != null) result.src = '';
      if (sawSrc && result.src !== null) resolve(result);
      else reject(new Error('Not a valid .kc project file'));
    });
  });
}

module.exports = { saveProject, loadProject };
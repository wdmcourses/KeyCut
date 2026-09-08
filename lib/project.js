const fs = require('fs');

// Optimized streaming XML reader/writer for the .kc project format.
// No DOM: save writes tags incrementally through a WriteStream (backpressure
// aware), load scans chunks with lightweight tokenization so millions of
// records load linearly without building heavy intermediate structures.

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(6) : '0.000000');

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
  ws.write('  <src>' + xmlEscape(data.src) + '</src>\n');
  const v = data.video;
  ws.write('  <video dur="' + fmt(v.dur) + '" w="' + v.w + '" h="' + v.h + '" fps="' + fmt(v.fps) + '"/>\n');
  ws.write('  <view cursor="' + fmt(data.cursor) + '" zoom="' + fmt(data.zoom) + '"/>\n');

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
    s += '<c t="' + fmt(cuts[i]) + '"' + (deleted && deleted[i] ? ' d="1"' : '') + '/>';
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
    const result = { src: null, video: null, keys: [], cuts: [], deleted: [], cursor: 0, zoom: 0 };
    let leftover = '';
    let sawSrc = false;

    const re = /<src>(.*?)<\/src>|<video\s+([^>]*?)\/>|<view\s+([^>]*?)\/>|<k\s+t="([0-9.]+)"\/>|<c\s+t="([0-9.]+)"(?:\s+d="([01])")?\/>/g;

    const unescape = (s) => s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

    const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    rs.on('error', reject);
    rs.on('data', (chunk) => {
      const text = leftover + chunk;
      // Everything before the last '<' is a complete region; the tail may hold a partial tag.
      const lastLt = text.lastIndexOf('<');
      const complete = lastLt === -1 ? '' : text.slice(0, lastLt);
      leftover = lastLt === -1 ? '' : text.slice(lastLt);

      re.lastIndex = 0;
      let m;
      while ((m = re.exec(complete)) !== null) {
        if (m[1] !== undefined) {
          sawSrc = true;
          result.src = unescape(m[1]);
        } else if (m[2] !== undefined) {
          const attrs = {};
          for (const a of m[2].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.video = {
            dur: parseFloat(attrs.dur),
            w: parseInt(attrs.w, 10) || 0,
            h: parseInt(attrs.h, 10) || 0,
            fps: parseFloat(attrs.fps) || 0
          };
        } else if (m[3] !== undefined) {
          const attrs = {};
          for (const a of m[3].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          result.cursor = parseFloat(attrs.cursor) || 0;
          result.zoom = parseFloat(attrs.zoom) || 0;
        } else if (m[4] !== undefined) {
          result.keys.push(parseFloat(m[4]));
        } else if (m[5] !== undefined) {
          result.cuts.push(parseFloat(m[5]));
          result.deleted.push(m[6] === '1');
        }
      }
    });
    rs.on('end', () => {
      // The last cut is the end boundary; its flag describes no segment.
      if (result.deleted.length && result.deleted.length === result.cuts.length) result.deleted.pop();
      if (sawSrc && result.src !== null) resolve(result);
      else reject(new Error('Not a valid .kc project file'));
    });
  });
}

module.exports = { saveProject, loadProject };
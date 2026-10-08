const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function safeJoin(dest, name) {
  const rel = String(name).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  const target = path.join(dest, ...rel);
  const root = path.resolve(dest) + path.sep;
  if (!path.resolve(target).startsWith(root)) throw new Error('Unsafe archive path: ' + name);
  return target;
}

function stripPrefix(name, strip) {
  if (!strip) return name;
  const parts = String(name).replace(/\\/g, '/').split('/');
  return parts.slice(strip).join('/');
}

function writeEntry(dest, name, data, strip, mode) {
  if (name.endsWith('/') || name.endsWith('\\')) return;
  const rel = stripPrefix(name, strip);
  if (!rel) return;
  const target = safeJoin(dest, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  if (mode && process.platform !== 'win32') {
    try { fs.chmodSync(target, mode); } catch {}
  }
}

function writeDir(dest, name, strip) {
  const rel = stripPrefix(name, strip);
  if (!rel) return;
  fs.mkdirSync(safeJoin(dest, rel), { recursive: true });
}

function writeSymlink(dest, name, link, strip) {
  const rel = stripPrefix(name, strip);
  if (!rel) return;
  const target = safeJoin(dest, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (process.platform === 'win32') {
    try { fs.writeFileSync(target, link); } catch {}
    return;
  }
  try { fs.symlinkSync(link, target); } catch {
    try { fs.writeFileSync(target, link); } catch {}
  }
}

function extractZip(buf, dest, strip) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const externalAttr = buf.readUInt32LE(off + 38);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) { writeDir(dest, name, strip); continue; }
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const unixMode = (externalAttr >>> 16) & 0xffff;
    const fileType = unixMode & 0xf000;
    if (fileType === 0xa000) { writeSymlink(dest, name, raw.toString('utf8'), strip); continue; }
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    writeEntry(dest, name, data, strip, unixMode & 0o777);
  }
}

function readStr(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const z = slice.indexOf(0);
  return slice.toString('utf8', 0, z === -1 ? slice.length : z);
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString('utf8', i, sp), 10);
    if (!len || len <= 0) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq >= 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

function extractTarGz(buf, dest, strip) {
  const tar = zlib.gunzipSync(buf);
  let off = 0;
  let longName = null;
  let longLink = null;
  let pax = {};
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header[0] === 0) break;
    const size = parseInt(readStr(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156]);
    const mode = parseInt(readStr(header, 100, 8).trim() || '0', 8) || 0;
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    const nextOff = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x' || type === 'g') { pax = parsePax(data); off = nextOff; continue; }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); off = nextOff; continue; }
    if (type === 'K') { longLink = data.toString('utf8').replace(/\0+$/, ''); off = nextOff; continue; }

    let name = readStr(header, 0, 100);
    const prefix = readStr(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    let link = readStr(header, 157, 100);
    if (longName) { name = longName; longName = null; }
    if (longLink) { link = longLink; longLink = null; }
    if (pax.path) name = pax.path;
    if (pax.linkpath) link = pax.linkpath;
    pax = {};

    if (type === '5' || name.endsWith('/')) writeDir(dest, name, strip);
    else if (type === '2') writeSymlink(dest, name, link, strip);
    else if (type === '0' || type === '\0' || type === '') writeEntry(dest, name, Buffer.from(data), strip, mode);

    off = nextOff;
  }
}

function extractArchive(buf, dest, filename) {
  fs.mkdirSync(dest, { recursive: true });
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.zip')) extractZip(buf, dest, 1);
  else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) extractTarGz(buf, dest, 1);
  else throw new Error('Unsupported archive: ' + filename);
}

module.exports = { extractArchive, extractZip, extractTarGz };

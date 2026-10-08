const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { extractZip, extractTarGz, extractArchive } = require('../lib/archive');

const WORK = path.join(os.tmpdir(), 'keycut-archive-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, d || ''); } };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.dir ? Buffer.alloc(0) : e.data;
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}
function tarHeader(name, size, mode, type, link) {
  const b = Buffer.alloc(512);
  b.write(name.slice(0, 100), 0, 'utf8');
  b.write(octal(mode || 0o644, 8), 100);
  b.write(octal(0, 8), 108);
  b.write(octal(0, 8), 116);
  b.write(octal(size, 12), 124);
  b.write(octal(0, 12), 136);
  b.write('        ', 148);
  b.write(type || '0', 156);
  if (link) b.write(link.slice(0, 100), 157, 'utf8');
  b.write('ustar\0', 257);
  b.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.longName) {
      const ln = Buffer.from(e.longName + '\0', 'utf8');
      parts.push(tarHeader('././@LongLink', ln.length, 0o644, 'L'));
      parts.push(ln, Buffer.alloc((512 - (ln.length % 512)) % 512));
    }
    const data = e.dir ? Buffer.alloc(0) : (e.data || Buffer.alloc(0));
    parts.push(tarHeader(e.name, data.length, e.mode, e.dir ? '5' : '0', e.link));
    if (!e.dir && data.length) {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

function read(p) { return fs.readFileSync(p, 'utf8'); }
function exists(p) { return fs.existsSync(p); }

console.log('[1] ZIP extraction with strip');
const zipDir = path.join(WORK, 'zip');
const zip = makeZip([
  { name: 'debreath-win-x64/', dir: true },
  { name: 'debreath-win-x64/debreath.py', data: Buffer.from('print(1)') },
  { name: 'debreath-win-x64/python/python.exe', data: Buffer.from('BIN') },
  { name: 'debreath-win-x64/lib/sub/a.py', data: Buffer.from('a=1') }
]);
extractZip(zip, zipDir, 1);
check('zip: top folder stripped (debreath.py at root)', exists(path.join(zipDir, 'debreath.py')));
check('zip: nested binary present', exists(path.join(zipDir, 'python', 'python.exe')));
check('zip: deep nested file present', exists(path.join(zipDir, 'lib', 'sub', 'a.py')));
check('zip: content correct', read(path.join(zipDir, 'lib', 'sub', 'a.py')) === 'a=1');
check('zip: top folder not recreated', !exists(path.join(zipDir, 'debreath-win-x64')));

console.log('[2] TAR.GZ extraction with strip + GNU long name');
const tarDir = path.join(WORK, 'tar');
const longName = 'debreath-linux-x64/python/lib/python3.13/site-packages/very/long/path/module_file.py';
const tar = makeTar([
  { name: 'debreath-linux-x64/', dir: true },
  { name: 'debreath-linux-x64/debreath.py', data: Buffer.from('print(2)') },
  { name: 'debreath-linux-x64/python/bin/python3', data: Buffer.from('ELF'), mode: 0o755 },
  { name: 'short.py', longName, data: Buffer.from('long=1') }
]);
extractTarGz(tar, tarDir, 1);
check('tar: top folder stripped', exists(path.join(tarDir, 'debreath.py')));
check('tar: bin present', exists(path.join(tarDir, 'python', 'bin', 'python3')));
check('tar: gnu long name resolved', exists(path.join(tarDir, 'python', 'lib', 'python3.13', 'site-packages', 'very', 'long', 'path', 'module_file.py')));
check('tar: long content correct', read(path.join(tarDir, 'python', 'lib', 'python3.13', 'site-packages', 'very', 'long', 'path', 'module_file.py')) === 'long=1');
if (process.platform !== 'win32') {
  const mode = fs.statSync(path.join(tarDir, 'python', 'bin', 'python3')).mode & 0o777;
  check('tar: exec mode preserved (unix)', mode === 0o755, mode.toString(8));
}

console.log('[3] Path traversal is rejected');
let threwZip = false;
try { extractZip(makeZip([{ name: 'top/../../evil.txt', data: Buffer.from('x') }]), path.join(WORK, 'evilzip'), 1); }
catch { threwZip = true; }
check('zip: rejects escape after strip', threwZip);
let threwTar = false;
try { extractTarGz(makeTar([{ name: 'top/../../evil.txt', data: Buffer.from('x') }]), path.join(WORK, 'eviltar'), 1); }
catch { threwTar = true; }
check('tar: rejects escape after strip', threwTar);

console.log('[4] extractArchive dispatches by extension');
const autoDir = path.join(WORK, 'auto');
extractArchive(zip, autoDir, 'debreath-win-x64.zip');
check('auto: zip dispatched', exists(path.join(autoDir, 'debreath.py')));
const autoTarDir = path.join(WORK, 'autotar');
extractArchive(tar, autoTarDir, 'debreath-linux-x64.tar.gz');
check('auto: tar.gz dispatched', exists(path.join(autoTarDir, 'debreath.py')));
let threwUnknown = false;
try { extractArchive(Buffer.alloc(0), path.join(WORK, 'x'), 'file.rar'); } catch { threwUnknown = true; }
check('auto: unknown extension rejected', threwUnknown);

fs.rmSync(WORK, { recursive: true, force: true });
console.log('\nRESULT:', pass, 'passed,', fail, 'failed');
process.exit(fail ? 1 : 0);

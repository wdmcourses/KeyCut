// Generates the app icon (a "KC" tile) as assets/icon.png and assets/icon.ico.
// Pure Node (zlib + own PNG encoder) - no image libraries needed.
// Run: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

// 5x7 blocky bitmap font for K and C
const K = [
  '#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'
];
const C = [
  '.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'
];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeIco(png) {
  // ICONDIR + one ICONDIRENTRY + PNG image
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);        // reserved
  header.writeUInt16LE(1, 2);        // type: icon
  header.writeUInt16LE(1, 4);        // count
  header[6] = 0;                     // width 0 = 256
  header[7] = 0;                     // height 0 = 256
  header[8] = 0;                     // color count
  header[9] = 0;                     // reserved
  header.writeUInt16LE(1, 10);       // planes
  header.writeUInt16LE(32, 12);      // bit count
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);      // offset of image data
  return Buffer.concat([header, png]);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function main() {
  const outDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  const scale = 18;
  const glyphW = 5 * scale;
  const glyphH = 7 * scale;
  const gap = scale;
  const totalW = glyphW * 2 + gap;
  const totalH = glyphH;
  const ox = Math.round((SIZE - totalW) / 2);
  const oy = Math.round((SIZE - totalH) / 2);
  const margin = 14;
  const radius = 52;

  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (!insideRoundedRect(x, y, margin, margin, SIZE - 1 - margin, SIZE - 1 - margin, radius)) {
        rgba[i + 3] = 0; // transparent outside
        continue;
      }
      const t = y / SIZE;
      rgba[i] = Math.round(lerp(0x3f, 0x7b, t));     // R
      rgba[i + 1] = Math.round(lerp(0xa2, 0x5c, t)); // G
      rgba[i + 2] = Math.round(lerp(0xff, 0xff, t)); // B
      rgba[i + 3] = 255;
    }
  }

  // draw letters
  const glyphs = [K, C];
  for (let g = 0; g < 2; g++) {
    const glyph = glyphs[g];
    const gx = ox + g * (glyphW + gap);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '#') continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const x = gx + col * scale + px;
            const y = oy + row * scale + py;
            const i = (y * SIZE + x) * 4;
            rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255;
          }
        }
      }
    }
  }

  const png = encodePng(SIZE, SIZE, rgba);
  fs.writeFileSync(path.join(outDir, 'icon.png'), png);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(png));
  console.log('Icon written to assets/icon.png and assets/icon.ico');
}

main();
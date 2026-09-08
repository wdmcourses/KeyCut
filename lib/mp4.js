const fs = require('fs');
const fsp = fs.promises;





class BoxReader {
  constructor(fd, fileSize) {
    this.fd = fd;
    this.size = fileSize;
  }

  async read(offset, length) {
    const buf = Buffer.alloc(length);
    let pos = 0;
    while (pos < length) {
      const { bytesRead } = await this.fd.read(buf, pos, length - pos, offset + pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
    }
    return buf;
  }

  async readHeader(offset) {
    const h = await this.read(offset, 16);
    let size = h.readUInt32BE(0);
    const type = h.toString('ascii', 4, 8);
    let headerLen = 8;
    if (size === 1) {
      size = Number(h.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) {
      size = this.size - offset;
    }
    return { size, type, headerLen, dataStart: offset + headerLen };
  }

  async children(offset, end) {
    const list = [];
    let o = offset;
    while (o + 8 <= end) {
      const h = await this.readHeader(o);
      if (h.size < h.headerLen) break;
      list.push({ ...h, offset: o, end: o + h.size });
      o = o + h.size;
    }
    return list;
  }
}


async function fullBox(reader, box) {
  const buf = await reader.read(box.dataStart, 4);
  const version = buf.readUInt8(0);
  return { version, payloadStart: box.dataStart + 4, end: box.end };
}

async function findChild(reader, children, type) {
  const box = children.find((c) => c.type === type);
  if (!box) return null;
  const payload = await fullBox(reader, box);
  return { ...box, payload };
}

async function parseSttsEntries(reader, box) {
  
  const { payloadStart } = await fullBox(reader, box);
  const head = await reader.read(payloadStart, 4);
  const entryCount = head.readUInt32BE(0);
  const byteLen = entryCount * 8;
  const buf = await reader.read(payloadStart + 4, byteLen);
  return { entryCount, buf };
}

async function parseStssNumbers(reader, box) {
  
  const { payloadStart } = await fullBox(reader, box);
  const head = await reader.read(payloadStart, 4);
  const entryCount = head.readUInt32BE(0);
  const byteLen = entryCount * 4;
  const buf = await reader.read(payloadStart + 4, byteLen);
  return { entryCount, buf };
}



async function parseCttsEntries(reader, box) {
  const { version, payloadStart } = await fullBox(reader, box);
  const head = await reader.read(payloadStart, 4);
  const entryCount = head.readUInt32BE(0);
  const byteLen = entryCount * 8;
  const buf = await reader.read(payloadStart + 4, byteLen);
  return { version, entryCount, buf };
}



async function parseElst(reader, trakChildren) {
  const edts = trakChildren.find((c) => c.type === 'edts');
  if (!edts) return null;
  const edtsChildren = await reader.children(edts.dataStart, edts.end);
  const elstBox = edtsChildren.find((c) => c.type === 'elst');
  if (!elstBox) return null;
  const { version, payloadStart } = await fullBox(reader, elstBox);
  const head = await reader.read(payloadStart, 4);
  const count = head.readUInt32BE(0);
  if (count === 0) return null;
  if (version === 1) {
    const buf = await reader.read(payloadStart + 4, 20);
    return { segmentDuration: Number(buf.readBigUInt64BE(0)), mediaTime: Number(buf.readBigInt64BE(8)) };
  }
  const buf = await reader.read(payloadStart + 4, 8);
  return { segmentDuration: buf.readUInt32BE(0), mediaTime: buf.readInt32BE(4) };
}

async function parseVideoSize(reader, stsdBox) {
  
  const { payloadStart } = await fullBox(reader, stsdBox);
  const head = await reader.read(payloadStart, 4);
  const entryCount = head.readUInt32BE(0);
  if (entryCount === 0) return null;
  const entryHead = await reader.read(payloadStart + 4, 8);
  const entrySize = entryHead.readUInt32BE(0);
  
  
  
  const contentOffset = payloadStart + 4 + 8;
  const content = await reader.read(contentOffset, 28);
  const width = content.readUInt16BE(24);
  const height = content.readUInt16BE(26);
  return width && height ? { width, height } : null;
}

async function parseMdhd(reader, box) {
  const { version, payloadStart } = await fullBox(reader, box);
  if (version === 1) {
    const buf = await reader.read(payloadStart, 28);
    return { timescale: buf.readUInt32BE(16), duration: Number(buf.readBigUInt64BE(20)) };
  }
  const buf = await reader.read(payloadStart, 16);
  return { timescale: buf.readUInt32BE(8), duration: buf.readUInt32BE(12) };
}

async function hdlrType(reader, box) {
  const { payloadStart } = await fullBox(reader, box);
  const buf = await reader.read(payloadStart + 4, 4); 
  return buf.toString('ascii', 0, 4);
}

async function parseMvhd(reader, box) {
  const { version, payloadStart } = await fullBox(reader, box);
  if (version === 1) {
    const buf = await reader.read(payloadStart, 28);
    return { timescale: buf.readUInt32BE(16), duration: Number(buf.readBigUInt64BE(20)) };
  }
  const buf = await reader.read(payloadStart, 16);
  return { timescale: buf.readUInt32BE(8), duration: buf.readUInt32BE(12) };
}



async function sttsTotalDuration(reader, sttsBox, timescale) {
  const stts = await parseSttsEntries(reader, sttsBox);
  let ts = 0;
  for (let i = 0; i < stts.entryCount; i++) ts += stts.buf.readUInt32BE(i * 8) * stts.buf.readUInt32BE(i * 8 + 4);
  return timescale > 0 ? ts / timescale : 0;
}

async function parseMoov(reader, moovBox) {
  const moovChildren = await reader.children(moovBox.dataStart, moovBox.end);

  
  
  let movieDur = 0;
  let movieTimescale = 0;
  const mvhd = moovChildren.find((c) => c.type === 'mvhd');
  if (mvhd) {
    const m = await parseMvhd(reader, mvhd);
    movieTimescale = m.timescale;
    movieDur = m.timescale > 0 ? m.duration / m.timescale : 0;
  }

  const traks = moovChildren.filter((c) => c.type === 'trak');
  let video = null;
  let maxDur = movieDur;

  for (const trak of traks) {
    const trakChildren = await reader.children(trak.dataStart, trak.end);
    const mdia = trakChildren.find((c) => c.type === 'mdia');
    if (!mdia) continue;
    const mdiaChildren = await reader.children(mdia.dataStart, mdia.end);
    const hdlrBox = mdiaChildren.find((c) => c.type === 'hdlr');
    const mdhdBox = mdiaChildren.find((c) => c.type === 'mdhd');
    if (!hdlrBox || !mdhdBox) continue;
    const handler = await hdlrType(reader, hdlrBox);
    const mdhd = await parseMdhd(reader, mdhdBox);
    const mdhdSec = mdhd.timescale > 0 ? mdhd.duration / mdhd.timescale : 0;
    const minf = mdiaChildren.find((c) => c.type === 'minf');
    const stbl = minf ? (await reader.children(minf.dataStart, minf.end)).find((c) => c.type === 'stbl') : null;
    const stblChildren = stbl ? await reader.children(stbl.dataStart, stbl.end) : [];
    const sttsBox = stblChildren.find((c) => c.type === 'stts');

    const trackDur = Math.max(mdhdSec, sttsBox ? await sttsTotalDuration(reader, sttsBox, mdhd.timescale) : 0);
    maxDur = Math.max(maxDur, trackDur);

    if (handler !== 'vide' || video) continue;
    const stssBox = stblChildren.find((c) => c.type === 'stss');
    const stsdBox = stblChildren.find((c) => c.type === 'stsd');
    const cttsBox = stblChildren.find((c) => c.type === 'ctts');
    if (!sttsBox || !stsdBox) continue;

    const stts = await parseSttsEntries(reader, sttsBox);
    const size = await parseVideoSize(reader, stsdBox);

    
    let totalSamples = 0;
    for (let i = 0; i < stts.entryCount; i++) totalSamples += stts.buf.readUInt32BE(i * 8);
    const fps = trackDur > 0 ? totalSamples / trackDur : 0;

    
    
    let elstShift = 0;
    let elstDurSec = 0;
    const elst = await parseElst(reader, trakChildren);
    if (elst && elst.mediaTime >= 0) {
      elstShift = mdhd.timescale > 0 ? elst.mediaTime / mdhd.timescale : 0;
      if (elst.segmentDuration > 0 && movieTimescale > 0) {
        elstDurSec = elst.segmentDuration / movieTimescale;
      }
    }

    let keyTimes = null;
    if (stssBox) {
      const stss = await parseStssNumbers(reader, stssBox);
      const ctts = cttsBox ? await parseCttsEntries(reader, cttsBox) : null;
      keyTimes = computeKeyTimes(stts, stss, ctts, mdhd.timescale);
      if (elstShift > 0) keyTimes = keyTimes.map((t) => Math.max(0, t - elstShift));
    }

    
    const effTrackDur = Math.max(trackDur - elstShift, elstDurSec || 0);
    maxDur = Math.max(maxDur, effTrackDur);

    video = {
      duration: effTrackDur,
      width: size ? size.width : null,
      height: size ? size.height : null,
      fps,
      totalSamples,
      timescale: mdhd.timescale,
      keyTimes,
      hasStss: !!stssBox
    };
  }

  if (video) {
    
    video.duration = Math.max(maxDur, video.duration || 0);
    return video;
  }
  return null;
}





function computeKeyTimes(stts, stss, ctts, timescale) {
  const dts = [];
  if (stts.entryCount === 0 || stss.entryCount === 0) return dts;
  let ei = 0;
  let rem = stts.buf.readUInt32BE(0);
  let delta = stts.buf.readUInt32BE(4);
  let sn = 1; 
  let time = 0; 
  for (let s = 0; s < stss.entryCount; s++) {
    const sync = stss.buf.readUInt32BE(s * 4);
    
    while (ei < stts.entryCount && sn + rem - 1 < sync) {
      time += rem * delta;
      sn += rem;
      ei++;
      if (ei < stts.entryCount) {
        rem = stts.buf.readUInt32BE(ei * 8);
        delta = stts.buf.readUInt32BE(ei * 8 + 4);
      }
    }
    if (ei >= stts.entryCount) break;
    const adv = sync - sn;
    time += adv * delta;
    dts.push(time); 
    
    sn = sync + 1;
    time += delta;
    rem -= adv + 1;
    if (rem === 0) {
      ei++;
      if (ei < stts.entryCount) {
        rem = stts.buf.readUInt32BE(ei * 8);
        delta = stts.buf.readUInt32BE(ei * 8 + 4);
      }
    }
  }
  if (!timescale) return dts;

  const times = [];
  if (!ctts || ctts.entryCount === 0) {
    for (const d of dts) times.push(d / timescale);
    return times;
  }

  
  let ci = 0;
  let csn = 1;
  let crem = ctts.buf.readUInt32BE(0);
  for (let i = 0; i < stss.entryCount && i < dts.length; i++) {
    const sync = stss.buf.readUInt32BE(i * 4);
    while (ci < ctts.entryCount && csn + crem - 1 < sync) {
      csn += crem;
      ci++;
      if (ci < ctts.entryCount) crem = ctts.buf.readUInt32BE(ci * 8);
    }
    const off = ci < ctts.entryCount
      ? (ctts.version === 1 ? ctts.buf.readInt32BE(ci * 8 + 4) : ctts.buf.readUInt32BE(ci * 8 + 4))
      : 0;
    times.push((dts[i] + off) / timescale);
  }
  return times;
}

async function parseMp4(filePath) {
  const stat = await fsp.stat(filePath);
  const fd = await fsp.open(filePath, 'r');
  try {
    const reader = new BoxReader(fd, stat.size);
    const boxes = await reader.children(0, stat.size);
    const moov = boxes.find((b) => b.type === 'moov');
    if (!moov) {
      throw new Error('moov atom not found in ' + filePath);
    }
    return await parseMoov(reader, moov);
  } finally {
    await fd.close();
  }
}

module.exports = { parseMp4 };
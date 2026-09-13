const { probeQuick } = require('./probe');
const { joinFiles } = require('./concat');

function assertJoinable(metas) {
  if (!metas || metas.length < 2) return null;
  const base = metas[0];
  if (!base) return null;
  for (let i = 1; i < metas.length; i++) {
    const m = metas[i];
    if (!m) continue;
    if (!m.width || !m.height || !base.width || !base.height) continue;
    if (m.width !== base.width || m.height !== base.height) {
      return 'Cannot join: resolution mismatch (' + base.width + 'x' + base.height + ' vs ' + m.width + 'x' + m.height + ')';
    }
    if (base.fps && m.fps) {
      const rel = Math.abs(m.fps - base.fps) / Math.max(base.fps, m.fps);
      if (rel > 0.1) {
        return 'Cannot join: frame rate differs too much (' + base.fps.toFixed(2) + ' vs ' + m.fps.toFixed(2) + ' fps)';
      }
    }
    if (base.codec && m.codec && base.codec !== m.codec) {
      return 'Cannot join: video codec mismatch (' + base.codec + ' vs ' + m.codec + ')';
    }
    if (base.sarNum && m.sarNum && base.sarDen && m.sarDen && (base.sarNum / base.sarDen !== m.sarNum / m.sarDen)) {
      return 'Cannot join: pixel aspect ratio mismatch (SAR ' + base.sarNum + ':' + base.sarDen + ' vs ' + m.sarNum + ':' + m.sarDen + ')';
    }
    if (base.audioCodec && m.audioCodec && base.audioCodec !== m.audioCodec) {
      return 'Cannot join: audio codec mismatch (' + base.audioCodec + ' vs ' + m.audioCodec + ')';
    }
    if (base.audioRate && m.audioRate && base.audioRate !== m.audioRate) {
      return 'Cannot join: audio rate mismatch (' + base.audioRate + ' Hz vs ' + m.audioRate + ' Hz)';
    }
    if (base.audioChannels && m.audioChannels && base.audioChannels !== m.audioChannels) {
      return 'Cannot join: audio channels mismatch (' + base.audioChannels + ' vs ' + m.audioChannels + ')';
    }
  }
  return null;
}

async function probeMetas(files, ffmpeg) {
  const metas = [];
  for (const f of files) {
    const q = await probeQuick(f, ffmpeg);
    if (!q) throw new Error('Failed to probe: ' + f);
    metas.push(q);
  }
  return metas;
}

async function mergeTimelines({ files, ffmpeg, onProgress, totalDuration }) {
  const metas = await probeMetas(files, ffmpeg);
  const err = assertJoinable(metas);
  if (err) throw new Error(err);
  return joinFiles({ files, ffmpeg, onProgress, totalDuration });
}

module.exports = { assertJoinable, probeMetas, mergeTimelines, joinFiles };
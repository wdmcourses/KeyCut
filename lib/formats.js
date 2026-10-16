const MOVENC = ['mp4', 'mov', '3gp', '3g2', 'f4v', 'ipod', 'psp', 'ismv'];
const MP4_EXT = ['.mp4', '.mov', '.m4v', '.3gp', '.3g2', '.ipod', '.f4v'];
const BITMAP_SUBS = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'];
const LOSSLESS_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'ts', 'mts', 'm2ts', 'flv'];

const FORMAT_BY_EXT = {
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.3gp': 'mp4',
  '.3g2': 'mp4',
  '.f4v': 'mp4',
  '.ipod': 'mp4',
  '.psp': 'mp4',
  '.mov': 'mov',
  '.mkv': 'matroska',
  '.webm': 'webm',
  '.ts': 'mpegts',
  '.m2ts': 'mpegts',
  '.mts': 'mpegts',
  '.m2t': 'mpegts',
  '.avi': 'avi'
};

const FORMAT_EXTS = {
  mp4: ['mp4', 'm4v', '3gp', 'f4v'],
  mov: ['mov'],
  matroska: ['mkv'],
  webm: ['webm'],
  mpegts: ['ts', 'mts', 'm2ts'],
  avi: ['avi'],
  flv: ['flv']
};

const VIDEO_CODECS = {
  h264: ['mp4', 'mov', 'mkv', 'm4v', 'ts', 'mts', 'm2ts', '3gp', 'f4v', 'avi'],
  avc1: ['mp4', 'mov', 'mkv', 'm4v', 'ts', 'mts', 'm2ts', '3gp', 'f4v', 'avi'],
  hevc: ['mp4', 'mov', 'mkv', 'm4v', 'ts', 'mts', 'm2ts'],
  h265: ['mp4', 'mov', 'mkv', 'm4v', 'ts', 'mts', 'm2ts'],
  vp9: ['mp4', 'mkv', 'webm'],
  av1: ['mp4', 'mkv', 'webm'],
  vp8: ['mkv', 'webm'],
  theora: ['mkv'],
  mpeg4: ['mp4', 'mov', 'mkv', 'avi', '3gp'],
  mpeg2video: ['mkv', 'ts', 'mts', 'm2ts', 'avi'],
  mjpeg: ['mp4', 'mov', 'mkv', 'avi'],
  wmv2: ['mkv', 'wmv'],
  msmpeg4: ['mkv', 'avi'],
  msmpeg4v2: ['mkv', 'avi'],
  msmpeg4v3: ['mkv', 'avi']
};

const AUDIO_CODECS = {
  aac: ['mp4', 'mov', 'mkv', 'm4v', 'ts', 'mts', 'm2ts', '3gp', 'f4v', 'flv'],
  mp3: ['mp4', 'mov', 'mkv', 'ts', 'mts', 'm2ts', 'avi'],
  opus: ['mkv', 'webm', 'ts'],
  vorbis: ['mkv', 'webm'],
  ac3: ['mkv', 'ts', 'mts', 'm2ts', 'mov'],
  pcm: ['mov', 'mkv', 'avi'],
  pcm_s16le: ['mov', 'mkv', 'avi'],
  pcm_s16be: ['mov', 'mkv', 'avi'],
  pcm_s24le: ['mov', 'mkv', 'avi'],
  pcm_bluray: ['mov', 'mkv'],
  pcm_dvd: ['mov', 'mkv'],
  mp2: ['mkv', 'ts', 'mts', 'm2ts'],
  flac: ['mkv', 'mov'],
  wmav2: ['mkv', 'wmv']
};

function outFormatFor(ext) {
  return FORMAT_BY_EXT['.' + String(ext || '').toLowerCase().replace(/^\./, '')] || null;
}

function mp4LikeExt(ext) {
  return MP4_EXT.includes('.' + String(ext || '').toLowerCase().replace(/^\./, ''));
}

function isDropped(stream, format) {
  return stream.codec_type === 'subtitle' && BITMAP_SUBS.includes(stream.codec_name) && MOVENC.includes(format);
}

function decideCodec(stream, outFormat) {
  if (stream.codec_type === 'subtitle') {
    if (outFormat && MOVENC.includes(outFormat) && stream.codec_name !== 'mov_text') return 'mov_text';
    if (outFormat === 'matroska' && stream.codec_name === 'mov_text') return 'srt';
    if (outFormat === 'webm' && stream.codec_name !== 'webvtt') return 'webvtt';
    return 'copy';
  }
  if (stream.codec_type === 'audio') {
    if (stream.codec_name === 'pcm_bluray' && outFormat !== 'mpegts') return 'pcm_s24le';
    if (stream.codec_name === 'pcm_dvd' && outFormat != null && ['matroska', 'mov'].includes(outFormat)) return 'pcm_s32le';
    return 'copy';
  }
  return 'copy';
}

function acceptsCodec(stream, format) {
  const exts = FORMAT_EXTS[format];
  if (!exts) return true;
  if (isDropped(stream, format)) return true;
  const codec = String(stream.codec_name || '').toLowerCase();
  if (stream.codec_type === 'video') {
    const list = VIDEO_CODECS[codec];
    return !list || list.some((e) => exts.includes(e));
  }
  if (stream.codec_type === 'audio') {
    const list = AUDIO_CODECS[codec];
    return !list || list.some((e) => exts.includes(e));
  }
  if (stream.codec_type === 'subtitle') return !BITMAP_SUBS.includes(codec) || FORMAT_EXTS.matroska.some((e) => exts.includes(e));
  return true;
}

function containerAccepts(streams, format) {
  return (streams || []).every((stream) => acceptsCodec(stream, format));
}

const FAMILY_EXT = { movenc: '.mp4', matroska: '.mkv', mpegts: '.ts', avi: '.avi', flv: '.flv' };

function containerFamily(format) {
  if (!format) return null;
  if (MOVENC.includes(format)) return 'movenc';
  if (format === 'matroska' || format === 'webm') return 'matroska';
  if (format === 'mpegts') return 'mpegts';
  if (format === 'avi') return 'avi';
  if (format === 'flv') return 'flv';
  return format;
}

function demuxerFamily(container) {
  const s = String(container || '').toLowerCase();
  if (!s) return null;
  if (s.includes('matroska') || s.includes('webm')) return 'matroska';
  if (s.includes('mp4') || s.includes('mov') || s.includes('3gp') || s.includes('3g2') || s.includes('mj2')) return 'movenc';
  if (s.includes('mpegts')) return 'mpegts';
  if (s.includes('avi')) return 'avi';
  if (s.includes('flv')) return 'flv';
  return s;
}

function fallbackExt(ext, family, streams) {
  const format = outFormatFor(ext);
  if (format && containerFamily(format) === family && (format !== 'webm' || containerAccepts(streams, 'webm'))) return ext;
  return FAMILY_EXT[family] || null;
}

function compatibleExts(streams) {
  const v = (streams || []).find((s) => s.codec_type === 'video');
  const a = (streams || []).find((s) => s.codec_type === 'audio');
  const vcodec = v && v.codec_name ? String(v.codec_name).toLowerCase() : '';
  const acodec = a && a.codec_name ? String(a.codec_name).toLowerCase() : '';
  if (!vcodec && !acodec) return null;
  let allowed = VIDEO_CODECS[vcodec] || null;
  if (acodec && AUDIO_CODECS[acodec] && allowed) allowed = allowed.filter((e) => AUDIO_CODECS[acodec].includes(e));
  return allowed;
}

function preferredLosslessExt(streams, srcExt) {
  const ext = String(srcExt || '').toLowerCase().replace(/^\./, '');
  const known = (e) => !!outFormatFor(e);
  const allowed = compatibleExts(streams);
  if (allowed && allowed.length) {
    if (ext && allowed.includes(ext) && known(ext)) return ext;
    const first = allowed.find(known);
    return first || 'mkv';
  }
  return ext && known(ext) ? ext : 'mkv';
}

const api = {
  MOVENC,
  MP4_EXT,
  BITMAP_SUBS,
  LOSSLESS_EXTS,
  FAMILY_EXT,
  VIDEO_CODECS,
  AUDIO_CODECS,
  outFormatFor,
  mp4LikeExt,
  isDropped,
  decideCodec,
  containerAccepts,
  containerFamily,
  demuxerFamily,
  fallbackExt,
  compatibleExts,
  preferredLosslessExt
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.KeyCutFormats = api;

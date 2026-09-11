'use strict';



const $ = (id) => document.getElementById(id);

const KEYFRAME_ALPHA_BRIGHT = 0.3;
const KEYFRAME_DIM_COEFF = 0.45;
const KEYFRAME_GRAY_COEFF = 0.57;
const WAVEFORM_COEFF = 2;
const WAVEFORM_OFF_DIM = 0.5;
const SEG_KEPT_ALPHA = 0.45;
const SEG_OFF_ALPHA = 0.1;
const SEG_DELETED_ALPHA = 0.6;

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function fmtTime(t, ms = false) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return ms ? `${base}.${pad(Math.floor((t % 1) * 1000), 3)}` : base;
}

function toFileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8.5 6 L19 12 L8.5 18 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="7" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor"/></svg>';
const MIN_WIN_W = 900;
const MIN_WIN_H = 560;
const PREVIEW_ASPECT = 16 / 9;
const FIT_SCALES = [10, 15, 20, 25, 30, 40, 50, 60, 75, 90, 100, 110, 125, 150, 175, 200, 225, 250, 275, 300, 350, 400];


const COLORS = {
  bg: '#101216',
  noVideoBg: '#0d0f12',
  noVideoText: '#6b7280',
  segKeptFrom: '#3f86c4',
  segKeptTo: '#2c6da8',
  segDeleted: '#22252b',
  segDeletedFrame: 'rgba(172,182,196,0.3)',
  segBoundary: 'rgba(255,255,255,0.55)',
  keyframeRgb: '255,255,255',
  keyframeAlphaBright: KEYFRAME_ALPHA_BRIGHT,
  keyframeAlphaDim: KEYFRAME_ALPHA_BRIGHT * KEYFRAME_DIM_COEFF,
  
  keyframeGrayRgb: '255,255,255',
  keyframeGrayAlphaBright: KEYFRAME_ALPHA_BRIGHT * KEYFRAME_GRAY_COEFF,
  keyframeGrayAlphaDim: KEYFRAME_ALPHA_BRIGHT * KEYFRAME_DIM_COEFF * KEYFRAME_GRAY_COEFF,
  selectionKept: '#ffffff',
  selectionGray: '#d8dee6',
  resizeHandle: 'rgba(255,255,255,0.95)',
  activeSeg: 'rgba(255,255,255,0.9)',
  activeSegGlow: 'rgba(255,255,255,0.5)',
  hatch: 'rgba(215,224,232,0.12)',
  rulerBg: '#15171b',
  rulerTick: '#9aa6b5',
  rulerMinor: 'rgba(154,166,181,0.5)',
  rulerLabel: '#9aa6b5',
  playhead: '#ffffff',
  separator: '#24282e'
};



class EditorModel {
  constructor(duration) {
    this.cuts = [];
    this.deleted = [];
    this.duration = 0;
    this.history = [];
    this.historyIndex = -1;
    this._runsCache = null;
    this.onMutate = null;
    this.onCaptureState = null;
    this.onRestoreState = null;
    this.suppressSnapshot = false;
    if (duration > 0) this.reset(duration);
  }

  clearHistory() {
    this.history = [];
    this.historyIndex = -1;
  }

  
  
  snapshot() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    const sel = this.onCaptureState ? this.onCaptureState() : null;
    if (this.historyIndex >= 0 && this.history[this.historyIndex] && sel) {
      const p = this.history[this.historyIndex];
      p.sel = p.sel || {};
      p.sel.selected = sel.selected;
      p.sel.selectedSet = sel.selectedSet;
      p.sel.selectedAnchor = sel.selectedAnchor;
    }
    this.history.push({ cuts: this.cuts.slice(), deleted: this.deleted.slice(), sel });
    this._runsCache = null;
    const per = this.cuts.length * 12 + 8;
    const cap = Math.max(1, Math.min(100, Math.floor((64 * 1024 * 1024) / per)));
    if (this.history.length > cap) this.history.splice(0, this.history.length - cap);
    this.historyIndex = this.history.length - 1;
    if (this.onMutate) this.onMutate();
  }

  updateCurrentSelection(sel) {
    if (this.historyIndex >= 0 && this.history[this.historyIndex]) {
      this.history[this.historyIndex].sel = sel;
    }
  }

  undo() {
    if (this.historyIndex <= 0) return false;
    this.historyIndex--;
    this.apply(this.history[this.historyIndex]);
    return true;
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return false;
    this.historyIndex++;
    this.apply(this.history[this.historyIndex]);
    return true;
  }

  apply(s) {
    this.cuts = s.cuts.slice();
    this.deleted = s.deleted.slice();
    this._runsCache = null;
    if (this.onRestoreState && s.sel) this.onRestoreState(s.sel);
    if (this.onMutate) this.onMutate();
  }

  reset(duration) {
    this.duration = duration;
    this.cuts = [0, duration];
    this.deleted = [false];
    this._runsCache = null;
  }

  
  segmentOf(t) {
    const cuts = this.cuts;
    let lo = 0, hi = cuts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cuts[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  split(t) {
    if (t <= 0 || t >= this.duration) return false;
    const i = this.segmentOf(t);
    if (t - this.cuts[i] < 1e-9 || this.cuts[i + 1] - t < 1e-9) return false;
    this.cuts.splice(i + 1, 0, t);
    this.deleted.splice(i, 0, !!this.deleted[i]);
    this.snapshot();
    return true;
  }

  
  deleteAt(i) {
    return this.deleteRange(i, i);
  }

  
  restoreAt(i) {
    return this.restoreRange(i, i);
  }

  
  deleteRange(a, b) {
    if (a < 0 || b >= this.deleted.length || a > b) return false;
    if (!this.deleted.slice(a, b + 1).some((d) => !d)) return false;
    for (let i = a; i <= b; i++) this.deleted[i] = true;
    this.snapshot();
    return true;
  }

  
  deleteIndices(idx) {
    const idxs = [...new Set(idx)].filter((i) => Number.isInteger(i) && i >= 0 && i < this.deleted.length);
    if (!idxs.length) return false;
    if (!idxs.some((i) => !this.deleted[i])) return false;
    for (const i of idxs) this.deleted[i] = true;
    this.snapshot();
    return true;
  }

  
  restoreIndices(idx) {
    const idxs = [...new Set(idx)].filter((i) => Number.isInteger(i) && i >= 0 && i < this.deleted.length);
    if (!idxs.length) return false;
    if (!idxs.some((i) => this.deleted[i])) return false;
    for (const i of idxs) this.deleted[i] = false;
    this.snapshot();
    return true;
  }

  
  restoreRange(a, b) {
    if (a < 0 || b >= this.deleted.length || a > b) return false;
    if (!this.deleted.slice(a, b + 1).some((d) => d)) return false;
    for (let i = a; i <= b; i++) this.deleted[i] = false;
    this.snapshot();
    return true;
  }

  
  
  
  mergeRange(a, b) {
    if (a < 0 || b >= this.deleted.length || a > b) return false;
    if (a === b) return false;
    const st = this.deleted[a];
    for (let i = a + 1; i <= b; i++) if (this.deleted[i] !== st) return false;
    this.cuts.splice(a + 1, b - a);
    this.deleted.splice(a, b - a + 1, st);
    this.snapshot();
    return true;
  }






moveBoundary(k, t, side) {
  if (k < 1 || k > this.cuts.length - 2) return { code: 0 };
  const keptBefore = !this.deleted[k - 1];
  const keptAfter = !this.deleted[k];
  if (!keptBefore && !keptAfter) return { code: 0 };
  const lo = this.cuts[k - 1];
  const hi = this.cuts[k + 1];
  t = Math.min(Math.max(t, lo), hi);
  if (Math.abs(t - this.cuts[k]) < 1e-9) return { code: 0 };
  if (!this.suppressSnapshot) this.snapshot();
  if (keptBefore && keptAfter) {
    const left = side === k - 1 || side === 'left' || (side == null && t < this.cuts[k]);
    if (left) {
      t = Math.min(t, this.cuts[k]);
      if (t <= lo + 1e-9 || Math.abs(t - this.cuts[k]) < 1e-9) return { code: 0 };
      this.cuts.splice(k, 0, t);
      this.deleted.splice(k, 0, true);
      this._runsCache = null;
      return { code: 1 };
    }
    t = Math.max(t, this.cuts[k]);
    if (t >= hi - 1e-9 || Math.abs(t - this.cuts[k]) < 1e-9) return { code: 0 };
    const dk = this.deleted[k];
    this.cuts.splice(k + 1, 0, t);
    this.deleted[k] = true;
    this.deleted.splice(k + 1, 0, dk);
    this._runsCache = null;
    return { code: 1 };
  }
  if (t - lo < 1e-9) {
    
    this.cuts[k] = lo;
    this._runsCache = null;
    return { code: 1 };
  }
  if (hi - t < 1e-9) {
    
    this.cuts[k] = hi;
    this._runsCache = null;
    return { code: 1 };
  }
  this.cuts[k] = t;
  this._runsCache = null;
  return { code: 1 };
}

  keptRuns() {
    if (this._runsCache) return this._runsCache;
    const runs = [];
    let i = 0;
    const n = this.deleted.length;
    while (i < n) {
      if (this.deleted[i]) { i++; continue; }
      const start = this.cuts[i];
      let j = i;
      while (j < n && !this.deleted[j]) j++;
      runs.push([start, this.cuts[j]]);
      i = j;
    }
    this._runsCache = runs;
    return runs;
  }

  stats() {
    const runs = this.keptRuns();
    let kept = 0;
    for (const [s, e] of runs) kept += e - s;
    return { cuts: this.cuts.length - 1, kept, runs };
  }
}





const MARK = { y: 0, h: 18 };
const SEG = { y: 18, h: 64 };
const RULER = { y: 0, h: 18 };



const SEG_RADIUS = 7;




const SCAN_KF_PER_SEC = 6;
const SCAN_SPEED_MIN = 1;
const SCAN_SPEED_MAX = 20;



const STEP_PAUSE_MS = 200;














const SEEK_EPS = 0.001;

const ZOOM_MIN = 1;
const ZOOM_MAX = 20000;
const SCROLLBAR = {
  pad: 4,
  thumbMin: 80,
  caret: 12,
  tol: 4,
  track: 19,
  inset: 3
};
const RESIZE_TOL_PX = 7;
const WHEEL_LINE_PX = 40;          
const WHEEL_STEP_FRACTION = 0.12;  
const RENDER_CAP = 4000;           
const CARET_UPDATE_MS = 0.004;     
const DUR_EXTEND_MARGIN = 0.05;    
const CONVERT_INTERVALS = { low: 0.5, medium: 1 / 6, high: 0.1 };
const BLIP_MS = 80;                
const BLIP_PLAY_MS = 150;          
const HOLD_TO_SCAN_MS = 250;       
const SCAN_INTERVAL_MS = 33;       
const SCAN_SEEK_MS = 0.03;         
const EXPORT_CONCAT_PROGRESS = 0.97;
const WAVEFORM_FADE_MS = 220;

function hslToHex(hh, sat, lit) {
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = lit - c / 2;
  let r = 0, g = 0, b = 0;
  if (hh < 60) { r = c; g = x; }
  else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; }
  else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

function hexToHsl(hex) {
  const hx = hex.replace('#', '');
  const s = hx.length === 3 ? hx.split('').map((c) => c + c).join('') : hx;
  const n = parseInt(s, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, sat, l];
}

function pickMarkerColor(existing) {
  const used = (existing || []).map((c) => hexToHsl(c)).filter((c) => c != null);
  const candidates = [];
  for (let h = 30; h < 345; h += 4) {
    const sat = 0.22 + ((h % 7) / 7) * 0.10;
    const lit = 0.42 + ((h % 5) / 5) * 0.08;
    let minD = Infinity;
    for (const u of used) {
      const dh = Math.min(Math.abs(h - u[0]), 360 - Math.abs(h - u[0])) / 180;
      const ds = Math.abs(sat - u[1]);
      const dl = Math.abs(lit - u[2]);
      const d = Math.sqrt(dh * dh * 1.4 + ds * ds + dl * dl * 1.4);
      if (d < minD) minD = d;
    }
    candidates.push({ h, sat, lit, d: minD });
  }
  let maxD = 0;
  for (const c of candidates) if (c.d > maxD) maxD = c.d;
  let pool = candidates;
  if (used.length) pool = candidates.filter((c) => c.d >= maxD * 0.86);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return hslToHex(pick.h, pick.sat, pick.lit);
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function lightenHex(hex, f) {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s, 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function clipRuns(runs, start, end) {
  const out = [];
  for (const [s, e] of runs) {
    const a = Math.max(s, start);
    const b = Math.min(e, end);
    if (b > a) out.push([a, b]);
  }
  return out;
}

function subtractRuns(runs, start, end) {
  const out = [];
  for (const [s, e] of runs) {
    if (e <= start || s >= end) { out.push([s, e]); continue; }
    if (s < start) out.push([s, start]);
    if (e > end) out.push([end, e]);
  }
  return out;
}

function safeFileName(name) {
  const s = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return s || 'part';
}

const VIDEO_EXT_RE = /\.(mp4|mov|mkv|webm|m4v|avi|ts|mts|m2ts|flv|wmv)$/i;

function isVideoFile(p) {
  return typeof p === 'string' && VIDEO_EXT_RE.test(p);
}

function ellipsizeMidFit(s, avail, font) {
  if (!s) return s;
  const cv = ellipsizeMidFit._cv || (ellipsizeMidFit._cv = document.createElement('canvas').getContext('2d'));
  cv.font = font;
  if (cv.measureText(s).width <= avail) return s;
  let total = s.length;
  while (total > 4) {
    const keep = Math.max(4, Math.floor(total * 0.55));
    const out = s.slice(0, keep) + '…' + s.slice(-(total - keep - 1));
    if (cv.measureText(out).width <= avail) return out;
    total--;
  }
  return s.slice(0, 4) + '…' + s.slice(-4);
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function binaryFirst(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function binaryFirstRuns(runs, t) {
  let lo = 0, hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}



function snapKey(t, keys) {
  if (!keys || !keys.length) return t;
  let idx = binaryFirst(keys, t);
  if (idx >= keys.length) return keys[keys.length - 1];
  const prev = idx > 0 ? keys[idx - 1] : keys[0];
  const next = keys[idx];
  return (next - t <= t - prev + 1e-9) ? next : prev;
}

function endSnap(t, end, keys, fps) {
  const c = Math.max(0, Math.min(t, end));
  if (!end) return keys && keys.length ? snapKey(c, keys) : c;
  const last = keys && keys.length ? keys[keys.length - 1] : null;
  if (last != null && c >= last) return end;
  const tol = fps > 0 ? Math.max(1e-3, 1 / fps) : 1e-3;
  return (c >= end - tol) ? end : (keys && keys.length ? snapKey(c, keys) : c);
}

function prevKey(t, keys) {
  if (!keys || !keys.length) return t;
  const idx = binaryFirst(keys, t);
  if (idx >= keys.length) return keys[keys.length - 1];
  if (idx === 0) return keys[0];
  return keys[idx - 1];
}



function snapInRange(t, lo, hi, keys) {
  if (!keys || !keys.length) return t;
  const idx = binaryFirst(keys, t);
  let best = null;
  let bd = Infinity;
  for (const c of [idx - 1, idx, idx + 1]) {
    if (c >= 0 && c < keys.length && keys[c] >= lo - 1e-9 && keys[c] <= hi + 1e-9) {
      const d = Math.abs(keys[c] - t);
      if (d < bd) { bd = d; best = keys[c]; }
    }
  }
  return best !== null ? best : t;
}


function lastKeyAtOrBefore(t, keys) {
  if (!keys || !keys.length) return t;
  const idx = binaryFirst(keys, t);
  if (idx < keys.length && Math.abs(keys[idx] - t) < 1e-9) return keys[idx];
  if (idx > 0) return keys[idx - 1];
  return keys[0];
}

class Timeline {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.duration = 0;
    this.keyTimes = [];
    this.model = null;
    this.cursor = 0;
    this.viewStart = 0;
    this.pxPerSec = 50;
    this.playing = false;

    this.drag = null; 
    this.selected = null; 
    this.selectedAnchor = null; 
    this.selectedSet = null; 
    this.needsRender = true;
    this.ctrlHeld = false;
    this.hoverX = null;
    this.activeBlock = null;
    this.markers = [];
    this._markerSeq = 0;
    this.onMarkersChange = null;
    this.onMarkerEdit = null;
    this.onMarkerDragStart = null;
    this.onMarkerBubbleHide = null;
    this.onMarkerMove = null;
    this.onViewChanged = null;
    this._lastBubbleId = null;
    this.onZoom = null;
    this.onResize = null; 

    this.hatch = null;

    this.scrollbarEl = opts.scrollbar || null;
    this.thumbEl = opts.thumb || null;
    this.sb = SCROLLBAR;
    if (this.scrollbarEl && this.thumbEl) this.initScrollbar();

    
    
    this.cornerState = new Map(); 
    this._cornerRAF = null;

    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    this.canvas.addEventListener('mouseleave', () => {
      if (this.canvas.title) this.canvas.title = '';
      if (this.hoverX != null) {
        this.hoverX = null;
        this.needsRender = true;
        this.tick();
      }
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    this.resize();
    const ro = new ResizeObserver(() => { this.resize(); this.needsRender = true; this.tick(); });
    ro.observe(this.canvas);
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    if (this.duration > 0 && this.pxPerSec < this.minZoom()) {
      this.pxPerSec = this.minZoom();
    }
    this.clampView();
  }

  setData({ duration, keyTimes, model, cursor }) {
    this.duration = duration;
    this.keyTimes = keyTimes;
    this.model = model;
    this.selected = null; 
    this.selectedAnchor = null; 
    this.selectedSet = null; 
    this.activeBlock = null; 
    this.markers = [];
    if (cursor !== undefined) this.cursor = cursor;
    this.cornerState = new Map();
    this.fit();
    this.needsRender = true;
    this.tick();
  }

  
  get selectedIndex() {
    return this.selected ? this.selected[1] : null;
  }
  set selectedIndex(v) {
    if (v == null) {
      this.selected = null;
      this.selectedAnchor = null;
      this.selectedSet = null;
    } else {
      this.selected = [v, v];
      this.selectedAnchor = v;
      this.selectedSet = null;
    }
    this.needsRender = true;
    this.tick();
  }

  fit() {
    if (this.duration <= 0) return;
    this.viewStart = 0;
    this.pxPerSec = Math.min(ZOOM_MAX, this.w / this.duration);
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
  }

  clampView() {
    const viewW = this.w / this.pxPerSec;
    const maxStart = Math.max(0, this.duration - viewW);
    this.viewStart = Math.min(Math.max(0, this.viewStart), maxStart);
    this.updateScrollbar();
    if (this.onViewChanged) this.onViewChanged();
  }

  
  
  
  

  viewEnd() {
    return this.viewStart + this.w / this.pxPerSec;
  }

  scrollLeftPx(barW) {
    const u = Math.max(1, barW - 2 * SCROLLBAR.pad);
    return this.duration > 0 ? SCROLLBAR.pad + (this.viewStart / this.duration) * u : SCROLLBAR.pad;
  }

  scrollRightPx(barW) {
    const u = Math.max(1, barW - 2 * SCROLLBAR.pad);
    const e = Math.min(this.viewEnd(), this.duration);
    return this.duration > 0 ? SCROLLBAR.pad + (e / this.duration) * u : barW - SCROLLBAR.pad;
  }

  barTime(x, barW) {
    const u = Math.max(1, barW - 2 * SCROLLBAR.pad);
    const t = ((x - SCROLLBAR.pad) / u) * this.duration;
    return this.duration > 0 ? Math.min(Math.max(0, t), this.duration) : 0;
  }

  thumbVisual(barW) {
    const L = this.scrollLeftPx(barW);
    const R = this.scrollRightPx(barW);
    let left = L, right = R;
    if (R - L < SCROLLBAR.thumbMin) {
      const pad = SCROLLBAR.pad;
      const center = (L + R) / 2;
      left = center - SCROLLBAR.thumbMin / 2;
      right = center + SCROLLBAR.thumbMin / 2;
      if (left < pad) { left = pad; right = left + SCROLLBAR.thumbMin; }
      if (right > barW - pad) { right = barW - pad; left = Math.max(pad, right - SCROLLBAR.thumbMin); }
    }
    return { left, right };
  }

  setViewCenter(t) {
    this.viewStart = t - this.w / (2 * this.pxPerSec);
    this.clampView();
  }

  initScrollbar() {
    const bar = this.scrollbarEl;
    const caret = SCROLLBAR.caret;
    const tol = SCROLLBAR.tol;

    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = bar.getBoundingClientRect();
      const barW = rect.width;
      const x = e.clientX - rect.left;
      const g = this.thumbVisual(barW);
      const bodyL = g.left;
      const bodyR = g.right;

      let mode = 'pan';
      let grabOff = 0;
      if (x >= bodyL - tol && x <= bodyL + caret + tol) mode = 'left';
      else if (x >= bodyR - caret - tol && x <= bodyR + tol) mode = 'right';
      if (x < bodyL - tol || x > bodyR + tol) return;
      app.beginDragCursor(mode === 'pan' ? 'grabbing' : 'ew-resize');
      if (mode === 'left') grabOff = x - bodyL;
      else if (mode === 'right') grabOff = bodyR - x;
      const startX = x;
      const startView = this.viewStart;
      if (this.thumbEl) this.thumbEl.classList.add('dragging');

      const move = (ev) => {
        const nx = ev.clientX - rect.left;
        if (mode === 'left') this.dragLeftEdge(nx - grabOff, barW);
        else if (mode === 'right') this.dragRightEdge(nx + grabOff, barW);
        else {
          const u = Math.max(1, barW - 2 * SCROLLBAR.pad);
          this.viewStart = startView + ((nx - startX) / u) * this.duration;
          this.clampView();
        }
        this.needsRender = true;
        this.tick();
        this.updateScrollbar();
      };
      const up = () => {
        this.updateScrollbar();
        if (this.thumbEl) this.thumbEl.classList.remove('dragging');
        app.endDragCursor();
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  minZoom() {
    return this.duration > 0 ? this.w / this.duration : ZOOM_MIN;
  }

  minViewW() {
    return this.w / ZOOM_MAX;
  }

  dragLeftEdge(x, barW) {
    const end = Math.min(this.viewEnd(), this.duration);
    const leftT = Math.min(this.barTime(x, barW), end - this.minViewW());
    const viewW = Math.max(this.minViewW(), end - leftT);
    this.pxPerSec = Math.max(this.minZoom(), Math.min(ZOOM_MAX, this.w / viewW));
    this.viewStart = end - viewW;
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
  }

  dragRightEdge(x, barW) {
    const rightT = Math.max(this.barTime(x, barW), this.viewStart + this.minViewW());
    const viewW = Math.max(this.minViewW(), rightT - this.viewStart);
    this.pxPerSec = Math.max(this.minZoom(), Math.min(ZOOM_MAX, this.w / viewW));
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
  }

  updateScrollbar() {
    if (!this.scrollbarEl || !this.thumbEl) return;
    const barW = this.scrollbarEl.clientWidth || 0;
    const g = this.thumbVisual(barW);
    this.thumbEl.style.left = g.left + 'px';
    this.thumbEl.style.width = Math.max(0, g.right - g.left) + 'px';
  }

  timeToX(t) { return (t - this.viewStart) * this.pxPerSec; }
  xToTime(x) { return this.viewStart + x / this.pxPerSec; }

  
  setZoom(pps) {
    const pps2 = Math.max(this.minZoom(), Math.min(ZOOM_MAX, pps));
    if (this.duration <= 0) { this.pxPerSec = pps2; return; }
    const center = this.viewStart + this.w / (2 * this.pxPerSec);
    this.pxPerSec = pps2;
    this.viewStart = center - this.w / (2 * pps2);
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
    this.needsRender = true;
    this.tick();
  }

  
  
  zoomAt(mx, factor) {
    const oldPPS = this.pxPerSec;
    const t = this.xToTime(mx);
    this.pxPerSec = Math.max(this.minZoom(), Math.min(ZOOM_MAX, oldPPS * factor));
    this.viewStart = t - mx / this.pxPerSec;
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
    this.needsRender = true;
    this.tick();
  }

  
  
  
  
  

  radiusAt(t) {
    const s = this.cornerState.get(t);
    return s !== undefined ? s : SEG_RADIUS;
  }

  
  captureCornerTargets() {
    if (!this.model || !this.model.cuts.length) return new Set();
    return new Set(this.model.cuts);
  }

  
  
  applyCornerChange(before) {
    if (!this.model || !this.model.cuts.length) return;
    let seeded = false;
    for (const t of this.model.cuts) {
      if (!before.has(t)) {
        this.cornerState.set(t, 0);
        seeded = true;
      }
    }
    if (seeded && !this._cornerRAF) {
      this._cornerRAF = requestAnimationFrame(() => this.cornerAnimTick());
    }
  }

  cornerAnimTick() {
    this._cornerRAF = null;
    for (const [t, cur] of Array.from(this.cornerState)) {
      const v = cur + (SEG_RADIUS - cur) * 0.18;
      if (Math.abs(v - SEG_RADIUS) < 0.5) this.cornerState.delete(t);
      else this.cornerState.set(t, v);
    }
    if (this.cornerState.size) {
      this.needsRender = true;
      this.tick();
      this._cornerRAF = requestAnimationFrame(() => this.cornerAnimTick());
    }
  }

  

  regionAt(y) {
    if (y >= MARK.y && y < MARK.y + MARK.h) return 'mark';
    if (y >= SEG.y && y < SEG.y + SEG.h) return 'seg';
    return null;
  }

  setCursor(t, fromVideo = false) {
    const end = this.duration || 0;
    t = endSnap(t, end, this.activeKeys || this.keyTimes, app && app.state ? app.state.fps : 0);
    t = Math.min(Math.max(0, t), end);
    this.cursor = t;
    if (!fromVideo) app.seek(t);
    this.needsRender = true;
    this.tick();
  }

toggleSelectSegment(i) {
    if (!this.model || i < 0 || i >= this.model.deleted.length) return;
    if (!this.selectedSet) {
      const anchor = this.activeIndex();
      this.selectedSet = new Set([anchor]);
      this.selectedAnchor = anchor;
    }
    if (i === this.selectedAnchor) {
      this.selectedSet.add(i);
    } else if (this.selectedSet.has(i)) {
      this.selectedSet.delete(i);
    } else {
      this.selectedSet.add(i);
    }
    this.selectedSet.add(this.selectedAnchor);
    if (this.selectedSet.size === 0) this.selectedSet = null;
    this.selected = null;
    this.needsRender = true;
    this.tick();
  }

  extendSelectRange(i) {
    if (!this.model || i < 0 || i >= this.model.deleted.length) return;
    const anchor = this.activeIndex();
    this.selected = [Math.min(anchor, i), Math.max(anchor, i)];
    this.selectedSet = null;
    this.selectedAnchor = anchor;
    this.needsRender = true;
    this.tick();
  }

  clearSelection() {
    this.selected = null;
    this.selectedAnchor = null;
    this.selectedSet = null;
    this.needsRender = true;
    this.tick();
  }

  selectionIndices() {
    if (this.selectedSet && this.selectedSet.size) return [...this.selectedSet];
    if (this.selected) {
      const [a, b] = this.selected;
      const out = [];
      for (let i = a; i <= b; i++) out.push(i);
      return out;
    }
    return [];
  }

  activeIndex() {
    if (this.model && this.activeBlock != null && this.activeBlock >= 0 && this.activeBlock < this.model.deleted.length) {
      return this.activeBlock;
    }
    return this.model ? this.model.segmentOf(this.cursor) : 0;
  }

  markerAt(x) {
    if (!this.markers || !this.markers.length) return null;
    for (const m of this.markers) {
      const mx = this.timeToX(m.t);
      if (Math.abs(mx - x) <= 8) return m;
    }
    return null;
  }

  markerTimeAt(x) {
    return snapKey(this.xToTime(x), this.keyTimes);
  }

  moveMarkerTo(id, t) {
    const m = this.markers.find((x) => x.id === id);
    if (!m) return;
    m.t = this.clampMarkerTime(id, t);
    this.needsRender = true;
    this.tick();
    if (this.onMarkerDragStart) this.onMarkerDragStart();
    if (this.onMarkerMove) this.onMarkerMove(m.t);
    if (this.onMarkersChange) this.onMarkersChange();
  }

  addMarkerAt(t) {
    if (!this.model) return null;
    const end = this.duration || 0;
    const mt = endSnap(t, end, this.keyTimes, app && app.state ? app.state.fps : 0);
    const mk = { id: ++this._markerSeq, t: mt, name: 'part_' + (this.markers.length + 1), color: pickMarkerColor(this.markers.map((m) => m.color)) };
    mk.t = this.clampMarkerTime(mk.id, mk.t);
    const existing = this.markers.find((m) => Math.abs(m.t - mk.t) < 1e-6);
    if (existing) {
      this._lastBubbleId = null;
      return existing;
    }
    this.markers.push(mk);
    this.needsRender = true;
    this.tick();
    this.model.snapshot();
    this._lastBubbleId = mk.id;
    if (this.onMarkerEdit) this.onMarkerEdit(mk);
    if (this.onMarkersChange) this.onMarkersChange();
    return mk;
  }

  nextKeyAfter(t) {
    const keys = this.keyTimes || [];
    const idx = binaryFirst(keys, t + 1e-9);
    return idx < keys.length ? keys[idx] : t;
  }

  prevKeyBefore(t) {
    const keys = this.keyTimes || [];
    const idx = binaryFirst(keys, t);
    let i = idx;
    if (i < keys.length && Math.abs(keys[i] - t) < 1e-9) i--;
    return i >= 0 ? keys[i] : t;
  }

  clampMarkerTime(id, t) {
    const keys = this.keyTimes || [];
    const end = this.duration || 0;
    const fps = app && app.state ? app.state.fps : 0;
    if (!keys.length) return endSnap(t, end, null, fps);
    let final = endSnap(t, end, keys, fps);
    const m = this.markers.find((x) => x.id === id);
    const orig = m ? m.t : final;
    const others = this.markers.filter((x) => x.id !== id).slice().sort((a, b) => a.t - b.t);
    let left = null;
    let right = null;
    for (const o of others) {
      if (o.t < orig) left = o;
      else { right = o; break; }
    }
    if (left) {
      const nx = this.nextKeyAfter(left.t);
      if (final < nx) final = nx;
    }
    if (right) {
      const pv = this.prevKeyBefore(right.t);
      if (final > pv) final = pv;
    }
    return final;
  }

  onDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (app && app.closeFind) app.closeFind();
    const region = this.regionAt(y);
    if (app.cancelStepPause) app.cancelStepPause();
    const bubbleWasOpen = app && app._markerBubbleId;
    if (this.onMarkerDragStart) this.onMarkerDragStart();
    app.beginDragCursor();
    
    
    const pan = e.button === 1 || region === null;
    
    
    if (region === 'mark') {
      if (e.button === 1) {
        this.drag = { mode: 'pan', lastX: x, moved: false, x, y, region, pendingMiddleMarker: true };
        this.canvas.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }
      if (app.video && !app.video.paused) app.pause();
      const near = this.markerAt(x);
      if (near) {
        this.drag = { mode: 'marker', id: near.id, lastX: x, x, y, region };
        this.canvas.style.cursor = 'grabbing';
        this._markerToggleOff = bubbleWasOpen === near.id;
        if (this.onMarkerDragStart) this.onMarkerDragStart();
        e.preventDefault();
        return;
      }
      this.drag = { mode: 'scrub', lastX: x, moved: false, x, y, region };
      this.canvas.style.cursor = 'grabbing';
      this.setCursor(this.xToTime(x));
      if (this.onScrub) this.onScrub(this.cursor);
      e.preventDefault();
      return;
    }
    
    
    const rk = (!pan && region === 'seg' && this.ctrlHeld && !e.altKey) ? this.resizeBoundaryAt(x) : null;
    if (rk != null) {
      
      if (app.video && !app.video.paused) app.pause();
      this.drag = { mode: 'resize', k: rk, side: null, lastX: x, x, y, region };
      this.canvas.style.cursor = 'ew-resize';
      if (!this.model.deleted[rk - 1] && !this.model.deleted[rk]) {
        this.drag.activeBlock = null;
      } else {
        this.drag.activeBlock = !this.model.deleted[rk - 1] ? rk - 1 : rk;
        this.activeBlock = this.drag.activeBlock;
      }
      
      
      this.model.suppressSnapshot = true;
      this._dragBefore = { cuts: this.model.cuts.slice(), deleted: this.model.deleted.slice() };
      e.preventDefault();
      return;
    }
    this.drag = { mode: pan ? 'pan' : 'scrub', lastX: x, moved: false, x, y, region };
    if (pan) this.canvas.style.cursor = 'grabbing';
    if (!pan) {
      
      if (app.video && !app.video.paused) app.pause();
      const rawT = this.xToTime(x);
      let snapT = rawT;
      if (region === 'seg') {
        const block = this.model.segmentOf(rawT);
        snapT = prevKey(rawT, this.activeKeys || this.keyTimes);
        if (e.altKey) this.toggleSelectSegment(block);
        else if (e.shiftKey) this.extendSelectRange(block);
        else this.clearSelection();
      }
      this.setCursor(snapT);
      if (this.onScrub) this.onScrub(this.cursor);
    }
    e.preventDefault();
  }

  onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    this.hoverX = x;
    if (!this.drag) {
      const region = this.regionAt(e.clientY - rect.top);
      const isMark = region === 'mark';
      const hm = isMark ? this.markerAtX(x) : null;
      const rk = (this.ctrlHeld && region === 'seg') ? this.resizeBoundaryAt(x) : null;
      if (hm) {
        this.canvas.title = hm.name;
        this.canvas.style.cursor = 'pointer';
      } else if (this.canvas.title) {
        this.canvas.title = '';
      }
      if (rk != null) this.canvas.style.cursor = 'ew-resize';
      else if (!hm) this.canvas.style.cursor = 'default';
      this.needsRender = true;
      this.tick();
      return;
    }
    const dx = x - this.drag.lastX;
    if (Math.abs(dx) > 1) this.drag.moved = true;
    if (this.drag.mode === 'pan') {
      this.viewStart -= dx / this.pxPerSec;
      this.clampView();
    } else if (this.drag.mode === 'resize') {
      this.resizeTo(this.drag.k, this.xToTime(x));
    } else if (this.drag.mode === 'marker') {
      this.moveMarkerTo(this.drag.id, this.xToTime(x));
    } else {
      this.setCursor(this.xToTime(x));
      if (this.onScrub) this.onScrub(this.cursor);
    }
    this.drag.lastX = x;
    if (this.drag.mode === 'pan') this.canvas.style.cursor = 'grabbing';
    else if (this.drag.mode === 'resize') this.canvas.style.cursor = 'ew-resize';
    else if (this.drag.mode === 'marker' || this.drag.mode === 'scrub') this.canvas.style.cursor = 'grabbing';
    this.needsRender = true;
    this.tick();
  }

  markerAtX(x) {
    if (!this.markers || !this.markers.length) return null;
    for (const m of this.sortedMarkers()) {
      if (Math.abs(this.timeToX(m.t) - x) <= 8) return m;
    }
    return null;
  }

  onUp() {
    app.endDragCursor();
    if (this.drag && this.drag.mode === 'scrub' && this.onScrubEnd) this.onScrubEnd();
    const wasMarker = this.drag && this.drag.mode === 'marker';
    const markerId = wasMarker ? this.drag.id : null;
    const pendingMid = this.drag && this.drag.pendingMiddleMarker;
    const midX = this.drag ? this.drag.x : null;
    const moved = this.drag ? this.drag.moved : false;
    this.endResizeDrag();
    this.drag = null;
    this.canvas.style.cursor = 'default';
    if (pendingMid) {
      if (!moved && midX != null) this.toggleMarkerAtX(midX);
    } else if (wasMarker && markerId != null) {
      if (moved) {
        this._lastBubbleId = null;
        if (this.model) this.model.snapshot();
      } else {
        const toggleOff = this._markerToggleOff;
        this._markerToggleOff = false;
        if (toggleOff) {
          this._lastBubbleId = null;
          if (this.onMarkerBubbleHide) this.onMarkerBubbleHide();
        } else {
          this._lastBubbleId = markerId;
          const m = this.markers.find((x) => x.id === markerId);
          if (m && this.onMarkerEdit) this.onMarkerEdit(m);
        }
      }
    }
  }

  toggleMarkerAtX(x) {
    const nm = this.markerAt(x);
    if (nm) {
      this.markers = this.markers.filter((m) => m.id !== nm.id);
      this.needsRender = true;
      this.tick();
      this.model.snapshot();
      this._lastBubbleId = null;
      if (this.onMarkersChange) this.onMarkersChange();
      if (this.onMarkerBubbleHide) this.onMarkerBubbleHide();
      return;
    }
    const mkT = this.clampMarkerTime(null, this.markerTimeAt(x));
    const existing = this.markers.find((m) => Math.abs(m.t - mkT) < 1e-6);
    if (existing) {
      this.markers = this.markers.filter((m) => m.id !== existing.id);
      this.needsRender = true;
      this.tick();
      this.model.snapshot();
      this._lastBubbleId = null;
      if (this.onMarkersChange) this.onMarkersChange();
      if (this.onMarkerBubbleHide) this.onMarkerBubbleHide();
      return;
    }
    const mk = { id: ++this._markerSeq, t: mkT, name: 'part_' + (this.markers.length + 1), color: pickMarkerColor(this.markers.map((m) => m.color)) };
    this.markers.push(mk);
    this.needsRender = true;
    this.tick();
    this.model.snapshot();
    this._lastBubbleId = mk.id;
    if (this.onMarkerEdit) this.onMarkerEdit(mk);
    if (this.onMarkersChange) this.onMarkersChange();
  }

  
  
  
  
  endResizeDrag() {
    if (!this._dragBefore) return;
    const before = this._dragBefore;
    this._dragBefore = null;
    this.model.suppressSnapshot = false;
    
    if (!arraysEqual(this.model.cuts, before.cuts) || !arraysEqual(this.model.deleted, before.deleted)) {
      this.model.snapshot();
    }
  }

  setCtrlHeld(v) {
    v = !!v;
    if (this.ctrlHeld === v) return;
    this.ctrlHeld = v;
    this.needsRender = true;
    this.tick();
  }

  
  resizableBoundary(k) {
    if (!this.model || k < 1 || k > this.model.cuts.length - 2) return false;
    const b = this.model.deleted;
    return b[k - 1] !== b[k] || (!b[k - 1] && !b[k]);
  }

  
  resizeBoundaryAt(x) {
    if (!this.model) return null;
    const t = this.xToTime(x);
    const cuts = this.model.cuts;
    const i = this.model.segmentOf(t);
    const tol = RESIZE_TOL_PX / this.pxPerSec;
    let best = null;
    let bd = Infinity;
    for (const k of [i, i + 1]) {
      if (k < 1 || k > cuts.length - 2 || !this.resizableBoundary(k)) continue;
      const d = Math.abs(cuts[k] - t);
      if (d <= tol && d < bd) { bd = d; best = k; }
    }
    return best;
  }

  resizeTo(k, t) {
    const cuts = this.model.cuts;
    const lo = cuts[k - 1];
    const hi = cuts[k + 1];
    const keptBefore = !this.model.deleted[k - 1];
    const keptAfter = !this.model.deleted[k];
    const junction = keptBefore && keptAfter;
    let side = this.drag ? this.drag.side : null;
    if (junction) {
      if (side !== 'left' && side !== 'right' && Math.abs(t - cuts[k]) > 1e-6) {
        side = t < cuts[k] ? 'left' : 'right';
        if (this.drag) this.drag.side = side;
      }
    } else {
      side = null;
    }
    const snapLo = junction && side === 'left' ? lo : (junction && side === 'right' ? cuts[k] : lo);
    const snapHi = junction && side === 'left' ? cuts[k] : (junction && side === 'right' ? hi : hi);
    const snapped = snapInRange(t, snapLo, snapHi, this.keyTimes);
    const origBoundary = cuts[k];
    const before = this.captureCornerTargets();
    const res = this.model.moveBoundary(k, snapped, this.drag ? this.drag.side : null);
    if (res.code === 0) return;
    if (res.code === 1 && junction && side === 'right' && this.drag) {
      this.drag.k = k + 1;
    }
    this.applyCornerChange(before);
    if (this.onResize) this.onResize();
    this.cursor = snapped;
    app.seek(snapped);
    if (this.drag && this.drag.mode === 'resize') {
      if (junction) {
        if (snapped > origBoundary + 1e-9) this.activeBlock = this.model.segmentOf(origBoundary - 1e-6);
        else if (snapped < origBoundary - 1e-9) this.activeBlock = this.model.segmentOf(origBoundary + 1e-6);
      } else {
        const kk = this.drag.k;
        this.activeBlock = !this.model.deleted[kk - 1] ? kk - 1 : kk;
      }
    }
    
    if (this.selected && this.selected[1] >= this.model.cuts.length - 1) {
      this.selected = null;
      this.selectedAnchor = null;
    }
    if (this.selectedSet) {
      const valid = [...this.selectedSet].filter((i) => i >= 0 && i < this.model.deleted.length);
      this.selectedSet = valid.length ? new Set(valid) : null;
    }
    this.needsRender = true;
    this.tick();
  }

  onWheel(e) {
    e.preventDefault();
    if (this.drag) return;
    if (e.ctrlKey) {
      
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const factor = e.deltaY < 0 ? 1.4 : 1 / 1.4;
      this.zoomAt(x, factor);
      return;
    }
    
    
    
    let dy = e.deltaY;
    let dx = e.deltaX;
    if (e.deltaMode === 1) { dy *= WHEEL_LINE_PX; dx *= WHEEL_LINE_PX; }
    else if (e.deltaMode === 2) { dy *= this.h; dx *= this.h; }
    const step = ((this.w / this.pxPerSec) * WHEEL_STEP_FRACTION) / 100;
    this.viewStart += (dy - dx) * step;
    this.clampView();
    this.needsRender = true;
    this.tick();
  }

  

  tick() {
    if (app && app.timelineViewChanged) app.timelineViewChanged();
    if (this.needsRender) {
      this.needsRender = false;
      this.render();
    }
  }

  render() {
    const ctx = this.ctx;
    const w = this.w, h = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.duration <= 0 || !this.model) {
      ctx.fillStyle = COLORS.noVideoBg;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = COLORS.noVideoText;
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
      ctx.textAlign = 'center';
      ctx.fillText('No video loaded', w / 2, h / 2);
      return;
    }

    const viewEnd = this.viewStart + w / this.pxPerSec;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    this.renderWaveform(ctx, viewEnd);
    this.renderSegments(ctx, viewEnd);
    this.renderKeyframes(ctx, viewEnd);
    this.renderSelection(ctx);
    this.renderActiveSegment(ctx, viewEnd);
    this.renderResizeHandles(ctx, viewEnd);
    this.renderRulerBg(ctx);
    this.renderMarkerRanges(ctx);
    this.renderRuler(ctx);
    this.renderMarkerGlyphs(ctx);

    ctx.fillStyle = COLORS.separator;
    ctx.fillRect(0, MARK.y + MARK.h, w, 1);
    this.renderPlayhead(ctx);
  }

  renderMarkerRanges(ctx) {
    if (!this.markers || !this.markers.length) return;
    const sorted = this.markers.slice().sort((a, b) => a.t - b.t);
    let prev = 0;
    for (const m of sorted) {
      const xa = this.timeToX(prev);
      const xb = this.timeToX(m.t);
      if (xb > -12 && xa < this.w + 12) {
        ctx.save();
        ctx.globalAlpha = m.off ? SEG_OFF_ALPHA : SEG_KEPT_ALPHA;
        ctx.fillStyle = this.segGradient(lightenHex(m.color, 1.2), m.color, MARK.y, MARK.h);
        ctx.fillRect(xa, MARK.y, Math.max(0, xb - xa), MARK.h);
        ctx.restore();
      }
      prev = m.t;
    }
  }

  renderMarkerGlyphs(ctx) {
    if (!this.markers || !this.markers.length) return;
    const sorted = this.markers.slice().sort((a, b) => a.t - b.t);
    for (const m of sorted) {
      const x = this.timeToX(m.t);
      if (x < -12 || x > this.w + 12) continue;
      const gx = Math.max(4, Math.min(x, this.w - 4));
      const img = this.glyphFor('#ffffff');
      if (img && img.complete) {
        ctx.save();
        ctx.filter = 'brightness(1.35)';
        ctx.drawImage(img, gx - 8, MARK.y + 1, 14, 14);
        ctx.restore();
      }
      ctx.fillStyle = m.off ? 'rgba(170,180,190,0.85)' : 'rgba(255,255,255,0.9)';
      ctx.fillRect(x - 0.5, MARK.y + MARK.h + 2, 1, Math.max(0, SEG.y + SEG.h - MARK.y - MARK.h - 2));
    }
  }

  glyphFor(color) {
    if (!this._glyphs) this._glyphs = {};
    if (this._glyphs[color]) return this._glyphs[color];
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><path d="M16 4 v12 M12 4 h4 M12 16 h4" stroke="' + color + '" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M12 10 h-6 M6 10 l3.5 -2.5 M6 10 l3.5 2.5" stroke="' + color + '" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const img = new Image();
    img.onload = () => {
      if (this.needsRender != null) {
        this.needsRender = true;
        this.tick();
      }
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(svg);
    this._glyphs[color] = img;
    return img;
  }

  markerAtTime(t) {
    if (!this.markers || !this.markers.length) return null;
    const sorted = this.sortedMarkers();
    for (const m of sorted) {
      if (t < m.t) return m;
    }
    return null;
  }

  markerColorAt(t) {
    const m = this.markerAtTime(t);
    return m ? m.color : null;
  }

  sortedMarkers() {
    return this.markers.slice().sort((a, b) => a.t - b.t);
  }

  segGradient(from, to, y, h) {
    const g = this.ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    return g;
  }

  renderSelection(ctx) {
    const cuts = this.model && this.model.cuts;
    if (!cuts) return;
    const idx = this.selectionIndices();
    if (!idx.length) return;
    const top = SEG.y + 1;
    const bottom = SEG.y + SEG.h - 1;
    for (const i of idx) {
      if (i < 0 || i >= cuts.length - 1) continue;
      const x0 = this.timeToX(cuts[i]);
      const x1 = this.timeToX(cuts[i + 1]);
      if (x1 < 0 || x0 > this.w) continue;
      const gray = this.model.deleted[i];
      ctx.save();
      ctx.fillStyle = gray ? 'rgba(216,222,230,0.14)' : 'rgba(255,255,255,0.20)';
      ctx.beginPath();
      ctx.roundRect(x0, top, Math.max(0, x1 - x0), bottom - top, [SEG_RADIUS, SEG_RADIUS, SEG_RADIUS, SEG_RADIUS]);
      ctx.fill();
      ctx.strokeStyle = gray ? COLORS.selectionGray : COLORS.selectionKept;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  
  
  renderResizeHandles(ctx, viewEnd) {
    if (!this.model || !this.ctrlHeld) return;
    const cuts = this.model.cuts;
    let k = null;
    if (this.drag && this.drag.mode === 'resize') {
      k = this.drag.k;
    } else if (this.hoverX != null) {
      k = this.resizeBoundaryAt(this.hoverX);
    }
    if (k == null || k < 1 || k > cuts.length - 2 || !this.resizableBoundary(k)) return;
    const x = this.timeToX(cuts[k]);
    if (x < -10 || x > this.w + 10) return;
    const cy = SEG.y + SEG.h / 2;
    ctx.fillStyle = COLORS.resizeHandle;
    ctx.beginPath();
    ctx.moveTo(x - 4, cy - 3.2); ctx.lineTo(x - 0.6, cy); ctx.lineTo(x - 4, cy + 3.2); ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 4, cy - 3.2); ctx.lineTo(x + 0.6, cy); ctx.lineTo(x + 4, cy + 3.2); ctx.closePath();
    ctx.fill();
  }

  renderActiveSegment(ctx, viewEnd) {
    const cuts = this.model.cuts;
    if (!cuts || cuts.length < 2) return;
    if (this.selectionIndices().length) return;
    const i = this.activeIndex();
    if (i < 0 || i >= cuts.length - 1) return;
    const x0 = this.timeToX(cuts[i]);
    const x1 = this.timeToX(cuts[i + 1]);
    if (x1 < 0 || x0 > this.w) return;
    const top = SEG.y + 2;
    const bottom = SEG.y + SEG.h - 1;
    const rl = this.radiusAt(cuts[i]);
    const rr = this.radiusAt(cuts[i + 1]);
    ctx.save();
    ctx.strokeStyle = COLORS.activeSeg;
    ctx.lineWidth = 2;
    ctx.shadowColor = COLORS.activeSegGlow;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.roundRect(x0, top, x1 - x0, bottom - top, [rl, rr, rr, rl]);
    ctx.stroke();
    ctx.restore();
  }

  renderSegments(ctx, viewEnd) {
    const { y, h } = SEG;
    const model = this.model;
    const cuts = model.cuts;

    
    const first = Math.max(0, binaryFirst(cuts, this.viewStart) - 1);
    const last = Math.min(cuts.length - 1, binaryFirst(cuts, viewEnd));
    const visibleCount = last - first;

    
    if (visibleCount > RENDER_CAP) {
      this.renderSegmentsAggregated(ctx, viewEnd, y, h);
      return;
    }

    for (let i = first; i < last; i++) {
      const t0 = cuts[i], t1 = cuts[i + 1];
      if (t0 > viewEnd) break;
      const x0 = this.timeToX(t0);
      const x1 = this.timeToX(t1);
      if (x1 < 0) continue;
      const deleted = model.deleted[i];
      const rl = this.radiusAt(cuts[i]);
      const rr = this.radiusAt(cuts[i + 1]);
      const radii = [rl, rr, rr, rl];
      ctx.beginPath();
      ctx.roundRect(x0, y, x1 - x0, h, radii);
      if (deleted) {
        ctx.save();
        ctx.globalAlpha = SEG_DELETED_ALPHA;
        ctx.fillStyle = COLORS.segDeleted;
        ctx.fill();
        if (!this.hatch) this.makeHatch();
        ctx.fillStyle = this.hatch;
        ctx.fill();
        ctx.restore();
        
        ctx.strokeStyle = COLORS.segDeletedFrame;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (x1 - x0 >= 28) {
          const cx = (x0 + x1) / 2;
          const cy = y + h / 2;
          const s = 6;
          ctx.save();
          ctx.strokeStyle = 'rgba(210,220,230,0.7)';
          ctx.lineWidth = 1.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx - s, cy - s);
          ctx.lineTo(cx + s, cy + s);
          ctx.moveTo(cx + s, cy - s);
          ctx.lineTo(cx - s, cy + s);
          ctx.stroke();
          ctx.restore();
        }
      } else {
        ctx.save();
        ctx.globalAlpha = SEG_KEPT_ALPHA;
        ctx.beginPath();
        ctx.roundRect(x0, y, x1 - x0, h, radii);
        ctx.clip();
        const pts = [t0];
        const sm = this.sortedMarkers();
        for (const m of sm) if (m.t > t0 + 1e-9 && m.t < t1 - 1e-9) pts.push(m.t);
        pts.push(t1);
        for (let b = 0; b < pts.length - 1; b++) {
          const m = this.markerAtTime(pts[b]);
          const reg = m ? m.color : null;
          const xa = this.timeToX(pts[b]);
          const xb = this.timeToX(pts[b + 1]);
          ctx.fillStyle = reg
            ? this.segGradient(lightenHex(reg, 1.2), reg, y, h)
            : this.segGradient(COLORS.segKeptFrom, COLORS.segKeptTo, y, h);
          if (m && m.off) ctx.globalAlpha = SEG_OFF_ALPHA;
          ctx.fillRect(xa, y, xb - xa, h);
          if (m && m.off) ctx.globalAlpha = SEG_KEPT_ALPHA;
        }
        ctx.restore();
      }
    }

    
    for (let k = first + 1; k < last; k++) {
      if (model.deleted[k - 1] === model.deleted[k]) {
        const x = this.timeToX(cuts[k]);
        if (x < 0 || x > this.w) continue;
        ctx.fillStyle = COLORS.segBoundary;
        ctx.fillRect(x - 0.5, y + 3, 1, h - 6);
      }
    }
  }

  renderSegmentsAggregated(ctx, viewEnd, y, h) {
    const runs = this.model.keptRuns();
    const n = runs.length;
    ctx.fillStyle = COLORS.segDeleted;
    ctx.fillRect(0, y, this.w, h);
    let cs = -1, ce = -1;
    const flush = () => {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, COLORS.segKeptFrom);
      g.addColorStop(1, COLORS.segKeptTo);
      ctx.fillStyle = g;
      ctx.fillRect(cs, y, ce - cs + 1, h);
    };
    let first = binaryFirstRuns(runs, this.viewStart) - 1;
    if (first < 0) first = 0;
    for (let i = first; i < n; i++) {
      const [s, e] = runs[i];
      if (s > viewEnd) break;
      const x0 = Math.max(0, Math.round(this.timeToX(s)));
      const x1 = Math.min(this.w, Math.round(this.timeToX(e)));
      if (x1 < 0) continue;
      if (x0 > this.w) break;
      if (cs < 0) { cs = x0; ce = x1; }
      else if (x0 <= ce + 1) { ce = Math.max(ce, x1); }
      else { flush(); cs = x0; ce = x1; }
    }
    if (cs >= 0) flush();
  }

  makeHatch() {
    this.hatch = this.makeHatchPattern(COLORS.hatch);
  }

  makeHatchPattern(color) {
    const off = document.createElement('canvas');
    off.width = 8;
    off.height = 8;
    const c = off.getContext('2d');
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-2, 10);
    c.lineTo(10, -2);
    c.stroke();
    return ctxCreatePattern(this.ctx, off);
  }

  renderKeyframes(ctx, viewEnd) {
    const keys = this.keyTimes;
    if (!keys || !keys.length || !this.model) return;
    const cuts = this.model.cuts;
    const pps = this.pxPerSec;
    const offRanges = [];
    {
      let prev = 0;
      for (const m of this.sortedMarkers()) {
        if (m.off) offRanges.push([prev, m.t]);
        prev = m.t;
      }
    }
    
    
    
    
    const lineH = SEG.h * 0.98;
    const top = SEG.y + (SEG.h - lineH) / 2;
    const bottom = top + lineH;
    const c0 = Math.max(0, Math.round(this.timeToX(this.viewStart)));
    const c1 = Math.min(this.w, Math.round(this.timeToX(viewEnd)));
    for (let col = c0; col <= c1; col++) {
      const lo = this.viewStart + (col - 0.5) / pps;
      let ki = binaryFirst(keys, lo);
      if (ki >= keys.length || Math.round(this.timeToX(keys[ki])) !== col) continue;
      const t = keys[ki];
      let ci = binaryFirst(cuts, lo);
      const bright = ci < cuts.length && Math.round(this.timeToX(cuts[ci])) === col;
      const gray = this.model.deleted[this.model.segmentOf(t)];
      const inOff = !gray && offRanges.some(([a, b]) => t >= a - 1e-9 && t < b - 1e-9);
      if (gray || inOff) {
        const a = bright ? COLORS.keyframeGrayAlphaBright : COLORS.keyframeGrayAlphaDim;
        ctx.fillStyle = 'rgba(' + COLORS.keyframeGrayRgb + ',' + a + ')';
      } else {
        const a = bright ? COLORS.keyframeAlphaBright : COLORS.keyframeAlphaDim;
        ctx.fillStyle = 'rgba(' + COLORS.keyframeRgb + ',' + a + ')';
      }
      ctx.fillRect(col - 0.5, top, 1, bottom - top);
    }
  }

  renderRulerBg(ctx) {
    ctx.fillStyle = COLORS.rulerBg;
    ctx.fillRect(0, RULER.y, this.w, RULER.h);
  }

  renderWaveform(ctx, viewEnd) {
    const wf = app && app.state && app.state.waveform;
    if (!wf || !wf.enabled) return;
    if (!this._wfLayer || this._wfLayer.width !== Math.round(this.w * this.dpr) || this._wfLayer.height !== Math.round(this.h * this.dpr)) {
      this._wfLayer = document.createElement('canvas');
      this._wfLayer.width = Math.round(this.w * this.dpr);
      this._wfLayer.height = Math.round(this.h * this.dpr);
    }
    const lc = this._wfLayer.getContext('2d');
    lc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    lc.clearRect(0, 0, this.w, this.h);
    const viewStart = this.viewStart;
    for (const slice of wf.slices.values()) {
      if (!slice || !slice.img) continue;
      if (slice.to < viewStart || slice.from > viewEnd) continue;
      const x = this.timeToX(slice.from);
      const w = (slice.to - slice.from) * this.pxPerSec;
      const visX0 = Math.max(0, x);
      const visX1 = Math.min(this.w, x + w);
      if (visX1 <= visX0) continue;
      const img = slice.img;
      const srcX = (visX0 - x) / w * img.naturalWidth;
      const srcW = (visX1 - visX0) / w * img.naturalWidth;
      if (slice.birth != null && WAVEFORM_FADE_MS > 0) {
        const alpha = Math.max(0, Math.min(1, (performance.now() - slice.birth) / WAVEFORM_FADE_MS));
        if (alpha >= 1) slice.birth = null;
        lc.globalAlpha = alpha;
        lc.drawImage(img, srcX, 0, srcW, img.naturalHeight, visX0, SEG.y, visX1 - visX0, SEG.h);
        lc.globalAlpha = 1;
        continue;
      }
      lc.drawImage(img, srcX, 0, srcW, img.naturalHeight, visX0, SEG.y, visX1 - visX0, SEG.h);
    }
    if (WAVEFORM_OFF_DIM > 0 && this.markers && this.markers.length) {
      lc.fillStyle = 'rgba(0,0,0,' + WAVEFORM_OFF_DIM + ')';
      const sm = this.sortedMarkers();
      const cuts = this.model.cuts;
      const deleted = this.model.deleted;
      let prev = 0;
      for (const m of sm) {
        if (m.off) {
          for (let i = 0; i < cuts.length - 1; i++) {
            const o0 = Math.max(prev, cuts[i]);
            const o1 = Math.min(m.t, cuts[i + 1]);
            if (o1 <= o0) continue;
            if (deleted[i]) continue;
            const x0 = this.timeToX(o0);
            const x1 = this.timeToX(o1);
            lc.fillRect(x0, SEG.y, x1 - x0, SEG.h);
          }
        }
        prev = m.t;
      }
    }
    ctx.save();
    ctx.globalAlpha = KEYFRAME_ALPHA_BRIGHT * WAVEFORM_COEFF;
    ctx.drawImage(this._wfLayer, 0, 0, this.w, this.h);
    ctx.restore();
  }

  renderRuler(ctx) {
    const { y, h } = RULER;
    const step = niceStep(60 / this.pxPerSec);
    const showMs = step < 0.5;
    const showHms = step >= 60;

    const startIdx = Math.ceil(this.viewStart / step);
    const endIdx = Math.floor((this.viewStart + this.w / this.pxPerSec) / step);

    ctx.fillStyle = COLORS.rulerTick;
    ctx.font = '9px ' + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = 'left';
    for (let i = startIdx; i <= endIdx; i++) {
      const t = i * step;
      const x = this.timeToX(t) - 0.5;
      ctx.fillRect(x, y + h - 6, 1, 6);
      if (showMs) {
        ctx.fillRect(x, y + h - 3, 1, 3);
      }
      const label = showMs ? fmtTime(t, true) : (showHms ? fmtTime(t, false) : fmtTime(t, false));
      ctx.fillStyle = COLORS.rulerLabel;
      ctx.fillText(label, x + 3, y + h - 7);
      ctx.fillStyle = COLORS.rulerTick;
    }

    
    const minor = step / 5;
    if (minor * this.pxPerSec >= 4) {
      ctx.fillStyle = COLORS.rulerMinor;
      const m0 = Math.ceil(this.viewStart / minor);
      const m1 = Math.floor((this.viewStart + this.w / this.pxPerSec) / minor);
      for (let m = m0; m <= m1; m++) {
        if (m % 5 === 0) continue;
        ctx.fillRect(this.timeToX(m * minor) - 0.5, y + h - 3, 1, 3);
      }
    }
  }

  renderPlayhead(ctx) {
    const x = this.timeToX(this.cursor);
    if (x < -20 || x > this.w + 20) return;
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, 2);
    ctx.lineTo(x, this.h - 2);
    ctx.stroke();

    
    ctx.fillStyle = COLORS.playhead;
    ctx.beginPath();
    ctx.moveTo(x - 6, 2);
    ctx.lineTo(x + 6, 2);
    ctx.lineTo(x, 10);
    ctx.closePath();
    ctx.fill();
  }
}

function ctxCreatePattern(ctx, src) {
  return ctx.createPattern(src, 'repeat');
}

function niceStep(target) {
  const steps = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400, 43200, 86400];
  for (const s of steps) if (s >= target) return s;
  return 86400 * Math.ceil(target / 86400);
}



const app = {
  state: {
    source: null,
    duration: 0,
    width: 0,
    height: 0,
    fps: 0,
    keyTimes: [],
    model: null,
    cursor: 0,
    projectPath: null,
    exporting: false,
    dirty: false,
    waveform: {
      enabled: true,
      slices: new Map(),
      pending: new Set()
    },
    exportSettings: {
      compress: false,
      resolution: 'origin',
      blocks: false
    },
    _exportMode: 'project',
    _segmentMarkerId: null
  },

  _dragCursorStack: [],
  _concatFiles: [],
  _concatResult: null,
  _concatBusy: false,
  _concatDragIndex: null,
  _concatDropIndex: null,
  _concatDropBefore: false,
  _concatDragDir: null,
  _concatDragLastY: null,

  beginDragCursor(cursor = 'grabbing') {
    const cls = 'drag-cursor-' + cursor;
    this._dragCursorStack.push(cls);
    document.body.classList.add(cls);
  },

  endDragCursor() {
    const cls = this._dragCursorStack.pop();
    if (cls) document.body.classList.remove(cls);
  },

  clearDragCursors() {
    for (const cls of this._dragCursorStack) document.body.classList.remove(cls);
    this._dragCursorStack.length = 0;
  },

  init() {
    const sbStyle = document.documentElement.style;
    sbStyle.setProperty('--sb-pad', SCROLLBAR.pad + 'px');
    sbStyle.setProperty('--sb-thumb-min', SCROLLBAR.thumbMin + 'px');
    sbStyle.setProperty('--sb-caret', SCROLLBAR.caret + 'px');
    sbStyle.setProperty('--sb-tol', SCROLLBAR.tol + 'px');
    sbStyle.setProperty('--sb-track', SCROLLBAR.track + 'px');
    sbStyle.setProperty('--sb-inset', SCROLLBAR.inset + 'px');
    this.video = $('video');
    this.scrubAudio = $('scrub-audio');
    this.scrubTimer = null;
    this.lastScrubTime = -1;
    this._pg = null;
    this.resumeTimer = null;
    this._stepPause = false;
    this._unmute = null;
    this._mutedBySkip = false;
    this._mutedBeforeSkip = false;
    this.model = new EditorModel(0);
    this.state.model = this.model;
    this.model.onMutate = () => { this.markDirty(); this.syncExportButton(); };
    this.model.onCaptureState = () => {
      const t = this.timeline;
      return {
        selected: t.selected ? t.selected.slice() : null,
        selectedSet: t.selectedSet ? [...t.selectedSet] : null,
        selectedAnchor: t.selectedAnchor,
        markers: t.markers.map((m) => ({ id: m.id, t: m.t, name: m.name, color: m.color, off: !!m.off }))
      };
    };
    this.model.onRestoreState = (sel) => {
      const t = this.timeline;
      if (!t) return;
      t.selected = sel.selected ? sel.selected.slice() : null;
      t.selectedSet = sel.selectedSet ? new Set(sel.selectedSet) : null;
      t.selectedAnchor = sel.selectedAnchor != null ? sel.selectedAnchor : null;
      if (sel.markers) t.markers = sel.markers.map((m) => ({ id: m.id, t: m.t, name: m.name, color: m.color, off: !!m.off }));
      if (this._markerBubbleId != null && !t.markers.some((x) => x.id === this._markerBubbleId)) {
        this.hideMarkerBubble();
      }
      t._lastBubbleId = null;
      t.needsRender = true;
      t.tick();
      this.updateStats();
    };
    this.timeline = new Timeline($('timeline'), {
      scrollbar: $('timeline-scrollbar'),
      thumb: $('scrollbar-thumb')
    });
    this.timeline.onZoom = (pps) => {
      const zr = $('zoom-range');
      const v = Math.round((Math.log(pps) / Math.log(20000)) * 100);
      zr.value = Math.max(0, Math.min(100, v));
    };
    this.timeline.onScrub = (t) => this.scrubBlip(t);
    this.timeline.onScrubEnd = () => this.scrubEnd();
    this.timeline.onResize = () => { this.refreshActiveKeys(); this.updateStats(); };
    this.timeline.onMarkersChange = () => { this.syncExportButton(); this.updateStats(); };
    this.timeline.onMarkerEdit = (m) => this.markerBubble(m);
    this.timeline.onMarkerDragStart = () => this.hideMarkerBubble();
    this.timeline.onMarkerBubbleHide = () => this.hideMarkerBubble();
    this.timeline.onMarkerMove = (t) => {
      this.scrubBlip(t);
      this.state.cursor = t;
      this.timeline.cursor = t;
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.seek(t);
    };
    this.timeline.onViewChanged = () => this.syncMarkerBubble();
    $('marker-name').addEventListener('input', () => {
      const inp = $('marker-name');
      const clean = inp.value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '');
      if (clean !== inp.value) inp.value = clean;
      const id = this._markerBubbleId;
      const m = this.timeline.markers.find((x) => x.id === id);
      const dup = !!(m && this.timeline.markers.some((x) => x.id !== id && x.name === clean));
      const srcName = this.state.source ? this.state.source.split(/[\\/]/).pop().toLowerCase() : '';
      const srcCollide = !!(m && clean && (safeFileName(clean) + this.sourceExt()).toLowerCase() === srcName);
      const warn = $('marker-warn');
      if (dup || srcCollide) {
        inp.classList.add('dup');
        warn.textContent = srcCollide ? 'Cannot use the original file name' : 'Name already used by another marker';
        warn.classList.remove('hidden');
      } else {
        inp.classList.remove('dup');
        warn.classList.add('hidden');
        if (m) m.name = clean;
      }
    });
    $('marker-name').addEventListener('keydown', (e) => {
      if (e.code === 'Enter' || e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.hideMarkerBubble();
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault();
        e.stopPropagation();
        this.redo();
      }
    });
    $('marker-name').addEventListener('blur', () => this.hideMarkerBubble());
    $('marker-ok').addEventListener('mousedown', (e) => e.preventDefault());
    $('marker-export').addEventListener('mousedown', (e) => e.preventDefault());
    $('marker-off').addEventListener('mousedown', (e) => e.preventDefault());
    $('marker-delete').addEventListener('mousedown', (e) => e.preventDefault());
    $('marker-ok').addEventListener('click', () => this.hideMarkerBubble());
    $('marker-export').addEventListener('click', () => {
      const id = this._markerBubbleId;
      this.hideMarkerBubble();
      this.openSegmentExport(id);
    });
    $('marker-off').addEventListener('click', () => {
      const id = this._markerBubbleId;
      const m = this.timeline.markers.find((x) => x.id === id);
      if (!m) return;
      m.off = !m.off;
      const offBtn = $('marker-off');
      offBtn.textContent = m.off ? 'On' : 'Off';
      offBtn.title = m.off ? 'Enable this part for export' : 'Disable this part for export';
      offBtn.classList.toggle('on', !!m.off);
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.model.snapshot();
      this.timeline.onMarkersChange();
    });
    $('marker-delete').addEventListener('click', () => {
      const id = this._markerBubbleId;
      this.hideMarkerBubble();
      this.deleteActiveMarker(id);
    });
    $('find-input').addEventListener('keydown', (e) => {
      if (e.code === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.shiftKey ? -1 : 1;
        if (!this._findResults || !this._findResults.length) this.findLive();
        else if (this._findDone) this.findNav(dir);
        else this.findDo();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const hm = $('help-modal');
        if (hm && !hm.classList.contains('hidden')) { hm.classList.add('hidden'); return; }
        this.closeFind();
      }
    });
    $('find-input').addEventListener('input', () => this.findLive());
    $('find-next').addEventListener('click', () => this.findNav(1));
    $('find-prev').addEventListener('click', () => this.findNav(-1));
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#find-bar') || t.closest('#marker-bubble') || t.closest('#locate-modal') || t.closest('#export-modal') || t.closest('#help-modal') || t.closest('#convert-modal')) return;
      if (t.closest('button')) {
        this.closeFind();
        this.hideMarkerBubble();
      }
    });
    this.hideMarkerBubble();
    this.syncExportButton();

    this.bindDragDrop();

    this.bindUI();
    this.bindVideo();
    this.bindKeys();

    window.keycut.onCloseRequest(() => this.handleCloseRequest());

    this.setVideoEnabled(false);
    this.setStatus('Ready');

    window.keycut.getOpenFile().then((p) => {
      if (p) this.handleDroppedFile(p);
      else setTimeout(() => this.fitInitialWindow(), 0);
    }).catch(() => setTimeout(() => this.fitInitialWindow(), 0));
    window.keycut.onOpenFile((p) => this.handleDroppedFile(p));
  },

  bindDragDrop() {
    let depth = 0;
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragenter', () => {
      depth++;
      const cm = $('concat-modal');
      if (cm && !cm.classList.contains('hidden')) cm.classList.add('drag-over');
      if (!this.isModalOpen()) document.body.classList.add('drag-over');
    });
    window.addEventListener('dragleave', () => {
      depth--;
      if (depth <= 0) {
        document.body.classList.remove('drag-over');
        const cm = $('concat-modal');
        if (cm) cm.classList.remove('drag-over');
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('drag-over');
      const cm = $('concat-modal');
      if (cm) cm.classList.remove('drag-over');
      const dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      if (cm && !cm.classList.contains('hidden')) {
        const paths = [];
        for (const f of dt.files) {
          const p = window.keycut.getFilePath ? window.keycut.getFilePath(f) : null;
          if (p) paths.push(p);
        }
        if (paths.length && !this._concatBusy) this.concatAddPaths(paths);
        return;
      }
      const paths = [];
      for (const f of dt.files) {
        const p = window.keycut.getFilePath ? window.keycut.getFilePath(f) : null;
        if (p && (isVideoFile(p) || /\.kc$/i.test(p))) paths.push(p);
      }
      if (paths.length > 1) {
        this.concatAddPaths(paths);
        $('concat-modal').classList.remove('hidden');
        this.closeFind();
        return;
      }
      const p = paths[0];
      if (p) this.handleDroppedFile(p);
      else if (dt.files.length) this.setStatus('Unsupported file type');
    });
  },

  async handleDroppedFile(p) {
    const cs = this._convertState;
    if (cs === 'analyzing' || cs === 'converting' || cs === 'done') { this.setStatus('Busy: conversion in progress'); return; }
    if (!isVideoFile(p) && !/\.kc$/i.test(p)) { this.setStatus('Unsupported file type'); return; }
    const lm = $('locate-modal');
    if (lm && !lm.classList.contains('hidden')) {
      if (this._locateVerify) this._locateVerify(p);
      return;
    }
    if (this.isModalOpen()) { this.setStatus('Close the dialog to open a file'); return; }
    if (!await this.confirmDiscardIfDirty()) { this.setStatus('Open cancelled'); return; }
    this.scrubEnd();
    if (/\.kc$/i.test(p)) await this.openProjectFromPath(p);
    else await this.loadSource(p);
  },

  bindUI() {
    $('btn-open').addEventListener('click', () => this.openFile());
    $('btn-open2').addEventListener('click', () => this.openFile());
    $('btn-save').addEventListener('click', () => this.saveProject());
    $('btn-export').addEventListener('click', () => this.export());
    $('export-cancel').addEventListener('click', () => this.cancelExport());
    $('export-settings-cancel').addEventListener('click', () => this.closeExportSettings());
    $('export-settings-action').addEventListener('click', () => this.doExport());
    $('export-compress-toggle').addEventListener('click', () => this.toggleExportCompress());
    $('export-blocks-separate').addEventListener('change', () => {
      this.state.exportSettings.blocks = $('export-blocks-separate').checked;
    });
    $('confirm-ok').addEventListener('click', () => this._confirmResolve(true));
    $('confirm-cancel').addEventListener('click', () => this._confirmResolve(false));
    for (const b of document.querySelectorAll('.res-opt')) {
      b.addEventListener('click', () => this.setExportResolution(b.dataset.res));
    }
    $('btn-play').addEventListener('click', () => this.togglePlay());
    $('btn-start').addEventListener('click', () => this.navPause(() => this.homeNav()));
    $('btn-end').addEventListener('click', () => this.navPause(() => this.endNav()));
    $('btn-prevblock').addEventListener('click', () => this.navPause(() => this.prevBlock()));
    $('btn-nextblock').addEventListener('click', () => this.navPause(() => this.nextBlock()));
    $('btn-prevkf').addEventListener('click', () => this.navPause(() => this.prevKeyframe()));
    $('btn-nextkf').addEventListener('click', () => this.navPause(() => this.nextKeyframe()));
    $('btn-help').addEventListener('click', () => this.toggleHelp());
    $('help-modal-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));
    $('help-modal').addEventListener('click', (e) => {
      if (e.target === $('help-modal')) $('help-modal').classList.add('hidden');
    });
    $('btn-set-keys').addEventListener('click', () => this.setKeys());
    $('btn-concat').addEventListener('click', () => this.concatVideos());
    $('concat-open').addEventListener('click', () => this.concatAddFiles());
    $('concat-clear').addEventListener('click', () => this.concatClearFiles());
    $('concat-join').addEventListener('click', () => this.concatJoin());
    $('concat-saveas').addEventListener('click', () => this.concatSaveAs());
    $('concat-insert').addEventListener('click', () => this.concatInsert());
    $('concat-cancel').addEventListener('click', () => this.concatCancel());
    $('concat-close').addEventListener('click', () => $('concat-modal').classList.add('hidden'));
    $('concat-modal').addEventListener('click', (e) => {
      if (e.target === $('concat-modal') && !this._concatBusy) $('concat-modal').classList.add('hidden');
    });
    $('convert-cancel').addEventListener('click', () => this.cancelConvert());
    $('convert-place').addEventListener('click', () => this.placeVideo(false));
    $('convert-action').addEventListener('click', () => this.convertAction());
    $('detail-low').addEventListener('click', () => this.setConvertDetail('low'));
    $('detail-medium').addEventListener('click', () => this.setConvertDetail('medium'));
    $('detail-high').addEventListener('click', () => this.setConvertDetail('high'));
    $('convert-modal').addEventListener('click', (e) => {
      if (e.target === $('convert-modal')) {
        const cs = this._convertState;
        if (cs === 'ready' || cs === 'error') this.closeConvertModal();
      }
    });

    const zr = $('zoom-range');
    zr.addEventListener('input', () => {
      const f = Math.exp((zr.value / 100) * Math.log(20000));
      this.timeline.setZoom(f);
    });
    $('btn-zoom-in').addEventListener('click', () => { zr.value = Math.min(100, +zr.value + 100 / 10); zr.dispatchEvent(new Event('input')); });
    $('btn-zoom-out').addEventListener('click', () => { zr.value = Math.max(0, +zr.value - 100 / 10); zr.dispatchEvent(new Event('input')); });
    this.buildFitButtons();

    window.addEventListener('resize', () => {
      clearTimeout(this._fitBtnTimer);
      this._fitBtnTimer = setTimeout(() => this.updateFitButtons(), 150);
    });

    
    window.addEventListener('click', (e) => {
      if (e.target && e.target.tagName === 'BUTTON') e.target.blur();
    });
  },

  bindVideo() {
    this.video.addEventListener('loadedmetadata', () => {
      
      
      
      const vd = this.video.duration;
      if (!this._loadingSrc && this.state.source && Number.isFinite(vd) && vd > 0 && vd > this.state.duration + DUR_EXTEND_MARGIN) {
        this.state.duration = vd;
        this.model.duration = vd;
        const cuts = this.model.cuts;
        if (cuts.length) cuts[cuts.length - 1] = vd;
        this.refreshActiveKeys();
        if (this.timeline) {
          this.timeline.duration = vd;
          this.timeline.clampView();
          this.timeline.needsRender = true;
          this.timeline.tick();
        }
        this.updateTimeDisplay();
        this.updateStats();
        this.setStatus('Video duration corrected to ' + fmtTime(vd, false));
      }
      if (this._pendingSeek != null) {
        const t = this._pendingSeek;
        this._pendingSeek = null;
        if (Number.isFinite(this.video.duration) && this.video.duration > 0) {
          this.video.currentTime = Math.min(Math.max(0, t), this.video.duration);
        }
      }
      setTimeout(() => this.updateFitButtons(), 150);
    });
    this.video.addEventListener('timeupdate', () => {
      if (!this.video.paused && !(this.timeline.drag && this.timeline.drag.mode !== 'pan')) this.guardPlayback();
    });
    this.video.addEventListener('play', () => {
      this.timeline.playing = true;
      $('btn-play').innerHTML = PAUSE_SVG;
      this.scrubEnd();
      this.startPlaybackGuard();
    });
    this.video.addEventListener('pause', () => {
      this.timeline.playing = false;
      $('btn-play').innerHTML = PLAY_SVG;
      this.stopPlaybackGuard();
      this.cancelSkipMute();
    });
    this.video.addEventListener('ended', () => {
      this.stopPlaybackGuard();
      this.cancelSkipMute();
      this.state.cursor = this.state.duration;
      this.timeline.cursor = this.state.duration;
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.updateTimeDisplay();
    });
  },

  
  
  startPlaybackGuard() {
    if (this._pg) return;
    const tick = () => {
      if (!this.video.paused && !(this.timeline.drag && this.timeline.drag.mode !== 'pan')) this.guardPlayback();
      this._pg = requestAnimationFrame(tick);
    };
    this._pg = requestAnimationFrame(tick);
  },

  stopPlaybackGuard() {
    if (this._pg) { cancelAnimationFrame(this._pg); this._pg = null; }
  },

  guardPlayback() {
    const g = this.guardTarget(this.video.currentTime);
    if (g) {
      if (g.type === 'pause') {
        this.skipTo(g.exact ? g.at : Math.max(0, g.at - SEEK_EPS), true);
        if (g.exact) {
          this.state.cursor = g.at;
          this.timeline.cursor = g.at;
          this.timeline.needsRender = true;
          this.timeline.tick();
          this.updateTimeDisplay();
        }
      } else {
        
        
        
        this.skipTo(g.at, false);
      }
      return;
    }
    
    const t = this.video.currentTime;
    if (Math.abs(t - this.state.cursor) > CARET_UPDATE_MS) {
      this.onPlayheadMoved();
      this.state.cursor = t;
      this.timeline.cursor = t;
      this.timeline.activeBlock = null;
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.updateTimeDisplay();
      this.ensureCursorVisible();
    }
  },

  
  
  
  ensureCursorVisible() {
    if (!this.timeline) return;
    const viewW = this.timeline.w / this.timeline.pxPerSec;
    const margin = 0.1;
    if (this.state.cursor < this.timeline.viewStart + viewW * margin) {
      this.timeline.viewStart = this.state.cursor - viewW * margin;
    } else if (this.state.cursor > this.timeline.viewStart + viewW * (1 - margin)) {
      this.timeline.viewStart = this.state.cursor - viewW * (1 - margin);
    } else {
      return;
    }
    this.timeline.clampView();
    this.timeline.needsRender = true;
    this.timeline.tick();
  },





  skipTo(t, pauseAfter) {
    if (this._unmute) this.video.removeEventListener('seeked', this._unmute);
    if (!this._mutedBySkip) {
      this._mutedBeforeSkip = this.video.muted;
      this.video.muted = true;
      this._mutedBySkip = true;
    }
    const restore = () => {
      this.video.muted = this._mutedBeforeSkip;
      this._mutedBySkip = false;
      this._unmute = null;
    };
    this._unmute = restore;
    this.video.addEventListener('seeked', restore);
    this.video.currentTime = t;
    if (pauseAfter) this.video.pause();
  },

  cancelSkipMute() {
    if (this._unmute) this.video.removeEventListener('seeked', this._unmute);
    this._unmute = null;
    if (this._mutedBySkip) {
      this.video.muted = this._mutedBeforeSkip;
      this._mutedBySkip = false;
    }
  },



guardTarget(t) {
    const cuts = this.model.cuts;
    const markers = this.timeline ? this.timeline.sortedMarkers() : [];
    let prev = 0;
    for (const m of markers) {
      if (m.off && t >= prev - 1e-6 && t < m.t - 1e-6) {
        return { type: 'seek', at: m.t };
      }
      prev = m.t;
    }
    
    
    
    const i = this.model.segmentOf(t + SEEK_EPS);
    if (i < this.model.deleted.length && this.model.deleted[i]) {
      
      
      if (t < cuts[i]) {
        const prev = this.model.segmentOf(t);
        if (prev < this.model.deleted.length && !this.model.deleted[prev]) return null;
      }
      let j = i;
      while (j < this.model.deleted.length && this.model.deleted[j]) j++;
      const end = cuts[j]; 
      if (end >= this.state.duration - SEEK_EPS) return { type: 'pause', at: cuts[i] };
      return { type: 'seek', at: end };
    }
    return null;
  },

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') {
        const mod = e.ctrlKey || e.metaKey;
        const appHot = mod && !e.altKey && (e.code === 'KeyO' || e.code === 'KeyS' || e.code === 'KeyE' || e.code === 'KeyF');
        if (!appHot && !/^F\d+$/.test(e.code)) return;
      }
      if (e.code === 'F1') { e.preventDefault(); this.toggleHelp(); return; }
      if (e.code === 'F3') { e.preventDefault(); if (e.shiftKey) this.prevFind(); else this.nextFind(); return; }
      const cs = this._convertState;
      if (this.isModalOpen() || cs === 'analyzing' || cs === 'converting' || cs === 'done') {
        if (e.code === 'Escape') {
          e.preventDefault();
          this.cancelStepPause();
          const hm = $('help-modal');
          if (!hm.classList.contains('hidden')) { hm.classList.add('hidden'); return; }
          const es = $('export-settings-modal');
          if (es && !es.classList.contains('hidden')) { es.classList.add('hidden'); return; }
          const cm = $('convert-modal');
          if (!cm.classList.contains('hidden')) {
            if (cs === 'ready' || cs === 'error') { this.closeConvertModal(); return; }
            return;
          }
          const cf = $('confirm-modal');
          if (cf && !cf.classList.contains('hidden')) { this._confirmResolve(false); return; }
          if (this._locateResolve) { this._locateResolve(null); return; }
        }
        return;
      }
      this.timeline.setCtrlHeld(e.ctrlKey || e.metaKey);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyO') { e.preventDefault(); this.openFile(); return; }
      if (mod && !e.shiftKey && e.code === 'KeyS') { e.preventDefault(); this.saveProject(); return; }
      if (mod && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); this.navPause(() => this.homeNav()); return; }
      if (mod && !e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        this.export();
        return;
      }
      if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (mod && e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
      if (mod && !e.shiftKey && e.code === 'KeyF') { e.preventDefault(); this.toggleFind(); return; }
      if (mod && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); this.navPause(() => this.endNav()); return; }
      if (e.code === 'Space') { e.preventDefault(); this.cancelStepPause(); this.togglePlay(); return; }
      if (e.code === 'KeyM') { e.preventDefault(); this.timeline.addMarkerAt(this.state.cursor); return; }
      if (e.code === 'KeyC') { e.preventDefault(); this.cancelStepPause(); this.cut(); return; }
      if (e.code === 'KeyX' || e.code === 'Delete' || e.code === 'Backspace') {
        if (this._markerBubbleId != null) {
          e.preventDefault();
          const id = this._markerBubbleId;
          this.hideMarkerBubble();
          this.deleteActiveMarker(id);
          return;
        }
        e.preventDefault(); this.cancelStepPause(); this.deleteSegment(); return;
      }
      if (e.code === 'KeyR') { e.preventDefault(); this.cancelStepPause(); this.restoreSegment(); return; }
      if (e.code === 'KeyE') { e.preventDefault(); this.cancelStepPause(); this.mergeSelected(); return; }
      if (e.code === 'BracketLeft') { e.preventDefault(); this.navPause(() => this.homeNav()); return; }
      if (e.code === 'BracketRight') { e.preventDefault(); this.navPause(() => this.endNav()); return; }
      if (e.code === 'Home') { e.preventDefault(); this.navPause(() => this.seekTo(0)); return; }
      if (e.code === 'End') { e.preventDefault(); this.navPause(() => this.seekTo(this.state.duration)); return; }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault();
        const zr = $('zoom-range');
        const out = e.code === 'Minus' || e.code === 'NumpadSubtract';
        zr.value = Math.max(0, Math.min(100, +zr.value + (out ? -1 : 1) * 100 / 10));
        zr.dispatchEvent(new Event('input'));
        return;
      }
      
      
      if (e.code === 'KeyS' || e.code === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) { this.navPause(() => this.prevBlock()); return; }
        if (!e.repeat) this.handleFrameNav(-1);
        return;
      }
      if (e.code === 'KeyF' || e.code === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) { this.navPause(() => this.nextBlock()); return; }
        if (!e.repeat) this.handleFrameNav(+1);
        return;
      }
      if (e.code === 'Escape') {
        this.cancelStepPause();
        const hm = $('help-modal');
        if (hm && !hm.classList.contains('hidden')) { hm.classList.add('hidden'); return; }
        const cm = $('convert-modal');
        if (cm && !cm.classList.contains('hidden')) {
          const cs = this._convertState;
          if (cs === 'ready' || cs === 'error') { this.closeConvertModal(); return; }
          return;
        }
        if (this._locateResolve) { this._locateResolve(null); return; }
        if (!$('find-bar').classList.contains('hidden')) { this.closeFind(); return; }
        if (this._markerBubbleId != null) { this.hideMarkerBubble(); return; }
        this.pause();
      }
    });
    window.addEventListener('keyup', (e) => {
      this.timeline.setCtrlHeld(e.ctrlKey || e.metaKey);
      if (e.code === 'KeyS' || e.code === 'KeyF' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        this.releaseFrameNav();
      }
    });
    window.addEventListener('blur', () => { this.timeline.setCtrlHeld(false); app.clearDragCursors(); });
  },

  setStatus(text, spin = false) {
    $('status-text').textContent = text;
    $('spinner').classList.toggle('hidden', !spin);
  },

  showTaskModal({ title = 'Open file', message = '', indeterminate = true, progress = 0 } = {}) {
    $('task-modal-title').textContent = title;
    $('task-modal-message').textContent = message;
    const fill = $('task-modal-fill');
    fill.classList.toggle('indeterminate', indeterminate);
    if (!indeterminate) fill.style.width = Math.round(progress * 100) + '%';
    $('task-modal').classList.remove('hidden');
  },

  updateTaskModal({ message, progress, indeterminate }) {
    if (message != null) $('task-modal-message').textContent = message;
    const fill = $('task-modal-fill');
    if (indeterminate != null) fill.classList.toggle('indeterminate', indeterminate);
    if (progress != null && !indeterminate) fill.style.width = Math.round(progress * 100) + '%';
  },

  hideTaskModal() {
    $('task-modal').classList.add('hidden');
  },

  taskModalOpen() {
    return !$('task-modal').classList.contains('hidden');
  },

  markerBubble(m) {
    this._markerBubbleId = m.id;
    const inp = $('marker-name');
    inp.value = m.name;
    inp.classList.remove('dup');
    $('marker-warn').classList.add('hidden');
    const offBtn = $('marker-off');
    offBtn.textContent = m.off ? 'On' : 'Off';
    offBtn.title = m.off ? 'Enable this part for export' : 'Disable this part for export';
    offBtn.classList.toggle('on', !!m.off);
    const b = $('marker-bubble');
    b.classList.remove('hidden');
    this.syncMarkerBubble();
    if (!$('find-bar').classList.contains('hidden')) return;
    inp.focus();
    inp.select();
  },

  hideMarkerBubble() {
    this._markerBubbleId = null;
    $('marker-name').classList.remove('dup');
    $('marker-warn').classList.add('hidden');
    $('marker-bubble').classList.add('hidden');
  },

  syncMarkerBubble() {
    const b = $('marker-bubble');
    if (b.classList.contains('hidden') || this._markerBubbleId == null) return;
    const m = this.timeline.markers.find((x) => x.id === this._markerBubbleId);
    if (!m) { this.hideMarkerBubble(); return; }
    const wrap = $('timeline-wrap');
    const x = $('timeline').offsetLeft + this.timeline.timeToX(m.t);
    const ww = wrap.clientWidth;
    const bw = b.offsetWidth;
    const margin = 6;
    const r = 8;
    const arrow = $('marker-bubble-arrow');
    b.style.transform = 'none';
    if (x - bw / 2 >= margin && ww - (x + bw / 2) >= margin) {
      b.style.left = (x - bw / 2) + 'px';
      arrow.style.left = '50%';
    } else if (x - bw / 2 < margin) {
      b.style.left = margin + 'px';
      arrow.style.left = Math.max(r, Math.min(bw - r, x - margin)) + 'px';
    } else {
      b.style.left = Math.max(margin, ww - bw - margin) + 'px';
      arrow.style.left = Math.max(r, Math.min(bw - r, x - (ww - bw - margin))) + 'px';
    }
  },

  syncExportButton() {
    const has = this.hasMarkers() && this.markersHaveContent();
    $('btn-start').title = has ? 'Previous marker' : 'Go to start of project';
    $('btn-end').title = has ? 'Next marker' : 'Go to end of project';
  },

  markerPartsWithContent() {
    const t = this.timeline;
    if (!t || !t.markers || !t.markers.length || !this.model) return 0;
    const runs = this.exportableRuns();
    const markers = t.sortedMarkers();
    let prev = 0;
    let count = 0;
    for (const m of markers) {
      if (m.off) { prev = m.t; continue; }
      if (clipRuns(runs, prev, m.t).length) count++;
      prev = m.t;
    }
    return count;
  },

  markersHaveContent() {
    return this.markerPartsWithContent() > 0;
  },

  exportableRuns() {
    let runs = this.model.keptRuns();
    const markers = (this.timeline && this.timeline.markers) ? this.timeline.sortedMarkers() : [];
    let prev = 0;
    for (const m of markers) {
      if (m.off) runs = subtractRuns(runs, prev, m.t);
      prev = m.t;
    }
    return runs;
  },

  deleteActiveMarker(id) {
    if (id == null) return;
    this.timeline.markers = this.timeline.markers.filter((x) => x.id !== id);
    this.timeline.needsRender = true;
    this.timeline.tick();
    this.timeline.onMarkersChange();
    this.model.snapshot();
  },

  toggleHelp() {
    const hm = $('help-modal');
    const willOpen = hm.classList.contains('hidden');
    hm.classList.toggle('hidden');
    if (willOpen) {
      this.closeFind();
      this.hideMarkerBubble();
    }
  },

  setProgress(p) {
    const wrap = $('progress-wrap');
    if (p === null) {
      wrap.classList.add('hidden');
      $('progress-bar').style.width = '0%';
      $('export-modal-fill').style.width = '0%';
      return;
    }
    wrap.classList.remove('hidden');
    $('progress-bar').style.width = Math.round(p * 100) + '%';
    $('export-modal-fill').style.width = Math.round(p * 100) + '%';
  },

  updateStats() {
    const runs = this.exportableRuns();
    let kept = 0;
    for (const [s, e] of runs) kept += e - s;
    const keptPct = this.state.duration > 0 ? Math.round((kept / this.state.duration) * 100) : 0;
    const cuts = this.model.cuts.length - 1;
    const markers = (this.timeline && this.timeline.markers && this.timeline.markers.length) || 0;
    $('stats').innerHTML =
      `<span>Cuts <b>${cuts}</b></span>` +
      (markers ? `<span>Markers <b>${markers}</b></span>` : '') +
      `<span>Kept <b>${fmtTime(kept, false)}</b> / ${fmtTime(this.state.duration, false)} <b>(${keptPct}%)</b></span>`;
  },

  updateTimeDisplay() {
    $('time-current').textContent = fmtTime(this.state.cursor, true);
    $('time-total').textContent = fmtTime(this.state.duration, true);
    
    const d = this.state.duration;
    if (d > 0) $('time-pct').textContent = '(' + Math.round((Math.min(Math.max(0, this.state.cursor), d) / d) * 100) + '%)';
    else $('time-pct').textContent = '';
  },

  async applyVideoMeta(meta) {
    this.state.duration = meta.duration;
    this.state.width = meta.width;
    this.state.height = meta.height;
    this.state.fps = meta.fps;
    this.state.keyTimes = meta.keyTimes;
    this.state.pcmAudio = !!meta.pcmAudio;
    this.state.videoTimebase = meta.videoTimebase || null;
    this.state.hasThumbnail = !!meta.hasThumbnail;
    this.state.streams = meta.streams || null;
    this.state.cursor = 0;
    this.state.model = this.model;
    this.updateTimeDisplay();
    this.refreshActiveKeys();
    this.timeline.setData({
      duration: meta.duration,
      keyTimes: meta.keyTimes,
      model: this.model,
      cursor: 0
    });
    this.updateStats();
    this.setVideoEnabled(true);
    this._videoSize = { width: meta.width, height: meta.height };
    if (!this._skipFitWindow) {
      await this.fitWindowToVideo();
    }
    this._skipFitWindow = false;
    await this.updateFitButtons();
    this.state.waveform.slices.clear();
    this.state.waveform.pending.clear();
    if (this.state.waveform.enabled) this.scheduleWaveformRender();
  },

  audioStreamIndex() {
    const streams = this.state.streams || [];
    const a = streams.find((s) => s.codec_type === 'audio');
    return a ? a.index : null;
  },

  timelineViewChanged() {
    const tl = this.timeline;
    if (!tl || !this.state.waveform.enabled) return;
    if (this._wfVS === tl.viewStart && this._wfPPS === tl.pxPerSec) return;
    this._wfVS = tl.viewStart;
    this._wfPPS = tl.pxPerSec;
    this.scheduleWaveformRender();
  },

  scheduleWaveformRender() {
    clearTimeout(this._wfTimer);
    this._wfTimer = setTimeout(() => this.renderWaveformSlices(), 150);
  },

  renderWaveformSlices() {
    const w = this.state.waveform;
    const tl = this.timeline;
    if (!w.enabled || !tl || !this.state.source) return;
    const audio = this.audioStreamIndex();
    if (audio == null) return;
    const vis = tl.w / tl.pxPerSec;
    const windowSize = Math.max(0.25, Math.min(60, vis * 4));
    const from = tl.viewStart - windowSize;
    const to = tl.viewStart + vis + windowSize;
    const center = tl.viewStart + vis / 2;
    const missing = [];
    for (let s = Math.floor(from / windowSize) * windowSize; s < to; s += windowSize) {
      const key = Math.round(s * 1e6) / 1e6;
      if (w.slices.has(key) || w.pending.has(key)) continue;
      const dur = Math.min(windowSize, this.state.duration - key);
      if (dur <= 0) continue;
      missing.push({ key, dur, dist: Math.abs(key + dur / 2 - center) });
    }
    missing.sort((a, b) => a.dist - b.dist);
    const spawnCount = Math.min(4, missing.length);
    for (let i = 0; i < spawnCount; i++) {
      const m = missing[i];
      w.pending.add(m.key);
      this.renderWaveformSlice(m.key, m.dur, audio);
    }
    if (w.slices.size > 60) {
      const sorted = [...w.slices.keys()].sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      while (sorted.length > 60) {
        const k = sorted.pop();
        const sl = w.slices.get(k);
        if (sl && sl.url) { try { URL.revokeObjectURL(sl.url); } catch {} }
        w.slices.delete(k);
      }
    }
  },

  async renderWaveformSlice(from, dur, audioIdx) {
    const w = this.state.waveform;
    if (!w.enabled || !this.state.source) return;
    let res;
    try {
      res = await window.keycut.renderWaveform(this.state.source, { start: from, duration: dur, streamIndex: audioIdx, width: 2000, height: 300 });
    } catch {
      w.pending.delete(from);
      return;
    }
    w.pending.delete(from);
    if (!w.enabled || !res || !res.ok) return;
    try {
      const blob = new Blob([new Uint8Array(res.data)], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        w.slices.set(from, { from, to: from + dur, img, url, birth: performance.now() });
        this.timeline.needsRender = true;
        this.timeline.tick();
        const fadeLoop = () => {
          const sl = w.slices.get(from);
          if (!sl || sl.birth == null || !w.enabled) return;
          this.timeline.needsRender = true;
          this.timeline.tick();
          if (performance.now() - sl.birth < WAVEFORM_FADE_MS) requestAnimationFrame(fadeLoop);
        };
        if (WAVEFORM_FADE_MS > 0) requestAnimationFrame(fadeLoop);
      };
      img.onerror = () => { try { URL.revokeObjectURL(url); } catch {} };
      img.src = url;
    } catch {
      /* ignore */
    }
  },

  
  
  
  refreshActiveKeys() {
    const cuts = this.model.cuts;
    const deleted = this.model.deleted;
    const keys = this.state.keyTimes || [];
    const set = new Set();
    for (const c of cuts) set.add(c);
    let ki = 0;
    for (let i = 0; i < deleted.length; i++) {
      if (deleted[i]) continue;
      const a = cuts[i], b = cuts[i + 1];
      while (ki < keys.length && keys[ki] < a) ki++;
      while (ki < keys.length && keys[ki] <= b + 1e-9) { set.add(keys[ki]); ki++; }
    }
    const arr = Array.from(set).sort((x, y) => x - y);
    this.state.activeKeys = arr;
    if (this.timeline) {
      this.timeline.activeKeys = arr;
      this.timeline.activeBlock = null;
    }
  },

  
  
  scrubBlip(t) {
    if (!this.state.source || this.video && !this.video.paused) return;
    if (this.frameDeleted(t)) return;
    if (Math.abs(t - this.lastScrubTime) < 1e-4) return;
    
    
    const now = performance.now();
    if (this._lastBlipStamp && now - this._lastBlipStamp < BLIP_MS) return;
    this._lastBlipStamp = now;
    this.lastScrubTime = t;
    const a = this.scrubAudio;
    if (!a || !a.src) return;
    clearTimeout(this.scrubTimer);
    try { a.currentTime = t; } catch { return; }
    const p = a.play();
    if (p) p.catch(() => {});
    this.scrubTimer = setTimeout(() => { try { a.pause(); } catch {} }, BLIP_PLAY_MS);
  },

  scrubEnd() {
    clearTimeout(this.scrubTimer);
    if (this.scrubAudio) { try { this.scrubAudio.pause(); } catch {} }
    this.lastScrubTime = -1;
    this._lastBlipStamp = 0;
  },

  setVideoEnabled(on) {
    $('btn-play').disabled = !on;
    $('btn-start').disabled = !on;
    $('btn-end').disabled = !on;
    $('btn-prevblock').disabled = !on;
    $('btn-nextblock').disabled = !on;
    $('btn-prevkf').disabled = !on;
    $('btn-nextkf').disabled = !on;
    $('btn-export').disabled = !on;
    $('btn-save').disabled = !on;
    $('btn-set-keys').classList.toggle('hidden', !on);
    $('video-placeholder').style.display = on ? 'none' : 'flex';
  },

  async fitInitialWindow() {
    if (this.state.source) return;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await frame();
    const g = this.fitGeometry();
    const vw = (MIN_WIN_W - g.frameW) - g.HOff;
    const vh = vw / PREVIEW_ASPECT;
    const nW = Math.max(MIN_WIN_W - g.frameW, Math.round(vw + g.HOff));
    const nH = Math.max(MIN_WIN_H - g.frameH, Math.round(vh + g.VOff));
    await window.keycut.setWindowContentSize(nW, nH, g.frameW, g.frameH);
    await window.keycut.centerWindowOn({ x: window.screen.availLeft + window.screen.availWidth / 2, y: window.screen.availTop + window.screen.availHeight / 2 });
  },

  fitGeometry() {
    const videoEl = $('video');
    const rect = videoEl.getBoundingClientRect();
    return {
      frameW: Math.max(0, window.outerWidth - window.innerWidth),
      frameH: Math.max(0, window.outerHeight - window.innerHeight),
      HOff: window.innerWidth - rect.width,
      VOff: window.innerHeight - rect.height
    };
  },

  async applyFit(targetW, targetH) {
    if (!targetW || !targetH) return;
    const videoEl = $('video');
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settle = async () => { await frame(); await new Promise((r) => setTimeout(r, 40)); };
    let wa = { width: window.screen.width, height: window.screen.height };
    try { wa = await window.keycut.workArea(); } catch {}
    const A = targetW / targetH;
    const keepCenter = this._fitKeepCenter ? { x: window.screenX + window.outerWidth / 2, y: window.screenY + window.outerHeight / 2 } : null;
    await settle();
    let nW = null, nH = null;
    for (let i = 0; i < 3; i++) {
      const g = this.fitGeometry();
      const availW = Math.min(targetW, Math.max(1, wa.width - g.frameW - g.HOff));
      const availH = Math.min(targetH, Math.max(1, wa.height - g.frameH - g.VOff));
      let w2 = availW, h2 = availH;
      if (w2 / h2 > A) w2 = h2 * A; else h2 = w2 / A;
      const minVW = (MIN_WIN_W - g.frameW) - g.HOff;
      const minVH = (MIN_WIN_H - g.frameH) - g.VOff;
      if (w2 < minVW) { w2 = minVW; h2 = w2 / A; }
      if (h2 < minVH) { h2 = minVH; w2 = h2 * A; }
      if (nW == null) {
        nW = Math.max(MIN_WIN_W - g.frameW, Math.round(w2 + g.HOff));
        nH = Math.max(MIN_WIN_H - g.frameH, Math.round(h2 + g.VOff));
      }
      await window.keycut.setWindowContentSize(nW, nH, g.frameW, g.frameH);
      await settle();
      const r2 = videoEl.getBoundingClientRect();
      const dw = Math.round(w2) - r2.width;
      const dh = Math.round(h2) - r2.height;
      if (Math.abs(dw) < 1 && Math.abs(dh) < 1) break;
      nW += Math.round(dw); nH += Math.round(dh);
    }
    if (keepCenter) await window.keycut.centerWindowOn(keepCenter);
    await this.updateFitButtons();
  },

  videoFitSize() {
    if (this._videoSize) return this._videoSize;
    const v = this.video;
    if (v && v.videoWidth && v.videoHeight) return { width: v.videoWidth, height: v.videoHeight };
    return { width: this.state.width, height: this.state.height };
  },

  async fitWindowToVideo() {
    const { width, height } = this.videoFitSize();
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    this._fitKeepCenter = true;
    await this.applyFit(width / dpr, height / dpr);
    this._fitKeepCenter = false;
  },

  async fitWindowScale(scale) {
    const { width, height } = this.videoFitSize();
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    this._fitKeepCenter = true;
    await this.applyFit(width / dpr * scale, height / dpr * scale);
    this._fitKeepCenter = false;
  },

  async updateFitButtons() {
    const { width: vw, height: vh } = this.videoFitSize();
    const group = $('fit-group');
    if (!vw || !vh) {
      if (group) group.classList.add('hidden');
      return;
    }
    if (group) group.classList.remove('hidden');
    const dpr = window.devicePixelRatio || 1;
    const g = this.fitGeometry();
    let wa = { width: window.screen.width, height: window.screen.height };
    try { wa = await window.keycut.workArea(); } catch {}
    const slackW = 12;
    const slackH = 12;
    const fits = [];
    for (const pct of FIT_SCALES) {
      const s = pct / 100;
      const W = vw / dpr * s + g.HOff;
      const H = vh / dpr * s + g.VOff;
      if (W >= (MIN_WIN_W - g.frameW) && H >= (MIN_WIN_H - g.frameH) && (W + g.frameW) <= wa.width + slackW && (H + g.frameH) <= wa.height + slackH) fits.push(pct);
    }
    let shown = fits;
    if (fits.length > 7) {
      const idx100 = fits.indexOf(100);
      if (idx100 >= 0) {
        const pick = (arr, n) => { if (arr.length <= n) return arr; const step = (arr.length - 1) / (n - 1 || 1); return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]); };
        shown = [...pick(fits.slice(0, idx100), 3), 100, ...pick(fits.slice(idx100 + 1), 3)];
      } else {
        const step = (fits.length - 1) / 6;
        shown = Array.from({ length: 7 }, (_, i) => fits[Math.round(i * step)]);
      }
    }
    for (const pct of FIT_SCALES) {
      const btn = $('btn-fit-' + pct);
      if (!btn) continue;
      btn.style.display = shown.includes(pct) ? '' : 'none';
    }
    const fitBtn = $('btn-fit-init');
    if (fitBtn) fitBtn.style.display = shown.includes(100) ? 'none' : '';
  },

  buildFitButtons() {
    const group = $('fit-group');
    if (!group) return;
    group.querySelectorAll('.fit-btn').forEach((b) => b.remove());
    const init = document.createElement('button');
    init.className = 'mini-btn fit-btn';
    init.id = 'btn-fit-init';
    init.textContent = 'FIT';
    init.title = 'Fit editor to screen';
    init.addEventListener('click', () => this.fitWindowToVideo());
    group.appendChild(init);
    for (const pct of FIT_SCALES) {
      const btn = document.createElement('button');
      btn.className = 'mini-btn fit-btn';
      btn.id = 'btn-fit-' + pct;
      btn.textContent = pct + '%';
      btn.title = 'Editor size ' + pct + '%';
      btn.addEventListener('click', () => this.fitWindowScale(pct / 100));
      group.appendChild(btn);
    }
  },

  
  
  async openFile() {
    if (this._convertState === 'analyzing' || this._convertState === 'converting') return;
    const p = await window.keycut.openFile();
    if (!p) return;
    await this.openPath(p);
  },

  async openPath(p) {
    if (!await this.confirmDiscardIfDirty()) return;
    if (/\.kc$/i.test(p)) await this.openProjectFromPath(p);
    else await this.loadSource(p);
  },

  
  
  
  async confirmDiscardIfDirty() {
    if (!this.state.dirty || !this.state.source) return true;
    const choice = await window.keycut.confirmClose();
    if (choice === 'save') {
      await this.saveProject();
      return !this.state.dirty; 
    }
    return choice === 'discard';
  },

  
  async handleCloseRequest() {
    if (this.state.exporting) return;
    if (this._concatBusy) return;
    if (this._convertState === 'analyzing' || this._convertState === 'converting') return;
    if (this.taskModalOpen()) return;
    if (!this.state.dirty) { window.keycut.forceClose(); return; }
    const choice = await window.keycut.confirmClose();
    if (choice === 'save') {
      await this.saveProject();
      if (this.state.dirty) return; 
      window.keycut.forceClose();
    } else if (choice === 'discard') {
      window.keycut.forceClose();
    }
  },

  async loadSource(path) {
    this.showTaskModal({ title: 'Open file', message: 'Analyzing…', indeterminate: true });
    const meta = await window.keycut.probeVideo(path);
    this.hideTaskModal();
    if (!meta || meta.error) {
      this.setStatus('Error: ' + (meta && meta.error ? meta.error : 'failed to analyze video'));
      return;
    }
    this.state.source = path;
    window.keycut.lockSource(path);
    this.state.projectPath = null;
    this._loadingSrc = true;
    this._videoSize = { width: meta.width, height: meta.height };
    this.cancelSkipMute();
    this.stopPlaybackGuard();
    this.cancelStepPause();
    this.model.clearHistory();
    this.model.reset(meta.duration);
    this.timeline.markers = [];
    this.model.snapshot();
    this.video.src = toFileUrl(path);
    this.video.load();
    if (this.scrubAudio) { this.scrubAudio.src = toFileUrl(path); this.scrubAudio.load(); }
    this.state.dirty = false;
    this.$labelUpdate();
    if (!this._skipFitWindow) {
      try { await this.fitWindowToVideo(); } catch {}
      this._skipFitWindow = true;
    }
    await this.applyVideoMeta(meta);
    this._loadingSrc = false;
    this.setStatus('Loaded: ' + path);
  },

  $labelUpdate() {
    
    const label = this.state.source ? this.state.source.split(/[\\/]/).pop() : '';
    const star = this.state.dirty ? '* ' : '';
    document.title = star + (label ? 'KeyCut – ' + label : 'KeyCut');
  },

  
  
  markDirty() {
    if (!this.state.dirty) {
      this.state.dirty = true;
      this.$labelUpdate();
    }
  },

  togglePlay() {
    if (!this.state.source) return;
    if (this.video.paused) {
      
      
      if (this.video.ended) return;
      
      
      
      
      
      const start = this.firstKeptTime(this.state.cursor);
      if (start >= this.state.duration - SEEK_EPS) return;
      this.seek(start);
      this.video.play().catch(() => {});
    } else {
      this.video.pause();
    }
  },



firstKeptTime(t) {
  if (!this.frameDeleted(t)) return t;
  let i = this.model.segmentOf(t);
  while (i < this.model.deleted.length && this.model.deleted[i]) i++;
  return this.model.cuts[i];
},



frameDeleted(t) {
  const i = this.model.segmentOf(t);
  return !!this.model.deleted[i];
},

  pause() {
    if (!this.video.paused) this.video.pause();
  },

  


  onPlayheadMoved() {
    if (this._markerBubbleId != null) this.hideMarkerBubble();
  },

  seek(t) {
    this.onPlayheadMoved();
    if (this.timeline) this.timeline.activeBlock = null;
    this.state.cursor = t;
    if (this.video.readyState > 0) {
      this.video.currentTime = t;
    } else {
      this._pendingSeek = t;
    }
    this.updateTimeDisplay();
  },

  cut() {
    if (!this.state.source) return;
    
    const t = snapKey(this.state.cursor, this.state.activeKeys || this.state.keyTimes);
    const before = this.timeline.captureCornerTargets();
    const leftBlock = this.model.segmentOf(t);
    if (this.model.split(t)) {
      this.refreshActiveKeys();
      this.timeline.applyCornerChange(before);
      this.state.cursor = t;
      this.timeline.cursor = t;
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.seek(t);
      this.timeline.activeBlock = leftBlock;
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.updateStats();
      this.setStatus('Cut at ' + fmtTime(t, true));
    }
  },

  
  
  activeIndices() {
    const s = this.timeline.selectionIndices();
    if (s.length) return s;
    return [this.timeline.activeIndex()];
  },

  
  deleteSegment() {
    if (!this.state.source) return;
    const idx = this.activeIndices();
    const before = this.timeline.captureCornerTargets();
    if (this.model.deleteIndices(idx)) {
      this.refreshActiveKeys();
      this.timeline.applyCornerChange(before);
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.updateStats();
      this.setStatus((idx.length > 1 ? idx.length + ' segments' : 'Segment') + ' dimmed (will be cut out)');
    }
  },

  
  restoreSegment() {
    if (!this.state.source) return;
    const idx = this.activeIndices();
    if (this.selectionMixed()) return;
    const before = this.timeline.captureCornerTargets();
    if (this.model.restoreIndices(idx)) {
      this.refreshActiveKeys();
      this.timeline.applyCornerChange(before);
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.updateStats();
      this.setStatus((idx.length > 1 ? idx.length + ' segments' : 'Segment') + ' restored');
    }
  },

  selectionMixed() {
    const idx = this.timeline.selectionIndices();
    if (!idx.length) return false;
    let gray = false;
    let blue = false;
    for (const i of idx) {
      if (this.model.deleted[i]) gray = true;
      else blue = true;
    }
    return gray && blue;
  },

  
  
  mergeSelected() {
    if (!this.state.source) return;
    const idx = this.activeIndices().slice().sort((a, b) => a - b);
    if (!idx.length) return;
    if (this.selectionMixed()) return;
    let a = idx[0];
    let b = idx[idx.length - 1];
    if (a === b) return;
    const before = this.timeline.captureCornerTargets();
    if (this.model.mergeRange(a, b)) {
      this.refreshActiveKeys();
      this.timeline.applyCornerChange(before);
      this.timeline.selected = [a, a];
      this.timeline.selectedAnchor = a;
      this.timeline.selectedSet = null;
      this.model.updateCurrentSelection({
        selected: this.timeline.selected ? this.timeline.selected.slice() : null,
        selectedSet: this.timeline.selectedSet ? [...this.timeline.selectedSet] : null,
        selectedAnchor: this.timeline.selectedAnchor
      });
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.updateStats();
      const gray = this.model.deleted[a];
      this.setStatus('Merged ' + (b - a + 1) + (gray ? ' gray' : '') + ' blocks into one');
    }
  },

  undo() {
    if (!this.model.undo()) { this.setStatus('Nothing to undo'); return; }
    const before = this.timeline.captureCornerTargets();
    this.refreshActiveKeys();
    this.timeline.applyCornerChange(before);
    this.afterHistory();
    this.setStatus('Undo');
  },

  redo() {
    if (!this.model.redo()) { this.setStatus('Nothing to redo'); return; }
    const before = this.timeline.captureCornerTargets();
    this.refreshActiveKeys();
    this.timeline.applyCornerChange(before);
    this.afterHistory();
    this.setStatus('Redo');
  },

  afterHistory() {
    const s = this.timeline.selected;
    if (s && (s[0] < 0 || s[1] >= this.model.cuts.length - 1)) {
      this.timeline.selectedIndex = null;
    }
    
    const set = this.timeline.selectedSet;
    if (set) {
      const valid = [...set].filter((i) => i >= 0 && i < this.model.deleted.length);
      if (valid.length !== set.size) {
        this.timeline.selectedSet = valid.length ? new Set(valid) : null;
      }
    }
    if (this.state.cursor > this.state.duration) this.state.cursor = this.state.duration;
    this.timeline.needsRender = true;
    this.timeline.tick();
    this.updateStats();
    this.updateTimeDisplay();
  },

  prevKeyframe() {
    const t = this.state.cursor;
    const keys = this.state.activeKeys || this.state.keyTimes;
    if (!keys || !keys.length) return;
    let idx = binaryFirst(keys, t);
    if (idx >= keys.length) idx = keys.length - 1;
    if (keys[idx] >= t - 1e-6) idx--;
    while (idx >= 0 && Math.abs(keys[idx] - t) < 1e-6) idx--;
    if (idx >= 0) this.seekTo(keys[idx]);
  },

  nextKeyframe() {
    const t = this.state.cursor;
    const keys = this.state.activeKeys || this.state.keyTimes;
    let idx = binaryFirst(keys, t);
    while (idx < keys.length && Math.abs(keys[idx] - t) < 1e-6) idx++;
    if (idx < keys.length) this.seekTo(keys[idx]);
  },

  
  
  navPause(fn) {
    if (this.video && !this.video.paused) this.pause();
    this.cancelStepPause();
    fn.call(this);
  },

  
  nextBlock() {
    const cuts = this.model.cuts;
    const deleted = this.model.deleted;
    const t = this.state.cursor;
    for (let i = 0; i < deleted.length; i++) {
      if (deleted[i]) continue;
      const s = cuts[i];
      if (s > t + 1e-6) { this.seekTo(s); return; }
    }
    this.setStatus('No next block');
  },

  hasMarkers() {
    return this.timeline && this.timeline.markers && this.timeline.markers.length;
  },

  homeNav() {
    if (this.hasMarkers()) this.prevMarker();
    else this.seekTo(0);
  },

  endNav() {
    if (this.hasMarkers()) this.nextMarker();
    else this.seekTo(this.state.duration);
  },

  prevMarker() {
    const markers = this.timeline.sortedMarkers();
    if (!markers.length) { this.seekTo(0); return; }
    const t = this.state.cursor;
    let best = null;
    for (const m of markers) if (m.t < t - 1e-6) best = m; else break;
    if (best != null) this.navigateToMarker(best);
    else this.seekTo(0);
  },

  nextMarker() {
    const markers = this.timeline.sortedMarkers();
    if (!markers.length) { this.seekTo(this.state.duration); return; }
    const t = this.state.cursor;
    let best = null;
    for (const m of markers) if (m.t > t + 1e-6) { best = m; break; }
    if (best != null) this.navigateToMarker(best);
    else this.seekTo(this.state.duration);
  },

  seekToMarker(t) {
    this.state.cursor = t;
    this.timeline.cursor = t;
    this.timeline.needsRender = true;
    this.timeline.tick();
    this.seek(t);
    this.ensureCursorVisible();
  },

  isModalOpen() {
    return ['help-modal', 'export-modal', 'export-settings-modal', 'locate-modal', 'convert-modal', 'confirm-modal', 'task-modal', 'concat-modal'].some((id) => !$(id).classList.contains('hidden'));
  },

  async toggleFind() {
    if (this.isModalOpen()) return;
    if (!this.state.source) {
      this.setStatus('Open a project to search markers');
      return;
    }
    const exists = await window.keycut.fileExists(this.state.source);
    if (!exists) {
      this.setStatus('Source file is missing – open the video first');
      return;
    }
    if ($('find-bar').classList.contains('hidden')) this.openFind();
    else this.closeFind();
  },

  openFind() {
    this._findResults = [];
    this._findIndex = -1;
    this._findDone = false;
    $('find-count').textContent = '0 / 0';
    $('find-next').disabled = true;
    $('find-prev').disabled = true;
    $('find-bar').classList.remove('hidden');
    $('find-input').focus();
    $('find-input').select();
  },

  prevFind() {
    if (this.isModalOpen()) return;
    if (!$('find-bar').classList.contains('hidden')) {
      if (!this._findResults || !this._findResults.length) this.findLive();
      if (this._findResults && this._findResults.length) {
        if (this._findDone) this.findNav(-1);
        else this.findDo();
      }
      return;
    }
    this.toggleFind();
  },

  nextFind() {
    if (this.isModalOpen()) return;
    if (!$('find-bar').classList.contains('hidden')) {
      if (!this._findResults || !this._findResults.length) this.findLive();
      if (this._findResults && this._findResults.length) {
        if (this._findDone) this.findNav(1);
        else this.findDo();
      }
      return;
    }
    this.toggleFind();
  },

  closeFind() {
    $('find-bar').classList.add('hidden');
    $('find-input').value = '';
    this._findResults = [];
    this._findIndex = -1;
    this._findDone = false;
  },

  findLive() {
    const raw = $('find-input').value.trim();
    const q = raw.toLowerCase();
    const markers = this.timeline && this.timeline.markers ? this.timeline.markers : [];
    if (!q || !markers.length) {
      this._findResults = [];
      this._findIndex = -1;
      this._findDone = false;
      $('find-count').textContent = '0 / 0';
      $('find-next').disabled = true;
      $('find-prev').disabled = true;
      return;
    }
    this._findResults = markers.filter((m) => (m.name || '').toLowerCase().includes(q)).sort((a, b) => a.t - b.t);
    this._findIndex = this._findResults.length ? 0 : -1;
    this._findDone = false;
    $('find-count').textContent = this._findResults.length ? '1 / ' + this._findResults.length : '0 / 0';
    $('find-next').disabled = this._findResults.length < 2;
    $('find-prev').disabled = this._findResults.length < 2;
    if (!this._findResults.length) this.setStatus('No markers match "' + raw + '"');
  },

  findDo() {
    if (!this._findResults || !this._findResults.length) { this.findLive(); return; }
    this._findDone = true;
    this._findIndex = 0;
    this.updateFindButtons();
    this.navigateToMarker(this._findResults[0]);
  },

  findNav(dir) {
    const n = this._findResults.length;
    if (!n) return;
    this._findDone = true;
    this._findIndex = (this._findIndex + dir + n) % n;
    this.updateFindButtons();
    this.navigateToMarker(this._findResults[this._findIndex]);
  },

  updateFindButtons() {
    const n = this._findResults.length;
    $('find-next').disabled = n < 2;
    $('find-prev').disabled = n < 2;
    $('find-count').textContent = n ? (this._findIndex + 1) + ' / ' + n : '0 / 0';
  },

  navigateToMarker(m) {
    if (!m) return;
    this.seekToMarker(m.t);
    this.centerMarker(m);
    this.hideMarkerBubble();
    this.markerBubble(m);
    this.syncMarkerBubble();
  },

  centerMarker(m) {
    const tl = this.timeline;
    if (!tl || !tl.w || !tl.pxPerSec) return;
    const viewW = tl.w / tl.pxPerSec;
    const d = this.state.duration || 0;
    let vs;
    if (m.t <= viewW * 0.25) vs = 0;
    else if (m.t >= d - viewW * 0.25) vs = d - viewW;
    else vs = m.t - viewW / 2;
    tl.viewStart = vs;
    tl.clampView();
    tl.needsRender = true;
    tl.tick();
  },

  
  prevBlock() {
    const cuts = this.model.cuts;
    const deleted = this.model.deleted;
    const t = this.state.cursor;
    let best = null;
    for (let i = 0; i < deleted.length; i++) {
      if (deleted[i]) continue;
      const s = cuts[i];
      if (s < t - 1e-6) best = s; else break;
    }
    if (best != null) this.seekTo(best);
    else this.setStatus('No previous block');
  },








handleFrameNav(dir) {
  const back = dir < 0;
  const wasPlaying = this.video && !this.video.paused;
  const inSession = this._stepPause;
  this.cancelStepPause();
  if (wasPlaying && back) this.pause();
  if (dir < 0) this.prevKeyframe(); else this.nextKeyframe();
  
  this.scrubBlip(this.state.cursor);
  this._scan = { dir, back, playing: wasPlaying || inSession, held: false };
  this._holdTimer = setTimeout(() => {
    if (this._scan && this._scan.dir === dir) {
      if (this.video && !this.video.paused) this.pause();
      this._scan.held = true;
      this._scan.speed = this.scanSpeedForProject();
      this._scan.baseTime = this.state.cursor;
      this._scan.baseStamp = performance.now();
      this._scan.lastSeek = this.state.cursor;
      clearInterval(this._scanInterval);
      this._scanInterval = setInterval(() => this.scanTick(), SCAN_INTERVAL_MS);
    }
  }, HOLD_TO_SCAN_MS);
},

scanTick() {
  if (!this._scan || !this.state.source) return;
  const elapsed = (performance.now() - this._scan.baseStamp) / 1000;
  let target = this._scan.baseTime + this._scan.dir * this._scan.speed * elapsed;
  target = Math.min(Math.max(target, 0), this.state.duration);
  this.state.cursor = target;
  this.timeline.cursor = target;
  this.timeline.needsRender = true;
  this.timeline.tick();
  
  this.scrubBlip(target);
  if (Math.abs(target - this._scan.lastSeek) > SCAN_SEEK_MS) {
    this._scan.lastSeek = target;
    this.seek(target);
    this.ensureCursorVisible();
  }
},



scanSpeedForProject() {
  const keys = this.state.keyTimes || [];
  const dur = this.state.duration;
  if (!keys.length || dur <= 0) return SCAN_KF_PER_SEC;
  const n = keys.length;
  const avgInterval = n > 1 ? (keys[n - 1] - keys[0]) / (n - 1) : dur / n;
  const speed = SCAN_KF_PER_SEC * avgInterval;
  return Math.min(SCAN_SPEED_MAX, Math.max(SCAN_SPEED_MIN, speed));
},

releaseFrameNav() {
  clearTimeout(this._holdTimer);
  this._holdTimer = null;
  const scan = this._scan;
  this._scan = null;
  clearInterval(this._scanInterval);
  this._scanInterval = null;
  if (!scan) return;
  this.scrubEnd(); 
  if (scan.held) {
    
    
    if (scan.playing && this.state.source) {
      const keys = this.state.activeKeys || this.state.keyTimes;
      const kf = lastKeyAtOrBefore(this.state.cursor, keys);
      this.seekTo(kf);
      if (this.video.paused && !this.video.ended) this.togglePlay();
    }
  } else if (scan.playing && scan.back) {
    
    this._stepPause = true;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this._stepPause = false;
      this.resumeTimer = null;
      if (this.state.source && this.video.paused && !this.video.ended) this.togglePlay();
    }, STEP_PAUSE_MS);
  }
},

  cancelStepPause() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this._stepPause = false;
    clearTimeout(this._holdTimer);
    this._holdTimer = null;
    clearInterval(this._scanInterval);
    this._scanInterval = null;
    this._scan = null;
    this.scrubEnd();
  },

  seekTo(t) {
    const end = this.state.duration || 0;
    const snapped = endSnap(t, end, this.state.activeKeys || this.state.keyTimes, this.state.fps);
    this.state.cursor = snapped;
    this.timeline.cursor = snapped;
    this.timeline.needsRender = true;
    this.timeline.tick();
    this.seek(snapped);
    this.ensureCursorVisible();
  },

  async saveProject() {
    if (this._convertState === 'analyzing' || this._convertState === 'converting') return;
    if (!this.state.source) { this.setStatus('Nothing to save'); return; }
    let filePath = this.state.projectPath;
    if (!filePath) {
      const base = this.state.source.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') + '.kc';
      filePath = await window.keycut.saveProjectDialog(base);
      if (!filePath) return;
    }
    await this.saveProjectTo(filePath);
  },

  async saveProjectTo(filePath) {
    if (!filePath) return;
    const data = {
      src: this.state.source,
      video: {
        dur: this.state.duration,
        w: this.state.width,
        h: this.state.height,
        fps: this.state.fps
      },
      keys: this.state.keyTimes,
      cuts: this.model.cuts,
      deleted: this.model.deleted,
      cursor: this.state.cursor,
      zoom: this.timeline ? this.timeline.pxPerSec : 0,
      viewStart: this.timeline ? this.timeline.viewStart : 0,
      markers: this.timeline ? this.timeline.markers : [],
      exportSettings: this.state.exportSettings,
      winBounds: {
        x: window.screenX,
        y: window.screenY,
        w: window.outerWidth,
        h: window.outerHeight
      }
    };
    const res = await window.keycut.saveProject(filePath, data);
    if (res && res.ok) {
      this.state.projectPath = filePath;
      this.state.dirty = false;
      this.$labelUpdate();
      this.setStatus('Project saved: ' + filePath);
    } else {
      this.state.dirty = true;
      this.$labelUpdate();
      this.setStatus('Save failed: ' + (res && res.error));
    }
  },

  locateSource(data) {
    return new Promise((resolve) => {
      const modal = $('locate-modal');
      const nameEl = $('locate-name');
      const pathEl = $('locate-path');
      const spinner = $('locate-spinner');
      const warn = $('locate-warn');
      const chooseBtn = $('locate-choose');
      let verifying = false;
      nameEl.textContent = data.src ? data.src.split(/[\\/]/).pop() : (data.srcName || 'video');
      pathEl.textContent = '';
      warn.classList.add('hidden');
      const setState = (s) => {
        if (s === 'checking') {
          spinner.classList.remove('hidden');
          spinner.className = 'locate-spinner checking';
          spinner.innerHTML = '';
        } else if (s === 'ok') {
          spinner.classList.remove('hidden');
          spinner.className = 'locate-spinner ok';
          spinner.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5 10-10"/></svg>';
        } else if (s === 'err') {
          spinner.classList.remove('hidden');
          spinner.className = 'locate-spinner err';
          spinner.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#e5484d"/><rect x="7" y="10.5" width="10" height="3" rx="1.5" fill="#fff"/></svg>';
        } else {
          spinner.classList.add('hidden');
        }
        warn.classList.toggle('hidden', s !== 'err');
      };
      const finish = (r) => {
        this._locateResolve = null;
        this._locateVerify = null;
        modal.classList.add('hidden');
        resolve(r);
      };
      this._locateResolve = finish;
      const verifyPath = async (p) => {
        if (verifying) return;
        verifying = true;
        chooseBtn.disabled = true;
        pathEl.textContent = p;
        setState('checking');
        try {
          const m = await window.keycut.probeQuick(p);
          if (!m || m.error || m.duration == null || m.width == null || m.height == null) {
            setState('err');
            return;
          }
          const v = data.video || {};
          const durOk = !v.dur || Math.abs(m.duration - v.dur) <= Math.max(0.1, v.dur * 0.01);
          const whOk = !v.w || (m.width === v.w && m.height === v.h) || (m.width === v.h && m.height === v.w);
          const fpsOk = !v.fps || !m.fps || Math.abs(m.fps - v.fps) <= 1;
          const sizeOk = !v.size || !m.size || Math.abs(m.size - v.size) <= v.size * 0.01;
          if (!durOk || !whOk || !fpsOk || !sizeOk) {
            setState('err');
            return;
          }
          finish({ path: p });
        } catch {
          setState('err');
        } finally {
          verifying = false;
          chooseBtn.disabled = false;
        }
      };
      this._locateVerify = verifyPath;
      const doChoose = async () => {
        const p = await window.keycut.chooseFile();
        if (!p) return;
        const btn = $('locate-choose');
        $('locate-choose-label').textContent = ellipsizeMidFit(p.split(/[\\/]/).pop(), btn.clientWidth - 44, getComputedStyle(btn).font);
        verifyPath(p);
      };
      chooseBtn.onclick = doChoose;
      modal.addEventListener('click', function onOverlay(e) {
        if (e.target === modal) {
          modal.removeEventListener('click', onOverlay);
          finish(null);
        }
      });
      if (!$('help-modal').classList.contains('hidden')) $('help-modal').classList.add('hidden');
      setState('idle');
      modal.classList.remove('hidden');
    });
  },

  async openProjectFromPath(filePath) {
    this.setStatus('Loading project…', true);
    const res = await window.keycut.loadProject(filePath);
    this.setStatus('', false);
    if (!res || res.ok === false || res.error) {
      this.setStatus('Load failed: ' + (res && res.error ? res.error : 'invalid project'));
      return;
    }
    const data = res;
    if (!data.src && !data.srcName) { this.setStatus('Load failed: missing <src>'); return; }
    if (data.srcRel) {
      const r = await window.keycut.resolveProjectSource(filePath, data.srcRel);
      if (r && r.path) data.src = r.path;
    }
    if (data.winBounds && (data.winBounds.w || data.winBounds.h)) {
      this._skipFitWindow = true;
      await window.keycut.setWindowBounds(data.winBounds);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }

    this.showTaskModal({ title: 'Open file', message: 'Analyzing source video…', indeterminate: true });
    let meta = await window.keycut.probeVideo(data.src);
    this.hideTaskModal();
    if (!meta || meta.error) {
      const exists = await window.keycut.fileExists(data.src);
      if (!exists) {
        const located = await this.locateSource(data);
        if (!located) return;
        data.src = located.path;
        this.showTaskModal({ title: 'Open file', message: 'Analyzing source video…', indeterminate: true });
        meta = await window.keycut.probeVideo(data.src);
        this.hideTaskModal();
        if (!meta || meta.error) {
          this.setStatus('Source video missing: ' + data.src + '. Please open the original video file.');
          return;
        }
      } else {
        this.setStatus('Source video missing: ' + data.src + '. Please open the original video file.');
        return;
      }
    }

    this.state.source = data.src;
    window.keycut.lockSource(data.src);
    this.state.projectPath = filePath;
    const duration = meta.duration > 0 ? meta.duration : ((data.video && data.video.dur) || meta.duration);
    const tl = this.timeline;
    this.model.clearHistory();
    this.model.cuts = data.cuts;
    this.model.deleted = data.deleted;
    this.model.duration = duration;
    this.cancelSkipMute();
    this.stopPlaybackGuard();
    this.cancelStepPause();
    this._loadingSrc = true;

    this.video.src = toFileUrl(data.src);
    this.video.load();
    if (this.scrubAudio) { this.scrubAudio.src = toFileUrl(data.src); this.scrubAudio.load(); }
    this.state.dirty = false;
    this.$labelUpdate();

    await this.applyVideoMeta({
      duration,
      width: (data.video && data.video.w) || meta.width,
      height: (data.video && data.video.h) || meta.height,
      fps: (data.video && data.video.fps) || meta.fps,
      keyTimes: data.keys && data.keys.length ? data.keys : meta.keyTimes,
      pcmAudio: meta.pcmAudio,
      videoTimebase: meta.videoTimebase,
      hasThumbnail: meta.hasThumbnail,
      streams: meta.streams
    });
    this._loadingSrc = false;

    tl.markers = (data.markers || []).map((m, i) => ({ id: ++tl._markerSeq, t: m.t, name: m.name || '', color: m.color || '#7bd88f', off: !!m.off }));
    if (data.exportSettings) {
      this.state.exportSettings = {
        compress: !!data.exportSettings.compress,
        resolution: data.exportSettings.resolution || 'origin',
        blocks: !!data.exportSettings.blocks
      };
    }
    if (data.zoom > 0) tl.pxPerSec = Math.max(tl.minZoom(), Math.min(ZOOM_MAX, data.zoom));
    if (typeof data.viewStart === 'number') tl.viewStart = data.viewStart;
    this.syncExportButton();
    const c = Math.min(Math.max(0, data.cursor || 0), duration);
    this.seek(c);
    tl.cursor = c;
    tl.clampView();
    tl.needsRender = true;
    tl.tick();
    this.model.snapshot();
    this.state.dirty = false;
    this.$labelUpdate();
    this.updateStats();
    this.setStatus('Project loaded: ' + filePath);
    setTimeout(() => this.updateFitButtons(), 200);
  },

  async export() {
    if (this._convertState === 'analyzing' || this._convertState === 'converting') return;
    if (this.state.exporting) return;
    const runs = this.exportableRuns();
    if (!runs.length) { this.setStatus('Nothing to export - all segments are deleted'); return; }
    const es = this.state.exportSettings;
    this._exportMode = 'project';
    this._segmentMarkerId = null;
    $('export-settings-title').textContent = 'Export Project';
    $('export-blocks-separate').checked = !!es.blocks;
    $('export-blocks-row').style.display = this.markerPartsWithContent() >= 2 ? '' : 'none';
    $('export-compress-toggle').textContent = es.compress ? 'Compress: ON' : 'Compress: OFF';
    $('export-compress-toggle').classList.toggle('btn--primary', !!es.compress);
    $('export-resolution-row').classList.toggle('hidden', !es.compress);
    this.setExportResolution(es.resolution);
    this.openExportSettings();
    this.closeFind();
  },

  openSegmentExport(id) {
    if (this._convertState === 'analyzing' || this._convertState === 'converting') return;
    if (this.state.exporting) return;
    const m = this.timeline.markers.find((x) => x.id === id);
    if (!m) return;
    const es = this.state.exportSettings;
    this._exportMode = 'segment';
    this._segmentMarkerId = id;
    $('export-settings-title').textContent = 'Export Segment';
    $('export-blocks-row').style.display = 'none';
    $('export-compress-toggle').textContent = es.compress ? 'Compress: ON' : 'Compress: OFF';
    $('export-compress-toggle').classList.toggle('btn--primary', !!es.compress);
    $('export-resolution-row').classList.toggle('hidden', !es.compress);
    this.setExportResolution(es.resolution);
    this.openExportSettings();
  },

  openExportSettings() {
    $('export-settings-modal').classList.remove('hidden');
    const esCard = $('export-settings-card');
    const esTop = Math.max(12, Math.round((window.innerHeight - esCard.offsetHeight) / 2));
    esCard.style.marginTop = esTop + 'px';
  },

  closeExportSettings() {
    $('export-settings-modal').classList.add('hidden');
  },

  confirmDialog(message) {
    $('confirm-message').textContent = message;
    $('confirm-modal').classList.remove('hidden');
    return new Promise((resolve) => {
      this._confirmResolve = (ok) => {
        this._confirmResolve = null;
        $('confirm-modal').classList.add('hidden');
        resolve(ok);
      };
    });
  },

  toggleExportCompress() {
    this.state.exportSettings.compress = !this.state.exportSettings.compress;
    const btn = $('export-compress-toggle');
    btn.classList.toggle('btn--primary', this.state.exportSettings.compress);
    btn.textContent = this.state.exportSettings.compress ? 'Compress: ON' : 'Compress: OFF';
    $('export-resolution-row').classList.toggle('hidden', !this.state.exportSettings.compress);
  },

  setExportResolution(res) {
    this.state.exportSettings.resolution = res;
    for (const b of document.querySelectorAll('.res-opt')) {
      b.classList.toggle('btn--primary', b.dataset.res === res);
    }
  },

  async doExport() {
    const es = this.state.exportSettings;
    const compressOpts = es.compress ? { compress: true, resolution: es.resolution } : null;
    if (this._exportMode === 'segment') {
      const id = this._segmentMarkerId;
      this._exportMode = 'project';
      this._segmentMarkerId = null;
      await this.exportMarkerPart(id, compressOpts);
      return;
    }
    const blocks = es.blocks;
    if (blocks) await this.exportParts(compressOpts);
    else await this.exportSingle(compressOpts);
  },

  async exportSingle(compressOpts) {
    if (this.state.exporting) return;
    const runs = this.exportableRuns();
    if (!runs.length) { this.setStatus('Nothing to export - all segments are deleted'); return; }
    const srcName = this.state.source.split(/[\\/]/).pop();
    const base = compressOpts ? srcName.replace(/\.[^.]+$/, '') + '.mp4' : srcName;
    const outPath = await window.keycut.saveExportDialog(base, compressOpts ? true : false);
    if (!outPath) return;
    if (this.isSourcePath(outPath)) {
      this.setStatus('Export cancelled: output file cannot overwrite the source "' + this.state.source.split(/[\\/]/).pop() + '"');
      return;
    }
    this.closeExportSettings();
    await this.runExports([{ segments: runs, out: outPath }], false, compressOpts);
  },

  isSourcePath(p) {
    if (!this.state.source || !p) return false;
    return p.replace(/\\/g, '/').toLowerCase() === this.state.source.replace(/\\/g, '/').toLowerCase();
  },

  sourceExt() {
    const m = this.state.source ? this.state.source.match(/\.[^.\\/]+$/) : null;
    let ext = (m && m[0]) || '.mp4';
    if (this.state.pcmAudio && ['.mp4', '.m4v', '.3gp', '.3g2'].includes(ext.toLowerCase())) ext = '.mov';
    return ext;
  },

  async exportMarkerPart(id, compressOpts) {
    if (this.state.exporting) return;
    const m = this.timeline.markers.find((x) => x.id === id);
    if (!m) return;
    const markers = this.timeline.sortedMarkers();
    let prev = 0;
    for (const mm of markers) {
      if (mm.id === m.id) break;
      prev = mm.t;
    }
    const segs = clipRuns(this.model.keptRuns(), prev, m.t);
    if (!segs.length) { this.setStatus('This part contains no kept content'); return; }
    const base = safeFileName(m.name || 'part') + (compressOpts ? '.mp4' : this.sourceExt());
    const outPath = await window.keycut.saveExportDialog(base, compressOpts ? true : false);
    if (!outPath) return;
    if (this.isSourcePath(outPath)) {
      this.setStatus('Export cancelled: output file cannot overwrite the source "' + this.state.source.split(/[\\/]/).pop() + '"');
      return;
    }
    this.closeExportSettings();
    await this.runExports([{ segments: segs, out: outPath }], false, compressOpts);
  },

  async exportParts(compressOpts) {
    if (this._convertState === 'analyzing' || this._convertState === 'converting') return;
    if (this.state.exporting) return;
    const runs = this.exportableRuns();
    if (!runs.length) { this.setStatus('Nothing to export - all segments are deleted'); return; }
    const markers = (this.timeline && this.timeline.markers && this.timeline.markers.length)
      ? this.timeline.markers.slice().sort((a, b) => a.t - b.t)
      : null;
    if (!markers || !markers.length) { this.setStatus('Place at least one marker to export parts'); return; }
    const folder = await window.keycut.pickFolder();
    if (!folder) return;
    this.closeExportSettings();
    const srcNorm = (this.state.source || '').replace(/\\/g, '/').toLowerCase();
    const srcName = this.state.source.split(/[\\/]/).pop();
    const jobs = [];
    let prev = 0;
    let skipped = 0;
    let skippedNames = [];
    for (const m of markers) {
      if (m.off) { prev = m.t; continue; }
      const segs = clipRuns(runs, prev, m.t);
      if (segs.length) {
        const outExt = compressOpts ? '.mp4' : this.sourceExt();
        const out = folder + '/' + safeFileName(m.name) + outExt;
        if (out.replace(/\\/g, '/').toLowerCase() === srcNorm) {
          skipped++;
          skippedNames.push(m.name || 'part');
          prev = m.t;
          continue;
        }
        jobs.push({ segments: segs, out });
      }
      prev = m.t;
    }
    if (!jobs.length) {
      if (skipped) {
        const msg = 'Cannot export: a part cannot be named like the original file "' + srcName + '"';
        this.setStatus(msg);
        window.alert(msg);
      } else this.setStatus('Markers cover no kept content');
      return;
    }
    const existing = [];
    for (const j of jobs) {
      if (await window.keycut.fileExists(j.out)) existing.push(j.out);
    }
    if (existing.length) {
      const ok = await this.confirmDialog('Some output files already exist and will be overwritten.');
      if (!ok) {
        this.openExportSettings();
        this.setStatus('Export cancelled: existing files not overwritten');
        return;
      }
    }
    await this.runExports(jobs, true, compressOpts);
    if (skipped) {
      const msg = 'Part name cannot match the original file "' + srcName + '" - skipped: ' + skippedNames.join(', ');
      this.setStatus(msg);
      window.alert(msg);
    }
  },

  async runExports(jobs, multi, compressOpts) {
    this.state.exporting = true;
    this._exportCancelled = false;
    $('btn-export').disabled = true;
    if (this.video && !this.video.paused) this.pause();
    this.setStatus('Exporting…', true);
    this.setProgress(0);
    $('export-modal').classList.remove('hidden');
    this.closeFind();
    $('export-modal-title').textContent = 'Export' + (multi ? ' [1/' + jobs.length + ']' : '');
    $('export-cancel').style.display = '';
    $('export-modal-status').textContent = 'Preparing…';

    const setModalStatus = (s) => { $('export-modal-status').textContent = s; };
    let curJob = 0;
    const multiSpan = multi && jobs.length > 1 ? 1 / jobs.length : 1;
    const setTicks = () => {
      const bar = $('export-modal-bar');
      bar.querySelectorAll('.modal-tick').forEach((el) => el.remove());
      if (multi && jobs.length > 1) {
        const n = jobs.length;
        for (let i = 1; i < n; i++) {
          const el = document.createElement('div');
          el.className = 'modal-tick';
          el.style.left = ((i / n) * 100) + '%';
          bar.appendChild(el);
        }
      }
    };
    setTicks();
    let lastOverall = 0;
    const unsub = window.keycut.onExportProgress((p) => {
      const base = multiSpan < 1 ? curJob * multiSpan : 0;
      let local = 0;
      if (p.phase === 'cut') {
        const cutPct = p.total > 0 ? Math.round(((p.index + 1) / p.total) * 100) : 0;
        local = (compressOpts ? 0.1 : 0.7) * (p.total > 0 ? p.index / p.total : 0);
        setModalStatus('Muxing… ' + cutPct + '%');
      } else if (p.phase === 'concat') {
        local = compressOpts ? 0.1 : 1;
        this.setStatus('Exporting… muxing');
        setModalStatus('Muxing…');
      } else if (p.phase === 'encode') {
        const pct = Math.round(p.progress * 100);
        local = 0.1 + 0.9 * p.progress;
        this.setStatus('Exporting… encoding ' + pct + '%');
        setModalStatus('Encoding… ' + pct + '%');
      } else if (p.phase === 'error') {
        this.setStatus('Export failed: ' + p.message);
        this.setProgress(null);
        setModalStatus('Error: ' + p.message);
        return;
      }
      lastOverall = Math.max(lastOverall, base + multiSpan * Math.min(1, local));
      this.setProgress(lastOverall);
    });

    let ok = true;
    let lastErr = '';
    for (let i = 0; i < jobs.length; i++) {
      if (this._exportCancelled) { ok = false; lastErr = 'Cancelled'; break; }
      curJob = i;
      const segs = jobs[i].segments;
      const jobDur = segs.reduce((a, s) => a + Math.max(0, (s[1] || 0) - (s[0] || 0)), 0);
      if (multi) $('export-modal-title').textContent = 'Export [' + (i + 1) + '/' + jobs.length + ']';
      setModalStatus('Muxing…');
      const res = await window.keycut.exportStart({
        sourcePath: this.state.source,
        segments: segs,
        outputPath: jobs[i].out,
        videoTimebase: this.state.videoTimebase,
        hasThumbnail: this.state.hasThumbnail,
        streams: this.state.streams,
        compress: compressOpts ? true : null,
        resolution: compressOpts ? compressOpts.resolution : null,
        duration: jobDur > 0 ? jobDur : this.state.duration
      });
      if (!(res && res.ok)) { ok = false; lastErr = res && res.error ? res.error : 'unknown error'; break; }
    }

    unsub();
    $('export-modal-bar').querySelectorAll('.modal-tick').forEach((el) => el.remove());
    this.state.exporting = false;
    this._exportCancelled = false;
    $('btn-export').disabled = false;
    this.syncExportButton();
    this.setProgress(null);
    this.setStatus('', false);
    $('export-modal').classList.add('hidden');

    if (ok) {
      this.setStatus(multi ? 'Export parts complete: ' + jobs.length + ' files' : 'Export complete: ' + jobs[0].out);
    } else if (lastErr === 'Cancelled') {
      this.setStatus('Export cancelled');
    } else {
      this.setStatus('Export failed: ' + lastErr);
    }
  },

  cancelExport() {
    if (!this.state.exporting) return;
    this._exportCancelled = true;
    window.keycut.exportCancel();
  },

  async concatVideos() {
    this.closeFind();
    $('concat-modal').classList.remove('hidden');
    this.renderConcat();
  },

  async concatAddFiles() {
    if (this._concatBusy) return;
    const files = await window.keycut.chooseFiles();
    if (!files || !files.length) return;
    this.concatAddPaths(files);
  },

  concatAddPaths(paths) {
    if (!Array.isArray(paths) || !paths.length) return;
    const filtered = paths.filter(isVideoFile);
    if (!filtered.length) return;
    if (filtered.length > 1) {
      this._concatFiles = [];
    } else {
      const p = filtered[0];
      if (this._concatFiles.some((f) => f.path === p)) { this.renderConcat(); return; }
    }
    this._concatResult = null;
    for (const p of filtered) {
      this._concatFiles.push({ path: p, name: p.split(/[\\/]/).pop() });
    }
    this._concatFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    this.renderConcat();
  },

  concatClearFiles() {
    this._concatFiles = [];
    this._concatResult = null;
    this.renderConcat();
  },

  concatRemoveFile(index) {
    this._concatFiles.splice(index, 1);
    this.renderConcat();
  },

  concatMove(from, to) {
    if (to < 0 || to > this._concatFiles.length - 1 + 1) return;
    const [item] = this._concatFiles.splice(from, 1);
    this._concatFiles.splice(to, 0, item);
    this._concatResult = null;
    this.renderConcat();
    this.flashConcatRow(to);
  },

  flashConcatRow(index) {
    const rows = document.querySelectorAll('.concat-item');
    const row = rows[index];
    if (!row) return;
    row.classList.add('flash');
    clearTimeout(this._concatFlashTimer);
    this._concatFlashTimer = setTimeout(() => row.classList.remove('flash'), 900);
  },

  setConcatDropHint(index, before) {
    this._concatDropIndex = index;
    this._concatDropBefore = before;
    const rows = document.querySelectorAll('.concat-item');
    rows.forEach((r, i) => {
      r.classList.remove('drop-before', 'drop-after');
      if (i === index && i !== this._concatDragIndex) r.classList.add(before ? 'drop-before' : 'drop-after');
    });
  },

  clearConcatDropHints() {
    this._concatDropIndex = null;
    this._concatDropBefore = false;
    document.querySelectorAll('.concat-item').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  },

  concatDragScroll(e) {
    const list = $('concat-list');
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const zone = 36;
    if (e.clientY < rect.top + zone) {
      list.scrollTop -= 24;
    } else if (e.clientY > rect.bottom - zone) {
      list.scrollTop += 24;
    }
  },

  renderConcat() {
    const list = $('concat-list');
    list.innerHTML = '';
    const filesBox = $('concat-files-box');
    if (!this._concatFiles.length) {
      filesBox.classList.remove('hidden');
      const empty = document.createElement('div');
      empty.className = 'concat-empty';
      empty.textContent = 'No files. Click or drop to add.';
      empty.addEventListener('click', () => this.concatAddFiles());
      empty.addEventListener('dragover', (e) => { e.preventDefault(); empty.classList.add('drag-over'); });
      empty.addEventListener('dragleave', () => empty.classList.remove('drag-over'));
      empty.addEventListener('drop', (e) => {
        e.preventDefault();
        empty.classList.remove('drag-over');
        if (this._concatBusy) return;
        const paths = [];
        for (const f of e.dataTransfer.files) {
          const p = window.keycut.getFilePath ? window.keycut.getFilePath(f) : null;
          if (p) paths.push(p);
        }
        if (paths.length) this.concatAddPaths(paths);
      });
      list.appendChild(empty);
    } else {
      filesBox.classList.remove('hidden');
      this._concatFiles.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'concat-item';
        row.draggable = !this._concatBusy;
        row.dataset.index = i;
        row.innerHTML = '<span class="concat-idx">' + (i + 1) + '</span><span class="concat-name" title="' + f.path.replace(/"/g, '&quot;') + '"></span><button class="btn btn--xs btn--danger concat-del" title="Remove">✕</button>';
        row.querySelector('.concat-name').textContent = f.name;
        row.querySelector('.concat-del').addEventListener('click', (e) => { e.stopPropagation(); this.concatRemoveFile(i); });
        row.addEventListener('dragstart', (e) => { if (this._concatBusy) { e.preventDefault(); return; } this._concatDragIndex = i; this._concatDragDir = null; this._concatDragLastY = e.clientY; row.classList.add('dragging'); });
        row.addEventListener('dragend', () => { row.classList.remove('dragging'); this._concatDragIndex = null; this._concatDragDir = null; this._concatDragLastY = null; this.clearConcatDropHints(); });
        row.addEventListener('dragover', (e) => {
          if (this._concatBusy) return;
          if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          const delta = e.clientY - this._concatDragLastY;
          if (Math.abs(delta) > 2) this._concatDragDir = delta < 0 ? -1 : 1;
          this._concatDragLastY = e.clientY;
          if (this._concatDragDir == null) return;
          this.concatDragScroll(e);
          const before = this._concatDragDir === -1;
          this.setConcatDropHint(i, before);
        });
        row.addEventListener('drop', (e) => {
          if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
            if (this._concatBusy) return;
            const paths = [];
            for (const f of e.dataTransfer.files) {
              const p = window.keycut.getFilePath ? window.keycut.getFilePath(f) : null;
              if (p) paths.push(p);
            }
            if (paths.length) { this.concatAddPaths(paths); }
            return;
          }
          e.preventDefault();
          const from = this._concatDragIndex;
          const to = this._concatDropIndex;
          this.clearConcatDropHints();
          if (from == null || to == null) return;
          const before = this._concatDragDir === -1;
          let target = before ? to : to + 1;
          if (from < target) target--;
          if (target === from) return;
          this.concatMove(from, target);
        });
        list.appendChild(row);
      });
      list.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && list.contains(e.relatedTarget)) return;
        this.clearConcatDropHints();
      });
    }
    $('concat-result').classList.toggle('hidden', !this._concatResult);
    $('concat-saveas').classList.toggle('hidden', !this._concatResult);
    $('concat-insert').classList.toggle('hidden', !this._concatResult);
    const st = $('concat-status');
    if (st) { st.textContent = ''; st.classList.remove('concat-status--error'); }
    if (this._concatResult) {
      $('concat-result-name').textContent = this._concatResult;
    }
    $('concat-clear').classList.toggle('hidden', !this._concatFiles.length || this._concatBusy);
    $('concat-close').disabled = this._concatBusy;
    $('concat-open').disabled = this._concatBusy;
    $('concat-saveas').disabled = this._concatBusy;
    $('concat-insert').disabled = this._concatBusy;
    $('concat-cancel').classList.toggle('hidden', !this._concatBusy);
    $('concat-join').classList.toggle('hidden', this._concatFiles.length < 2 || !!this._concatResult);
    $('concat-join').disabled = this._concatBusy;
  },

  async concatJoin() {
    if (this._concatBusy || this._concatFiles.length < 2) return;
    this._concatBusy = true;
    this._concatResult = null;
    this.renderConcat();
    this.setConcatProgress(0);
    const unsub = window.keycut.onConcatProgress((p) => {
      if (p.progress != null) this.setConcatProgress(p.progress);
    });
    const res = await window.keycut.concatJoin({ files: this._concatFiles.map((f) => f.path) });
    unsub();
    this._concatBusy = false;
    this.renderConcat();
    if (!res || !res.ok) {
      const msg = (res && res.error) || 'unknown error';
      if (msg !== 'Cancelled') {
        this.setStatus('Join failed: ' + msg);
        const st = $('concat-status');
        if (st) { st.textContent = msg; st.classList.add('concat-status--error'); }
      }
      this.setConcatProgress(0);
      return;
    }
    const st = $('concat-status');
    if (st) { st.textContent = ''; st.classList.remove('concat-status--error'); }
    this._concatResult = res.out;
    this.setConcatProgress(0);
    this.renderConcat();
  },

  async concatCancel() {
    if (!this._concatBusy) return;
    await window.keycut.concatCancel();
    this.setStatus('Join cancelled.');
  },

  setConcatProgress(p) {
    const fill = $('concat-fill');
    if (!fill) return;
    if (p <= 0) fill.style.transition = 'none';
    else fill.style.transition = '';
    fill.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
  },

  async concatSaveAs() {
    if (!this._concatResult) return;
    const defaultName = this._concatResult.split(/[\\/]/).pop();
    const outPath = await window.keycut.saveExportDialog(defaultName, false);
    if (!outPath) return;
    const ok = await window.keycut.concatCopyOutput({ from: this._concatResult, to: outPath });
    if (!ok || !ok.ok) { this.setStatus('Save failed'); return; }
    await window.keycut.concatRemoveOutput({ out: this._concatResult });
    this._concatResult = outPath;
    this.setStatus('Saved.');
    this.renderConcat();
  },

  async concatInsert() {
    if (!this._concatResult) return;
    const hasContent = this.model && this.model.cuts && this.model.cuts.length > 1;
    if (hasContent) {
      const ok = await this.confirmDialog('This will replace the current timeline. Continue?');
      if (!ok) return;
    }
    const out = this._concatResult;
    const cursor = 0;
    const pps = null;
    const vstart = 0;
    this.loadPlacedVideo(out, [0, this.state.duration], [false], [], cursor, pps, vstart, null);
    this._concatResult = null;
    this.renderConcat();
    $('concat-modal').classList.add('hidden');
  },

  setKeys() {
    if (!this.state.source) return;
    if (this.video && !this.video.paused) this.pause();
    this._convertCancelled = false;
    this._convertOutPath = null;
    this._convertReq = (this._convertReq || 0) + 1;
    this._convertState = 'analyzing';
    this._convertMsg = 'Analyzing video…';
    this._convertAction = null;
    $('convert-modal').classList.remove('hidden');
    this.closeFind();
    this.setConvertDetail('high');
    this.renderConvert();
    this.setConvertUIEnabled(false);
    this.runConvertAnalysis(this._convertReq);
  },

  setConvertDetail(level) {
    this._convertDetail = level;
    for (const l of ['low', 'medium', 'high']) {
      $('detail-' + l).classList.toggle('btn--primary', l === level);
    }
    $('detail-desc').textContent = {
      low: '≈2 keyframes/s - coarser cuts, smallest file.',
      medium: '≈6 keyframes/s - balanced quality and size.',
      high: '≈10 keyframes/s - finest cuts, largest file.'
    }[level];
  },

  renderConvert() {
    const s = this._convertState;
    const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
    show('convert-modal-msgbox', !!this._convertMsg);
    show('convert-modal-sub', s === 'ready');
    show('convert-modal-detail', s === 'ready');
    show('detail-desc', s === 'ready');
    show('convert-modal-bar', s === 'analyzing' || s === 'converting');
    show('convert-modal-fill', s === 'analyzing' || s === 'converting');
    show('convert-cancel', s === 'ready' || s === 'converting' || s === 'done');
    show('convert-place', s === 'done');
    show('convert-action', s === 'ready' || s === 'error' || s === 'done');
    const mb = $('convert-modal-msgbox');
    if (mb) mb.classList.toggle('boxed', s === 'ready');
    const msgEl = $('convert-modal-message');
    if (msgEl) msgEl.textContent = this._convertMsg || '';
    const fill = $('convert-modal-fill');
    if (fill) {
      fill.classList.toggle('indeterminate', s === 'analyzing');
      if (s === 'analyzing' || s === 'converting') fill.style.width = '0%';
    }
    const action = this._convertAction;
    const act = $('convert-action');
    if (act) { act.textContent = action ? action.text : ''; act.title = action ? action.title : ''; }
    const cancel = $('convert-cancel');
    if (cancel) { cancel.textContent = 'Cancel'; cancel.title = 'Cancel'; }
  },

  async runConvertAnalysis(req) {
    const unsub = window.keycut.onConvertAnalyzeProgress((p) => {
      if (this._convertState !== 'analyzing' || req !== this._convertReq) return;
      if (p.progress != null) {
        const pct = Math.round(p.progress * 100);
        $('convert-modal-fill').classList.remove('indeterminate');
        $('convert-modal-fill').style.width = pct + '%';
        const msgEl = $('convert-modal-message');
        if (msgEl) msgEl.textContent = 'Analyzing… ' + pct + '%';
      }
    });
    const res = await window.keycut.convertAnalyze({
      src: this.state.source,
      duration: this.state.duration
    });
    unsub();
    if (this._convertState !== 'analyzing' || req !== this._convertReq) return;
    this.setConvertUIEnabled(true);
    if (!res || !res.ok) {
      this._convertState = 'error';
      this._convertMsg = (res && res.error) ? res.error : 'Analysis failed';
      this._convertAction = { text: 'Close', title: 'Close' };
      this.renderConvert();
      return;
    }
    this._convertState = 'ready';
    const fps = this.state.fps || 0;
    const enough = res.enough || (fps > 0 && fps <= 2);
    if (enough) {
      this._convertMsg = 'This video has approximately ' + res.avg.toFixed(1) + ' keyframes/sec on average. It already has enough keyframes for precise cutting.';
      this._convertAction = { text: 'Convert anyway', title: 'Convert anyway' };
    } else {
      this._convertMsg = 'The output file will be significantly larger than the original.';
      this._convertAction = { text: 'Convert', title: 'Convert' };
    }
    this.renderConvert();
  },

  convertAction() {
    if (this._convertState === 'ready') {
      this.startConversion();
    } else if (this._convertState === 'error') {
      this.closeConvertModal();
    } else if (this._convertState === 'done') {
      this.placeVideo(true);
    }
  },

  async startConversion() {
    this._convertState = 'converting';
    this._convertCancelled = false;
    this._convertMsg = 'Encoding…';
    this._convertAction = null;
    this.renderConvert();
    this.setConvertUIEnabled(false);
    const unsub = window.keycut.onConvertProgress((p) => {
      if (p.progress != null && this._convertState === 'converting') {
        const pct = Math.round(p.progress * 100);
        $('convert-modal-fill').style.width = pct + '%';
        const msgEl = $('convert-modal-message');
        if (msgEl) msgEl.textContent = 'Encoding… ' + pct + '%';
      }
    });
    const res = await window.keycut.convertStart({
      src: this.state.source,
      duration: this.state.duration,
      interval: CONVERT_INTERVALS[this._convertDetail] || 0.1
    });
    unsub();
    if (this._convertState !== 'converting') return;
    this.setConvertUIEnabled(true);
    if (!res || !res.ok) {
      this._convertState = 'error';
      this._convertMsg = (res && res.error) ? res.error : 'Conversion failed';
      this._convertAction = { text: 'Close', title: 'Close' };
      this.renderConvert();
      return;
    }
    this._convertState = 'done';
    this._convertOutPath = res.out;
    this._convertMsg = 'Conversion complete.';
    this._convertAction = { text: 'Place and save', title: 'Place keyframed video and save project' };
    const fill = $('convert-modal-fill');
    if (fill) fill.style.width = '100%';
    this.renderConvert();
  },

  placeVideo(save) {
    if (!this._convertOutPath) return;
    const out = this._convertOutPath;
    const cuts = this.model ? this.model.cuts.slice() : [];
    const deleted = this.model ? this.model.deleted.slice() : [];
    const markers = this.timeline && this.timeline.markers ? this.timeline.markers.map((m) => ({ ...m })) : [];
    const cursor = this.state.cursor;
    const pps = this.timeline ? this.timeline.pxPerSec : null;
    const vstart = this.timeline ? this.timeline.viewStart : null;
    this.closeConvertModal();
    this.loadPlacedVideo(out, cuts, deleted, markers, cursor, pps, vstart, () => {
      if (save) this.savePlacedProject();
    });
  },

  savePlacedProject() {
    let filePath = this.state.projectPath;
    if (!filePath) {
      const src = this.state.source;
      if (src) filePath = src.replace(/\.[^.]+$/, '') + '.kc';
    }
    if (filePath) this.saveProjectTo(filePath);
  },

  async loadPlacedVideo(path, cuts, deleted, markers, cursor, pps, vstart, afterLoad) {
    this.showTaskModal({ title: 'Open file', message: 'Analyzing…', indeterminate: true });
    const meta = await window.keycut.probeVideo(path);
    this.hideTaskModal();
    if (!meta || meta.error) {
      this.setStatus('Error: ' + (meta && meta.error ? meta.error : 'failed to analyze converted video'));
      return;
    }
    const oldDuration = this.state.duration;
    const durOk = Math.abs(oldDuration - meta.duration) < 0.05;
    this.state.source = path;
    window.keycut.lockSource(path);
    this._videoSize = null;
    this.cancelSkipMute();
    this.stopPlaybackGuard();
    this.cancelStepPause();
    const tl = this.timeline;
    this.model.clearHistory();
    if (durOk) {
      this.model.cuts = cuts;
      this.model.deleted = deleted;
      this.model.duration = oldDuration;
    } else {
      this.model.reset(meta.duration);
    }
    this._loadingSrc = true;
    this.video.src = toFileUrl(path);
    this.video.load();
    if (this.scrubAudio) { this.scrubAudio.src = toFileUrl(path); this.scrubAudio.load(); }
    this.state.dirty = false;
    this.$labelUpdate();
    await this.applyVideoMeta(meta);
    this._loadingSrc = false;
    tl.markers = (markers || []).map((m) => ({ id: ++tl._markerSeq, t: m.t, name: m.name || '', color: m.color || '#7bd88f', off: !!m.off }));
    if (Number.isFinite(pps) && pps > 0) tl.pxPerSec = Math.max(tl.minZoom(), Math.min(ZOOM_MAX, pps));
    if (Number.isFinite(vstart)) tl.viewStart = vstart;
    this.syncExportButton();
    const c = Math.min(Math.max(0, cursor || 0), meta.duration);
    this.seek(c);
    tl.cursor = c;
    tl.clampView();
    tl.needsRender = true;
    tl.tick();
    this.model.snapshot();
    this.state.dirty = false;
    this.$labelUpdate();
    this.updateStats();
    this.setStatus('Loaded: ' + path);
    if (afterLoad) afterLoad();
  },

  cancelConvert() {
    const cs = this._convertState;
    if (cs === 'analyzing' || cs === 'converting') {
      this._convertCancelled = true;
      window.keycut.convertCancel();
      this.setConvertUIEnabled(true);
    } else if (cs === 'done') {
      const out = this._convertOutPath;
      if (out) window.keycut.convertRemoveOutput({ out });
    }
    this.closeConvertModal();
  },

  closeConvertModal() {
    $('convert-modal').classList.add('hidden');
    this._convertState = null;
    this._convertCancelled = false;
    this._convertOutPath = null;
  },

  setConvertUIEnabled(on) {
    $('btn-open').disabled = !on;
    $('btn-save').disabled = !on;
    $('btn-export').disabled = !on;
    $('btn-set-keys').disabled = !on;
    if (this.video && !on && !this.video.paused) this.pause();
  }
};

document.addEventListener('DOMContentLoaded', () => app.init());
window.__app = app;
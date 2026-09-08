'use strict';

// ---------- Utils ----------

const $ = (id) => document.getElementById(id);

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

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5.5 L18.5 12 L8 18.5 Z" fill="currentColor"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="7" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor"/></svg>';

// Canvas palette - mirrors the CSS design tokens so both stay in sync.
const COLORS = {
  bg: '#101216',
  noVideoBg: '#0d0f12',
  noVideoText: '#6b7280',
  segKeptFrom: '#4aa8ff',
  segKeptTo: '#2f8ef0',
  segDeleted: '#22252b',
  segDeletedFrame: 'rgba(172,182,196,0.3)',
  segBoundary: 'rgba(255,255,255,0.55)',
  keyframeRgb: '255,209,102',
  keyframeAlphaBright: 0.95,
  keyframeAlphaDim: 0.5,
  // On dimmed (gray) blocks keyframe lines are a light gray so they stay
  // clearly visible against the dark block background (but not accent yellow).
  keyframeGrayRgb: '94,102,112',
  keyframeGrayAlphaBright: 0.95,
  keyframeGrayAlphaDim: 0.5,
  selectionKept: '#ffffff',
  selectionGray: '#d8dee6',
  resizeHandle: 'rgba(255,255,255,0.95)',
  hatch: 'rgba(0,0,0,0.10)',
  rulerBg: '#15171b',
  rulerTick: '#4a5058',
  rulerMinor: '#33383f',
  rulerLabel: '#6b7280',
  playhead: '#ffffff',
  separator: '#24282e'
};

// ---------- EditorModel ----------

class EditorModel {
  constructor(duration) {
    this.cuts = [];
    this.deleted = [];
    this.duration = 0;
    this.history = [];
    this.historyIndex = -1;
    this._runsCache = null;
    this.onMutate = null;
    this.suppressSnapshot = false;
    if (duration > 0) this.reset(duration);
  }

  clearHistory() {
    this.history = [];
    this.historyIndex = -1;
  }

  // Push the current state for undo. Snapshots are capped by a memory budget so
  // projects with millions of cuts stay undoable without exhausting RAM.
  snapshot() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push({ cuts: this.cuts.slice(), deleted: this.deleted.slice() });
    this._runsCache = null;
    const per = this.cuts.length * 12 + 8;
    const cap = Math.max(1, Math.min(100, Math.floor((64 * 1024 * 1024) / per)));
    if (this.history.length > cap) this.history.splice(0, this.history.length - cap);
    this.historyIndex = this.history.length - 1;
    if (this.onMutate) this.onMutate();
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
    if (this.onMutate) this.onMutate();
  }

  reset(duration) {
    this.duration = duration;
    this.cuts = [0, duration];
    this.deleted = [false];
    this._runsCache = null;
  }

  // index of segment [cuts[i], cuts[i+1]) containing t
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

  // dim a segment (mark it deleted/excluded); keeps it on the timeline
  deleteAt(i) {
    return this.deleteRange(i, i);
  }

  // restore a dimmed segment
  restoreAt(i) {
    return this.restoreRange(i, i);
  }

  // dim a contiguous range of segments
  deleteRange(a, b) {
    if (a < 0 || b >= this.deleted.length || a > b) return false;
    if (!this.deleted.slice(a, b + 1).some((d) => !d)) return false;
    for (let i = a; i <= b; i++) this.deleted[i] = true;
    this.snapshot();
    return true;
  }

  // dim an arbitrary set of segment indices (Alt+click multi-selection)
  deleteIndices(idx) {
    const idxs = [...new Set(idx)].filter((i) => Number.isInteger(i) && i >= 0 && i < this.deleted.length);
    if (!idxs.length) return false;
    if (!idxs.some((i) => !this.deleted[i])) return false;
    for (const i of idxs) this.deleted[i] = true;
    this.snapshot();
    return true;
  }

  // restore an arbitrary set of segment indices
  restoreIndices(idx) {
    const idxs = [...new Set(idx)].filter((i) => Number.isInteger(i) && i >= 0 && i < this.deleted.length);
    if (!idxs.length) return false;
    if (!idxs.some((i) => this.deleted[i])) return false;
    for (const i of idxs) this.deleted[i] = false;
    this.snapshot();
    return true;
  }

  // restore a contiguous range of segments
  restoreRange(a, b) {
    if (a < 0 || b >= this.deleted.length || a > b) return false;
    if (!this.deleted.slice(a, b + 1).some((d) => d)) return false;
    for (let i = a; i <= b; i++) this.deleted[i] = false;
    this.snapshot();
    return true;
  }

  // merge selected adjacent segments [a..b] back into one whole block.
  // Works for kept (blue) and dimmed (gray) blocks alike; the run must be
  // homogeneous (never mixed kept+gray).
  mergeRange(a, b) {
    if (a < 0 || b >= this.deleted.length || a > b) return false;
    if (a === b) return false;
    const st = this.deleted[a];
    for (let i = a + 1; i <= b; i++) if (this.deleted[i] !== st) return false;
    this.snapshot();
    this.cuts.splice(a + 1, b - a);
    this.deleted.splice(a, b - a + 1, st);
    return true;
  }

// Drag a boundary between a kept and a gray segment. The boundary can move
// freely within the union of the two segments (snapping to keyframes): into
// the gray it extends the kept one, into the kept one it shrinks it. When it
// reaches either far side the consumed segment is merged away completely.
// Returns 0 = no-op, 1 = boundary moved, 2 = one segment fully consumed.
moveBoundary(k, t) {
  if (k < 1 || k > this.cuts.length - 2) return 0;
  const keptBefore = !this.deleted[k - 1];
  const keptAfter = !this.deleted[k];
  if (keptBefore === keptAfter) return 0; // not a kept|gray boundary
  const lo = this.cuts[k - 1];
  const hi = this.cuts[k + 1];
  t = Math.min(Math.max(t, lo), hi);
  if (Math.abs(t - this.cuts[k]) < 1e-9) return 0;
  if (!this.suppressSnapshot) this.snapshot();
  if (t - lo < 1e-9) {
    // left extreme: segment k-1 consumed, segment k survives
    this.cuts.splice(k, 1);
    this.deleted.splice(k - 1, 1);
    return 2;
  }
  if (hi - t < 1e-9) {
    // right extreme: segment k consumed, segment k-1 survives
    this.cuts.splice(k, 1);
    this.deleted.splice(k, 1);
    return 2;
  }
  this.cuts[k] = t;
  return 1;
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

// ---------- Timeline ----------

// One continuous timeline: the segments track fills the whole row, the ruler
// sits below it. Kept segments are blue, dimmed (cut out) segments are dark.
const SEG = { y: 1, h: 50 };
const RULER = { y: 53, h: 18 };

// Corner radius for segment blocks / selection frame - mirrors --radius-md
// (the button radius) so the whole UI shares one scale.
const SEG_RADIUS = 7;

// Hold-to-scan speed adapts to keyframe density: we cross ~SCAN_KF_PER_SEC
// keyframes per second of holding, clamped to a sane range so pathological
// projects (e.g. all-I-frame) don't become unusably slow.
const SCAN_KF_PER_SEC = 6;
const SCAN_SPEED_MIN = 1;
const SCAN_SPEED_MAX = 20;

// Pause between a tap on S/F and automatic playback resume (so the rewind is
// visible). Repeated taps restart it.
const STEP_PAUSE_MS = 200;

// Playback boundary semantics:
//  - cuts are always placed on keyframes; the frame at time cuts[k] belongs to
//    segment k (the one that STARTS at that boundary). segmentOf() implements
//    exactly this rule.
//  - a kept segment plays from its start keyframe up to (not including) its end
//    boundary.
//  - when the playhead reaches a frame of a gray segment, playback jumps to the
//    start keyframe of the next kept run.
// SEEK_EPS is sub-frame and never changes the presented frame. Seeking to a
// kept start EXACTLY (no offset) plays from the first sample of that segment;
// the epsilon is only used as a nudge in guardTarget() so the browser's
// boundary read-back is never misread as the gray tail (which would re-trigger
// the guard and skip the very start of the kept audio).
const SEEK_EPS = 0.001;

// Tuning constants (UX / rendering / playback).
const ZOOM_MIN = 1;
const ZOOM_MAX = 20000;
const SCROLLBAR_THUMB_MIN = 120;
const SCROLLBAR_PAD = 4; // inner margin so the thumb never touches the track edges
const RESIZE_TOL_PX = 7;
const WHEEL_LINE_PX = 40;          // deltaMode 'line' -> approximate pixels
const WHEEL_STEP_FRACTION = 0.12;  // view width moved per wheel notch
const RENDER_CAP = 4000;           // per-frame culling caps (segments/keyframes)
const CARET_UPDATE_MS = 0.004;     // min caret move before re-render during playback
const DUR_EXTEND_MARGIN = 0.05;    // loadedmetadata correction margin
const BLIP_MS = 80;                // min gap between audio blips
const BLIP_PLAY_MS = 150;          // how long a blip plays
const HOLD_TO_SCAN_MS = 250;       // key held before scanning starts
const SCAN_INTERVAL_MS = 33;       // scan update interval
const SCAN_SEEK_MS = 0.03;         // min scan move before seeking the video
const EXPORT_CONCAT_PROGRESS = 0.97;

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

// The caret is never free: it snaps to the nearest keyframe. Cuts therefore
// always land on keyframes (lossless-friendly).
function snapKey(t, keys) {
  if (!keys || !keys.length) return t;
  let idx = binaryFirst(keys, t);
  if (idx >= keys.length) return keys[keys.length - 1];
  const prev = idx > 0 ? keys[idx - 1] : keys[0];
  const next = keys[idx];
  return (next - t <= t - prev) ? next : prev;
}

// Nearest keyframe inside [lo, hi] (used when dragging a boundary across a
// gray segment - its interior keyframes become valid cut positions again).
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

// Largest keyframe <= t (the start of the keyframe interval the cursor is on).
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

    this.drag = null; // { mode: 'scrub' | 'pan' | 'resize', lastX, moved }
    this.selected = null; // selected segment range [from, to] or null
    this.selectedAnchor = null; // anchor segment index for Shift+click extension
    this.selectedSet = null; // Set of indices for Alt+click multi-selection
    this.needsRender = true;
    this.onZoom = null;
    this.onResize = null; // called after a boundary resize (app refreshes keys/stats)

    this.hatch = null;

    this.scrollbarEl = opts.scrollbar || null;
    this.thumbEl = opts.thumb || null;
    if (this.scrollbarEl && this.thumbEl) this.initScrollbar();

    // Smooth corner-radius transitions (split/merge/dim/restore animate the
    // rounding of the affected blocks). Only visible segments are tracked.
    this.cornerState = new Map(); // segmentIndex -> [tl,tr,br,bl] current radii
    this._cornerRAF = null;

    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
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
    this.updateScrollbar();
  }

  setData({ duration, keyTimes, model, cursor }) {
    this.duration = duration;
    this.keyTimes = keyTimes;
    this.model = model;
    this.selected = null; // selected segment range [from, to] or null
    this.selectedAnchor = null; // anchor segment index for Shift+click extension
    this.selectedSet = null; // Set of indices for Alt+click multi-selection
    if (cursor !== undefined) this.cursor = cursor;
    this.cornerState = new Map();
    this.fit();
    this.needsRender = true;
    this.tick();
  }

  // Backward-compatible single-selection accessor (focus of the range).
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
    this.pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.w / this.duration));
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
  }

  clampView() {
    const viewW = this.w / this.pxPerSec;
    const maxStart = Math.max(0, this.duration - viewW);
    this.viewStart = Math.min(Math.max(0, this.viewStart), maxStart);
    this.updateScrollbar();
  }

  // ---------- scrollbar (Premiere-style) ----------
  // The bar maps the whole project; the thumb is the visible range with a left
  // and a right caret. Drag the body to pan, drag a caret to resize (zoom),
  // click the track to jump the view.

  viewEnd() {
    return this.viewStart + this.w / this.pxPerSec;
  }

  scrollLeftPx(barW) {
    const u = Math.max(1, barW - 2 * SCROLLBAR_PAD);
    return this.duration > 0 ? SCROLLBAR_PAD + (this.viewStart / this.duration) * u : SCROLLBAR_PAD;
  }

  scrollRightPx(barW) {
    const u = Math.max(1, barW - 2 * SCROLLBAR_PAD);
    const e = Math.min(this.viewEnd(), this.duration);
    return this.duration > 0 ? SCROLLBAR_PAD + (e / this.duration) * u : barW - SCROLLBAR_PAD;
  }

  barTime(x, barW) {
    const u = Math.max(1, barW - 2 * SCROLLBAR_PAD);
    const t = ((x - SCROLLBAR_PAD) / u) * this.duration;
    return this.duration > 0 ? Math.min(Math.max(0, t), this.duration) : 0;
  }

  setViewCenter(t) {
    this.viewStart = t - this.w / (2 * this.pxPerSec);
    this.clampView();
  }

  initScrollbar() {
    const bar = this.scrollbarEl;
    // Caret hit zones must match the rendered caret width (CSS ~9px) plus a
    // small tolerance, otherwise grabbing the caret edge falls through to pan.
    const CARET_W = 12;
    const TOL = 4;

    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = bar.getBoundingClientRect();
      const barW = rect.width;
      const x = e.clientX - rect.left;
      const left = this.scrollLeftPx(barW);
      const right = this.scrollRightPx(barW);
      // The rendered thumb may be clamped to its min width, so its visual right
      // edge (where the right caret sits) can be further right than the time-
      // based right.
      const rightVis = Math.max(right, left + SCROLLBAR_THUMB_MIN);

      let mode = 'pan';
      let grabOff = 0;
      if (x >= left - TOL && x <= left + CARET_W + TOL) { mode = 'left'; grabOff = x - left; }
      else if (x >= rightVis - CARET_W - TOL && x <= rightVis + TOL) { mode = 'right'; grabOff = rightVis - x; }
      else if (x < left - TOL || x > rightVis + TOL) {
        // click on track: centre the view there, then allow panning
        this.setViewCenter(this.barTime(x, barW));
        this.needsRender = true;
        this.tick();
        this.updateScrollbar();
      }
      const startX = x;
      const startView = this.viewStart;
      if (this.thumbEl) this.thumbEl.classList.add('dragging');

      const move = (ev) => {
        const nx = ev.clientX - rect.left;
        // Preserve where inside the caret the grab happened, so the caret
        // follows the mouse exactly instead of jumping.
        if (mode === 'left') this.dragLeftEdge(nx - grabOff, barW);
        else if (mode === 'right') this.dragRightEdge(nx + grabOff, barW);
        else {
          const u = Math.max(1, barW - 2 * SCROLLBAR_PAD);
          this.viewStart = startView + ((nx - startX) / u) * this.duration;
          this.clampView();
        }
        this.needsRender = true;
        this.tick();
        this.updateScrollbar();
      };
      const up = () => {
        if (this.thumbEl) this.thumbEl.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  // min visible range (full zoom-in) in seconds
  minViewW() {
    return this.w / ZOOM_MAX;
  }

  dragLeftEdge(x, barW) {
    const end = Math.min(this.viewEnd(), this.duration);
    const leftT = Math.min(this.barTime(x, barW), end - this.minViewW());
    const viewW = Math.max(this.minViewW(), end - leftT);
    this.pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.w / viewW));
    this.viewStart = end - viewW;
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
  }

  dragRightEdge(x, barW) {
    const rightT = Math.max(this.barTime(x, barW), this.viewStart + this.minViewW());
    const viewW = Math.max(this.minViewW(), rightT - this.viewStart);
    this.pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.w / viewW));
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
  }

  updateScrollbar() {
    if (!this.scrollbarEl || !this.thumbEl) return;
    const barW = this.scrollbarEl.clientWidth || 0;
    const left = this.scrollLeftPx(barW);
    const right = this.scrollRightPx(barW);
    this.thumbEl.style.left = left + 'px';
    this.thumbEl.style.width = Math.max(SCROLLBAR_THUMB_MIN, right - left) + 'px';
  }

  timeToX(t) { return (t - this.viewStart) * this.pxPerSec; }
  xToTime(x) { return this.viewStart + x / this.pxPerSec; }

  // Zoom keeping the CENTRE of the visible range fixed.
  setZoom(pps) {
    const pps2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pps));
    if (this.duration <= 0) { this.pxPerSec = pps2; return; }
    const center = this.viewStart + this.w / (2 * this.pxPerSec);
    this.pxPerSec = pps2;
    this.viewStart = center - this.w / (2 * pps2);
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
    this.needsRender = true;
    this.tick();
  }

  // Ctrl+wheel zooms anchored at the pointer position (the time under the
  // cursor stays under it). The zoom slider uses setZoom() instead.
  zoomAt(mx, factor) {
    const oldPPS = this.pxPerSec;
    const t = this.xToTime(mx);
    this.pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldPPS * factor));
    this.viewStart = t - mx / this.pxPerSec;
    this.clampView();
    if (this.onZoom) this.onZoom(this.pxPerSec);
    this.needsRender = true;
    this.tick();
  }

  // ---------- smooth corner-radius transitions ----------
  // Every block is a rounded chip (all four corners = SEG_RADIUS). When a cut
  // creates a new boundary, the two new chips' facing corners animate from 0
  // to SEG_RADIUS so a split visibly grows two rounded blocks. The animation
  // is tracked per boundary time so indices shifting across edits don't matter.

  radiusAt(t) {
    const s = this.cornerState.get(t);
    return s !== undefined ? s : SEG_RADIUS;
  }

  // Capture the set of boundary times present before an edit.
  captureCornerTargets() {
    if (!this.model || !this.model.cuts.length) return new Set();
    return new Set(this.model.cuts);
  }

  // After an edit: boundaries that appeared (new cuts) animate their rounding
  // in from 0; boundaries that disappeared are simply gone.
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

  // ---------- interactions ----------

  regionAt(y) {
    if (y >= SEG.y && y < SEG.y + SEG.h) return 'seg';
    if (y >= RULER.y && y < RULER.y + RULER.h) return 'ruler';
    return null;
  }

  setCursor(t, fromVideo = false) {
    t = Math.min(Math.max(0, snapKey(t, this.activeKeys || this.keyTimes)), this.duration || 0);
    this.cursor = t;
    if (!fromVideo) app.seek(t);
    this.needsRender = true;
    this.tick();
  }

  selectSegment(i, shift = false) {
    if (!this.model) {
      this.selected = null;
      this.selectedAnchor = null;
      this.selectedSet = null;
      this.needsRender = true;
      this.tick();
      return;
    }
    this.selectedSet = null; // Alt+click multi-selection gives way to plain/Shift clicks
    if (shift && this.selectedAnchor != null) {
      // Extend within a homogeneous run (all kept or all gray) - a selection
      // never crosses a kept|gray boundary.
      const a = this.selectedAnchor;
      const st = this.model.deleted[a];
      const same = (idx) => idx >= 0 && idx < this.model.deleted.length && this.model.deleted[idx] === st;
      let lo = a;
      while (lo > 0 && same(lo - 1)) lo--;
      let hi = a;
      while (hi < this.model.deleted.length - 1 && same(hi + 1)) hi++;
      const jc = Math.max(lo, Math.min(hi, i));
      this.selected = [Math.min(a, jc), Math.max(a, jc)];
    } else {
      this.selected = [i, i];
      this.selectedAnchor = i;
    }
    this.needsRender = true;
    this.tick();
  }

  // Alt+click: toggle a segment in/out of a multi-selection (used to gather
  // several kept segments before dimming them all with X). The FIRST Alt+click
  // starts the multi-set from the first segment (carrying over any current
  // plain selection) - it never drops the already-selected segment.
  toggleSelectSegment(i) {
    if (!this.model || i < 0 || i >= this.model.deleted.length) return;
    if (!this.selectedSet) {
      this.selectedSet = new Set(this.selectionIndices());
      this.selected = null;
      this.selectedSet.add(i);
    } else if (this.selectedSet.has(i)) {
      this.selectedSet.delete(i);
    } else {
      this.selectedSet.add(i);
    }
    this.selectedAnchor = i;
    if (this.selectedSet.size === 0) this.selectedSet = null;
    this.needsRender = true;
    this.tick();
  }

  // Indices currently selected, from the Alt multi-set or the plain range.
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

  onDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const region = this.regionAt(y);
    if (app.cancelStepPause) app.cancelStepPause();
    // Pan with middle button or drag on empty margins. Shift is reserved for
    // multi-select (Shift+click extends the selection).
    const pan = e.button === 1 || region === null;
    // Alt+click is multi-select (toggle a segment), so it never starts a
    // resize drag.
    const rk = (!pan && region === 'seg' && !e.altKey) ? this.resizeBoundaryAt(x) : null;
    if (rk != null) {
      // Manual editing - stop playback before the user grabs the timeline.
      if (app.video && !app.video.paused) app.pause();
      this.drag = { mode: 'resize', k: rk, lastX: x, x, y, region };
      // Coalesce the whole drag into ONE undo step: suppress per-move
      // snapshots and keep the pre-drag state, committed on mouseup.
      this.model.suppressSnapshot = true;
      this._dragBefore = { cuts: this.model.cuts.slice(), deleted: this.model.deleted.slice() };
      e.preventDefault();
      return;
    }
    this.drag = { mode: pan ? 'pan' : 'scrub', lastX: x, moved: false, x, y, region, shift: e.shiftKey };
    if (!pan) {
      // Manual editing - stop playback before the user scrubs the timeline.
      if (app.video && !app.video.paused) app.pause();
      this.setCursor(this.xToTime(x));
      if (this.onScrub) this.onScrub(this.cursor);
      if (region === 'seg') {
        if (e.altKey) this.toggleSelectSegment(this.model.segmentOf(this.xToTime(x)));
        else this.selectSegment(this.model.segmentOf(this.xToTime(x)), e.shiftKey);
      }
    }
    e.preventDefault();
  }

  onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (!this.drag) {
      // Hover: show a resize cursor when over a kept|gray boundary.
      const rk = this.regionAt(e.clientY - rect.top) === 'seg' ? this.resizeBoundaryAt(x) : null;
      this.canvas.style.cursor = rk != null ? 'ew-resize' : 'default';
      return;
    }
    const dx = x - this.drag.lastX;
    if (Math.abs(dx) > 1) this.drag.moved = true;
    if (this.drag.mode === 'pan') {
      this.viewStart -= dx / this.pxPerSec;
      this.clampView();
    } else if (this.drag.mode === 'resize') {
      this.resizeTo(this.drag.k, this.xToTime(x));
    } else {
      this.setCursor(this.xToTime(x));
      if (this.onScrub) this.onScrub(this.cursor);
      if (this.drag.shift && this.drag.region === 'seg') {
        this.selectSegment(this.model.segmentOf(this.xToTime(x)), true);
      }
    }
    this.drag.lastX = x;
    this.needsRender = true;
    this.tick();
  }

  onUp() {
    if (this.drag && this.drag.mode === 'scrub' && this.onScrubEnd) this.onScrubEnd();
    this.endResizeDrag();
    this.drag = null;
  }

  // Commit a single undo entry for the whole resize drag (mousedown -> mouseup)
  // instead of one per mouse move. The per-move snapshots were suppressed, so
  // the history tail is still the pre-drag state; pushing the current state now
  // makes undo -> pre-drag and redo -> post-drag both correct.
  endResizeDrag() {
    if (!this._dragBefore) return;
    const before = this._dragBefore;
    this._dragBefore = null;
    this.model.suppressSnapshot = false;
    // only record if the drag actually changed the model
    if (!arraysEqual(this.model.cuts, before.cuts) || !arraysEqual(this.model.deleted, before.deleted)) {
      this.model.snapshot();
    }
  }

  // Is boundary cuts[k] between a kept and a gray segment (draggable)?
  resizableBoundary(k) {
    if (!this.model || k < 1 || k > this.model.cuts.length - 2) return false;
    const b = this.model.deleted;
    return b[k - 1] !== b[k];
  }

  // Find the draggable boundary near pixel x, or null.
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
    const snapped = snapInRange(t, lo, hi, this.keyTimes);
    const before = this.captureCornerTargets();
    const res = this.model.moveBoundary(k, snapped);
    if (res === 0) return;
    this.applyCornerChange(before);
    if (this.onResize) this.onResize();
    this.cursor = snapped;
    app.seek(snapped);
    // A consumed segment may leave the selection out of bounds - drop it.
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
    if (res === 2) this.drag = null; // a segment was consumed, boundary gone
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      // Ctrl + wheel zooms around the cursor position.
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      this.zoomAt(x, factor);
      return;
    }
    // Plain wheel scrolls (pans) the timeline. Normalize the delta so a single
    // mouse notch (deltaY ~100px) moves about 12% of the visible width, and
    // trackpad deltas scroll proportionally and smoothly.
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

  // ---------- rendering ----------

  tick() {
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

    this.renderSegments(ctx, viewEnd);
    this.renderKeyframes(ctx, viewEnd);
    this.renderSelection(ctx);
    this.renderResizeHandles(ctx, viewEnd);
    this.renderRuler(ctx);
    // separator first so the playhead draws over it (never cut by the line)
    ctx.fillStyle = COLORS.separator;
    ctx.fillRect(0, RULER.y - 1, w, 1);
    this.renderPlayhead(ctx);
  }

  renderSelection(ctx) {
    const cuts = this.model && this.model.cuts;
    if (!cuts) return;
    const idx = this.selectionIndices();
    if (!idx.length) return;
    const top = SEG.y;
    const bottom = SEG.y + SEG.h;
    // Selection is ONLY a light frame drawn on each selected chip's own rounded
    // outline (no fill) so the block background stays unchanged and nothing
    // pokes out past the rounded edge.
    const stroke = this.model.deleted[idx[0]] ? COLORS.selectionGray : COLORS.selectionKept;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    for (const i of idx) {
      if (i < 0 || i >= cuts.length - 1) continue;
      const x0 = this.timeToX(cuts[i]);
      const x1 = this.timeToX(cuts[i + 1]);
      if (x1 < 0 || x0 > this.w) continue;
      ctx.beginPath();
      ctx.roundRect(x0, top, Math.max(0, x1 - x0), bottom - top, SEG_RADIUS);
      ctx.stroke();
    }
  }

  // Small "< >" handles on kept|gray boundaries - drag to extend the blue
  // segment into the adjacent gray one.
  renderResizeHandles(ctx, viewEnd) {
    if (!this.model) return;
    const cuts = this.model.cuts;
    // Only draw handles at a sane zoom: with 100k+ visible cuts the handles are
    // sub-pixel and drawing them would stall the frame.
    if (binaryFirst(cuts, viewEnd) - Math.max(0, binaryFirst(cuts, this.viewStart) - 1) > 2000) return;
    const first = Math.max(1, binaryFirst(cuts, this.viewStart) - 1);
    const last = Math.min(cuts.length - 2, binaryFirst(cuts, viewEnd) + 1);
    const cy = SEG.y + SEG.h / 2;
    ctx.fillStyle = COLORS.resizeHandle;
    for (let k = first; k <= last; k++) {
      if (!this.resizableBoundary(k)) continue;
      const x = this.timeToX(cuts[k]);
      if (x < -10 || x > this.w + 10) continue;
      ctx.beginPath();
      ctx.moveTo(x - 6, cy - 5); ctx.lineTo(x - 1, cy); ctx.lineTo(x - 6, cy + 5); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + 6, cy - 5); ctx.lineTo(x + 1, cy); ctx.lineTo(x + 6, cy + 5); ctx.closePath();
      ctx.fill();
    }
  }

  renderSegments(ctx, viewEnd) {
    const { y, h } = SEG;
    const model = this.model;
    const cuts = model.cuts;

    // visible cut index range via binary search (culling)
    const first = Math.max(0, binaryFirst(cuts, this.viewStart) - 1);
    const last = Math.min(cuts.length - 1, binaryFirst(cuts, viewEnd));
    const visibleCount = last - first;

    // aggregate mode for pathologically dense zoom-outs
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
        ctx.fillStyle = COLORS.segDeleted;
        ctx.fill();
        if (!this.hatch) this.makeHatch();
        ctx.fillStyle = this.hatch;
        ctx.fill();
        // Permanent dim outline so gray blocks always read as blocks, even
        // without a selection.
        ctx.strokeStyle = COLORS.segDeletedFrame;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, COLORS.segKeptFrom);
        g.addColorStop(1, COLORS.segKeptTo);
        ctx.fillStyle = g;
        ctx.fill();
      }
    }

    // internal cut lines only (same-type neighbours), inset inside the blocks
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
    // Merge runs at pixel resolution: with 100k+ runs (10h lectures) drawing
    // each as its own rect would be far too slow, but at this zoom-out the
    // chips are sub-pixel anyway, so adjacent kept columns collapse into one.
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
    // Draw per pixel column, not per keyframe: at zoom-out a column contains
    // many keys, and drawing one line per column bounds the work by the canvas
    // width regardless of how many keyframes exist (10h lectures, 1M cuts).
    // A column is "bright" when a cut boundary lands on it.
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
      if (gray) {
        const a = bright ? COLORS.keyframeGrayAlphaBright : COLORS.keyframeGrayAlphaDim;
        ctx.fillStyle = 'rgba(' + COLORS.keyframeGrayRgb + ',' + a + ')';
      } else {
        const a = bright ? COLORS.keyframeAlphaBright : COLORS.keyframeAlphaDim;
        ctx.fillStyle = 'rgba(' + COLORS.keyframeRgb + ',' + a + ')';
      }
      ctx.fillRect(col - 0.5, top, 1, bottom - top);
    }
  }

  renderRuler(ctx) {
    const { y, h } = RULER;
    ctx.fillStyle = COLORS.rulerBg;
    ctx.fillRect(0, y, this.w, h);

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
      const x = this.timeToX(t);
      ctx.fillRect(x, y + h - 6, 1, 6);
      if (showMs) {
        ctx.fillRect(x, y + h - 3, 1, 3);
      }
      const label = showMs ? fmtTime(t, true) : (showHms ? fmtTime(t, false) : fmtTime(t, false));
      ctx.fillStyle = COLORS.rulerLabel;
      ctx.fillText(label, x + 3, y + h - 8);
      ctx.fillStyle = COLORS.rulerTick;
    }

    // zoomed-out ticks
    const minor = step / 5;
    if (minor * this.pxPerSec >= 4) {
      ctx.fillStyle = COLORS.rulerMinor;
      for (let t = this.viewStart; t <= this.viewStart + this.w / this.pxPerSec; t += minor) {
        ctx.fillRect(this.timeToX(t), y + h - 3, 1, 3);
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

    // handle
    ctx.fillStyle = COLORS.playhead;
    ctx.beginPath();
    ctx.moveTo(x - 7, 2);
    ctx.lineTo(x + 7, 2);
    ctx.lineTo(x, 12);
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

// ---------- App ----------

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
    dirty: false
  },

  init() {
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
    this.model.onMutate = () => this.markDirty();
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

    this.bindDragDrop();

    this.bindUI();
    this.bindVideo();
    this.bindKeys();

    // Ask before closing with unsaved edits (the main process defers close).
    window.keycut.onCloseRequest(() => this.handleCloseRequest());

    this.setVideoEnabled(false);
    this.setStatus('Ready');

    // A file passed by the OS (e.g. double-click on a .kc project, "Open with")
    // is loaded the same way as drag-and-drop.
    window.keycut.getOpenFile().then((p) => {
      if (p) this.handleDroppedFile(p);
    }).catch(() => {});
    window.keycut.onOpenFile((p) => this.handleDroppedFile(p));
  },

  bindDragDrop() {
    let depth = 0;
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragenter', () => { depth++; document.body.classList.add('drag-over'); });
    window.addEventListener('dragleave', () => { depth--; if (depth <= 0) document.body.classList.remove('drag-over'); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('drag-over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const p = window.keycut.getFilePath ? window.keycut.getFilePath(f) : null;
      if (p) this.handleDroppedFile(p);
    });
  },

  async handleDroppedFile(p) {
    const name = p.split(/[\\/]/).pop();
    if (this.state.source) {
      const ok = await window.keycut.confirmOpen(
        'You are already working on a project.\nOpen "' + name + '" anyway? Unsaved changes will be lost.'
      );
      if (!ok) { this.setStatus('Open cancelled'); return; }
    }
    this.scrubEnd();
    if (/\.kc$/i.test(p)) await this.openProjectFromPath(p);
    else await this.loadSource(p);
  },

  bindUI() {
    $('btn-open').addEventListener('click', () => this.openFile());
    $('btn-open2').addEventListener('click', () => this.openFile());
    $('btn-save').addEventListener('click', () => this.saveProject());
    $('btn-export').addEventListener('click', () => this.export());
    $('btn-play').addEventListener('click', () => this.togglePlay());
    $('btn-start').addEventListener('click', () => this.navPause(() => this.seekTo(0)));
    $('btn-end').addEventListener('click', () => this.navPause(() => this.seekTo(this.state.duration)));
    $('btn-prevblock').addEventListener('click', () => this.navPause(() => this.prevBlock()));
    $('btn-nextblock').addEventListener('click', () => this.navPause(() => this.nextBlock()));
    $('btn-prevkf').addEventListener('click', () => this.navPause(() => this.prevKeyframe()));
    $('btn-nextkf').addEventListener('click', () => this.navPause(() => this.nextKeyframe()));

    const zr = $('zoom-range');
    zr.addEventListener('input', () => {
      const f = Math.exp((zr.value / 100) * Math.log(20000));
      this.timeline.setZoom(f);
    });
    $('btn-zoom-in').addEventListener('click', () => { zr.value = Math.min(100, +zr.value + 8); zr.dispatchEvent(new Event('input')); });
    $('btn-zoom-out').addEventListener('click', () => { zr.value = Math.max(0, +zr.value - 8); zr.dispatchEvent(new Event('input')); });

    // Keep keyboard shortcuts working: clicking a button must not trap focus.
    window.addEventListener('click', (e) => {
      if (e.target && e.target.tagName === 'BUTTON') e.target.blur();
    });
  },

  bindVideo() {
    this.video.addEventListener('loadedmetadata', () => {
      // The container's real duration may be longer than the parsed one
      // (under-reported mdhd, or a longer audio track). Make the timeline
      // match what actually plays.
      const vd = this.video.duration;
      if (this.state.source && Number.isFinite(vd) && vd > 0 && vd > this.state.duration + DUR_EXTEND_MARGIN) {
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
    });
    this.video.addEventListener('timeupdate', () => {
      if (!this.video.paused && !this.timeline.drag) this.guardPlayback();
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

  // High-frequency playback guard (rAF, ~16ms). Catches dimmed (gray) segments
  // almost immediately, so only a tiny, inaudible sliver of gray audio can leak.
  startPlaybackGuard() {
    if (this._pg) return;
    const tick = () => {
      if (!this.video.paused && !this.timeline.drag) this.guardPlayback();
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
        // Stop at the last kept frame (just before the cut-out tail).
        this.skipTo(Math.max(0, g.at - SEEK_EPS), true);
      } else {
        // Jump to the next kept start keyframe. Seeking to the exact keyframe
        // plays every sample of the kept segment; the boundary belongs to the
        // segment starting there.
        this.skipTo(g.at, false);
      }
      return;
    }
    // While playing the caret follows the video smoothly (not snapped).
    const t = this.video.currentTime;
    if (Math.abs(t - this.state.cursor) > CARET_UPDATE_MS) {
      this.state.cursor = t;
      this.timeline.cursor = t;
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.updateTimeDisplay();
      this.ensureCursorVisible();
    }
  },

  // Keep the playhead in frame: if the caret leaves the visible area (dead
  // zone 10%..90% of the view width), pan the timeline so it comes back.
  // Standard editor behavior - the timeline follows the playhead.
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

// Seek while playing without leaking the pre-seek (gray) audio: mute for the
// duration of the async seek, then restore the previous mute state. Robust to
// overlapping/rapid skips: the original mute state is captured once and always
// restored, so a second skipTo before 'seeked' cannot leave the video muted.
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

// If playback is on a dimmed (gray) frame, return where to go next:
// { type: 'seek', at } to jump over a mid gray run, or { type: 'pause', at }
// when everything to the end is cut out. Returns null when on a kept frame.
guardTarget(t) {
    const cuts = this.model.cuts;
    // Classify the time with a +EPS nudge: after an exact seek to a kept start
    // the browser may read back a hair below it, which must still be that kept
    // segment (never re-trigger the guard and skip the kept audio). But a point
    // genuinely inside the kept tail just before a gray boundary is still kept,
    // so the tail plays out fully.
    const i = this.model.segmentOf(t + SEEK_EPS); // boundary frames belong to the segment starting there
    if (i < this.model.deleted.length && this.model.deleted[i]) {
      // Only fire when t is really in the gray run, not merely nudged into it
      // (t is in the kept tail just before the gray boundary).
      if (t < cuts[i]) {
        const prev = this.model.segmentOf(t);
        if (prev < this.model.deleted.length && !this.model.deleted[prev]) return null;
      }
      let j = i;
      while (j < this.model.deleted.length && this.model.deleted[j]) j++;
      const end = cuts[j]; // first kept keyframe of the run we jump into
      if (end >= this.state.duration - SEEK_EPS) return { type: 'pause', at: cuts[i] };
      return { type: 'seek', at: end };
    }
    return null;
  },

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyO') { e.preventDefault(); this.openFile(); return; }
      if (mod && e.code === 'KeyS') { e.preventDefault(); this.saveProject(); return; }
      if (mod && e.code === 'KeyE') { e.preventDefault(); this.export(); return; }
      if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (mod && e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
      if (e.code === 'Space') { e.preventDefault(); this.cancelStepPause(); this.togglePlay(); return; }
      if (e.code === 'KeyC') { e.preventDefault(); this.cancelStepPause(); this.cut(); return; }
      if (e.code === 'KeyX' || e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); this.cancelStepPause(); this.deleteSegment(); return; }
      if (e.code === 'KeyR') { e.preventDefault(); this.cancelStepPause(); this.restoreSegment(); return; }
      if (e.code === 'KeyV') { e.preventDefault(); this.cancelStepPause(); this.mergeSelected(); return; }
      // Frame navigation: tap steps with a short pause; holding scans the
      // caret continuously and resumes on release (playback mode only).
      if (e.code === 'KeyS' || e.code === 'ArrowLeft') {
        e.preventDefault();
        if (!e.repeat) this.handleFrameNav(-1);
        return;
      }
      if (e.code === 'KeyF' || e.code === 'ArrowRight') {
        e.preventDefault();
        if (!e.repeat) this.handleFrameNav(+1);
        return;
      }
      if (e.code === 'Escape') { this.cancelStepPause(); this.pause(); }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyS' || e.code === 'KeyF' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        this.releaseFrameNav();
      }
    });
  },

  setStatus(text, spin = false) {
    $('status-text').textContent = text;
    $('spinner').classList.toggle('hidden', !spin);
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
    const s = this.model.stats();
    const keptPct = this.state.duration > 0 ? Math.round((s.kept / this.state.duration) * 100) : 0;
    $('stats').innerHTML =
      `<span>Cuts <b>${s.cuts}</b></span>` +
      `<span>Kept <b>${fmtTime(s.kept, false)}</b> / ${fmtTime(this.state.duration, false)} <b>(${keptPct}%)</b></span>`;
  },

  updateTimeDisplay() {
    $('time-current').textContent = fmtTime(this.state.cursor, true);
    $('time-total').textContent = fmtTime(this.state.duration, true);
    // live percentage of the material we're at, same / format as the clocks
    const d = this.state.duration;
    if (d > 0) $('time-pct').textContent = Math.round((Math.min(Math.max(0, this.state.cursor), d) / d) * 100) + '%';
    else $('time-pct').textContent = '';
  },

  applyVideoMeta(meta) {
    this.state.duration = meta.duration;
    this.state.width = meta.width;
    this.state.height = meta.height;
    this.state.fps = meta.fps;
    this.state.keyTimes = meta.keyTimes;
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
  },

  // Caret snap points: every cut boundary plus keyframes inside kept (blue)
  // segments. Interior keyframes of a dimmed (gray) area are NOT snap points -
  // the whole gray region behaves as one non-playable unit.
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
    if (this.timeline) this.timeline.activeKeys = arr;
  },

  // Audio scrubbing (Premiere-style): while dragging over the timeline, play a
  // short snippet of the keyframe right at the cursor. Only for kept segments.
  scrubBlip(t) {
    if (!this.state.source || this.video && !this.video.paused) return;
    if (this.frameDeleted(t)) return;
    if (Math.abs(t - this.lastScrubTime) < 1e-4) return;
    // Throttle rapid blips so dense keyframes / fast scrubbing don't cause a
    // storm of audio re-seeks; stays audibly coherent.
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
    $('video-placeholder').style.display = on ? 'none' : 'flex';
  },

  // One "Open" action: the dialog accepts both media and .kc projects, the
  // extension decides which loader handles it.
  async openFile() {
    const p = await window.keycut.openFile();
    if (!p) return;
    await this.openPath(p);
  },

  async openPath(p) {
    if (!this.confirmDiscardIfDirty()) return;
    if (/\.kc$/i.test(p)) await this.openProjectFromPath(p);
    else await this.loadSource(p);
  },

  // If the project has unsaved edits, ask the user what to do. Returns false
  // when the action should be aborted (Cancel). Save = save then continue,
  // discard = continue without saving, cancel = stop.
  async confirmDiscardIfDirty() {
    if (!this.state.dirty || !this.state.source) return true;
    const choice = await window.keycut.confirmClose();
    if (choice === 'save') {
      await this.saveProject();
      return !this.state.dirty; // save failed/cancelled -> abort
    }
    return choice === 'discard';
  },

  // The OS is closing the window: save/discard/cancel before it happens.
  async handleCloseRequest() {
    if (!this.state.dirty) { window.keycut.forceClose(); return; }
    const choice = await window.keycut.confirmClose();
    if (choice === 'save') {
      await this.saveProject();
      if (this.state.dirty) return; // save cancelled/failed -> stay open
      window.keycut.forceClose();
    } else if (choice === 'discard') {
      window.keycut.forceClose();
    }
    // 'cancel' -> stay
  },

  async loadSource(path) {
    this.setStatus('Analyzing…', true);
    const meta = await window.keycut.probeVideo(path);
    this.setStatus('Analyzing…', false);
    if (!meta || meta.error) {
      this.setStatus('Error: ' + (meta && meta.error ? meta.error : 'failed to analyze video'));
      return;
    }
    this.state.source = path;
    this.state.projectPath = null;
    this.cancelSkipMute();
    this.stopPlaybackGuard();
    this.cancelStepPause();
    this.model.clearHistory();
    this.model.reset(meta.duration);
    this.model.snapshot();
    this.video.src = toFileUrl(path);
    this.video.load();
    if (this.scrubAudio) { this.scrubAudio.src = toFileUrl(path); this.scrubAudio.load(); }
    this.state.dirty = false;
    this.$labelUpdate();
    this.applyVideoMeta(meta);
    this.setStatus('Loaded: ' + path);
  },

  $labelUpdate() {
    // The edited file name lives in the OS title bar, not in the page body.
    const label = this.state.source ? this.state.source.split(/[\\/]/).pop() : '';
    const star = this.state.dirty ? '* ' : '';
    document.title = star + (label ? 'KeyCut — ' + label : 'KeyCut');
  },

  // Any model mutation marks the project dirty (asterisk in the title) until
  // the project is saved.
  markDirty() {
    if (!this.state.dirty) {
      this.state.dirty = true;
      this.$labelUpdate();
    }
  },

  togglePlay() {
    if (!this.state.source) return;
    if (this.video.paused) {
      // Never auto-restart from the beginning; if the tail is cut out the
      // user simply stops (they can seek back manually).
      if (this.video.ended) return;
      // Start from the first kept (blue) frame at the caret - no flash of
      // cut-out content. Always seek the media element to the computed start,
      // even when state.cursor already equals it: after loading a project the
      // video's internal position can differ from the app cursor, and playing
      // without a seek would start from wherever the element happens to be.
      const start = this.firstKeptTime(this.state.cursor);
      if (start >= this.state.duration - SEEK_EPS) return;
      this.seek(start);
      this.video.play().catch(() => {});
    } else {
      this.video.pause();
    }
  },

// Earliest time >= t whose frame is in a kept (blue) segment. Skips the whole
// consecutive dimmed run and returns its first kept keyframe.
firstKeptTime(t) {
  if (!this.frameDeleted(t)) return t;
  let i = this.model.segmentOf(t);
  while (i < this.model.deleted.length && this.model.deleted[i]) i++;
  return this.model.cuts[i];
},

// Whether the frame at time t belongs to a dimmed (gray) segment. A frame
// sitting exactly on a cut boundary belongs to the segment that starts there.
frameDeleted(t) {
  const i = this.model.segmentOf(t);
  return !!this.model.deleted[i];
},

  pause() {
    if (!this.video.paused) this.video.pause();
  },

  // seek to time (called by timeline scrub, resize, cut). Does NOT auto-pan the
// timeline here: scrubbing places the caret under the cursor, and auto-panning
// during a drag would fight the mouse (feedback loop).
  seek(t) {
    this.state.cursor = t;
    if (this.video.readyState > 0) {
      this.video.currentTime = t;
    }
    this.updateTimeDisplay();
  },

  cut() {
    if (!this.state.source) return;
    // Even from a smooth caret, the cut lands on the nearest keyframe.
    const t = snapKey(this.state.cursor, this.state.activeKeys || this.state.keyTimes);
    const before = this.timeline.captureCornerTargets();
    if (this.model.split(t)) {
      this.refreshActiveKeys();
      this.timeline.applyCornerChange(before);
      this.state.cursor = t;
      this.timeline.cursor = t;
      this.timeline.needsRender = true;
      this.timeline.tick();
      this.seek(t);
      this.updateStats();
      this.setStatus('Cut at ' + fmtTime(t, true));
    }
  },

  // indices of the segments to act on: the (multi) selection, or the one under
  // the cursor
  activeIndices() {
    const s = this.timeline.selectionIndices();
    if (s.length) return s;
    return [this.model.segmentOf(this.state.cursor)];
  },

  // X / Delete: dim the selected segment(s) (keep them on the timeline).
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

  // R: restore dimmed segment(s).
  restoreSegment() {
    if (!this.state.source) return;
    const idx = this.activeIndices();
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

  // V: merge the selected adjacent blocks back into one whole block.
  // Works for kept (blue) and dimmed (gray) blocks alike.
  mergeSelected() {
    if (!this.state.source) return;
    const idx = this.activeIndices().sort((a, b) => a - b);
    let a = idx[0];
    let b = idx[idx.length - 1];
    // Single selection: merge with the next adjacent block (merging needs at
    // least two neighbours, and they must be the same type to join).
    if (a === b) b = a + 1;
    const before = this.timeline.captureCornerTargets();
    if (this.model.mergeRange(a, b)) {
      this.refreshActiveKeys();
      this.timeline.applyCornerChange(before);
      this.timeline.selected = [a, a];
      this.timeline.selectedAnchor = a;
      this.timeline.selectedSet = null;
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
    // drop any multi-selection indices that no longer exist after the edit
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
    let idx = binaryFirst(keys, t);
    if (idx < keys.length && keys[idx] >= t - 1e-6) idx--;
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

  // Pause playback before a transport/navigation jump (consistent with
  // scrub-stops-playback) and then run the action.
  navPause(fn) {
    if (this.video && !this.video.paused) this.pause();
    this.cancelStepPause();
    fn.call(this);
  },

  // Jump to the start of the next kept (blue) block after the caret.
  nextBlock() {
    const runs = this.model.keptRuns();
    const t = this.state.cursor;
    for (const [s] of runs) {
      if (s > t + 1e-6) { this.seekTo(s); return; }
    }
    this.setStatus('No next block');
  },

  // Jump to the start of the previous kept (blue) block before the caret.
  prevBlock() {
    const runs = this.model.keptRuns();
    const t = this.state.cursor;
    let best = null;
    for (const [s] of runs) {
      if (s < t - 1e-6) best = s; else break;
    }
    if (best != null) this.seekTo(best);
    else this.setStatus('No previous block');
  },

// Frame navigation with tap + hold support.
//   Tap (quick press+release) while playing: step one keyframe, pause
//   STEP_PAUSE_MS so the rewind is visible, then resume. Repeated taps restart
//   the pause.
//   Hold: the caret moves smoothly by TIME (not keyframes) while held; on
//   release playback resumes from the start of the keyframe the cursor is on
//   (only if we came from playback, not a manual pause).
handleFrameNav(dir) {
  const back = dir < 0;
  const wasPlaying = this.video && !this.video.paused;
  const inSession = this._stepPause;
  this.cancelStepPause();
  if (wasPlaying && back) this.pause();
  if (dir < 0) this.prevKeyframe(); else this.nextKeyframe();
  // brief audio blip so you can hear what piece comes next
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
  // keep a short audio preview playing while scanning
  this.scrubBlip(target);
  if (Math.abs(target - this._scan.lastSeek) > SCAN_SEEK_MS) {
    this._scan.lastSeek = target;
    this.seek(target);
    this.ensureCursorVisible();
  }
},

// Scan speed in seconds of video per second of holding, derived from the
// average keyframe spacing.
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
  this.scrubEnd(); // stop the scan blip audio
  if (scan.held) {
    // Long press: resume from the START of the keyframe the cursor is on
    // (even if the cursor is closer to the end of that keyframe's interval).
    if (scan.playing && this.state.source) {
      const keys = this.state.activeKeys || this.state.keyTimes;
      const kf = lastKeyAtOrBefore(this.state.cursor, keys);
      this.seekTo(kf);
      if (this.video.paused && !this.video.ended) this.togglePlay();
    }
  } else if (scan.playing && scan.back) {
    // Tap: small pause, then resume (restarts on repeated taps).
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
    const snapped = snapKey(t, this.state.activeKeys || this.state.keyTimes);
    this.state.cursor = snapped;
    this.timeline.cursor = snapped;
    this.timeline.needsRender = true;
    this.timeline.tick();
    this.seek(snapped);
    this.ensureCursorVisible();
  },

  async saveProject() {
    if (!this.state.source) { this.setStatus('Nothing to save'); return; }
    let filePath = this.state.projectPath;
    if (!filePath) {
      const base = this.state.source.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') + '.kc';
      filePath = await window.keycut.saveProjectDialog(base);
      if (!filePath) return;
    }
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
      zoom: this.timeline ? this.timeline.pxPerSec : 0
    };
    const res = await window.keycut.saveProject(filePath, data);
    if (res && res.ok) {
      this.state.projectPath = filePath;
      this.state.dirty = false;
      this.$labelUpdate();
      this.setStatus('Project saved: ' + filePath);
    } else {
      this.setStatus('Save failed: ' + (res && res.error));
    }
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
    if (!data.src) { this.setStatus('Load failed: missing <src>'); return; }

    this.setStatus('Analyzing source video…', true);
    const meta = await window.keycut.probeVideo(data.src);
    this.setStatus('', false);
    if (!meta || meta.error) {
      this.setStatus('Source video missing: ' + data.src + '. Please open the original video file.');
      return;
    }

    this.state.source = data.src;
    this.state.projectPath = filePath;
    const duration = (data.video && data.video.dur) || meta.duration;
    this.model.clearHistory();
    this.model.cuts = data.cuts;
    this.model.deleted = data.deleted;
    this.model.duration = duration;
    this.model.snapshot();
    this.cancelSkipMute();
    this.stopPlaybackGuard();
    this.cancelStepPause();

    this.video.src = toFileUrl(data.src);
    this.video.load();
    if (this.scrubAudio) { this.scrubAudio.src = toFileUrl(data.src); this.scrubAudio.load(); }
    this.state.dirty = false;
    this.$labelUpdate();

    this.applyVideoMeta({
      duration,
      width: (data.video && data.video.w) || meta.width,
      height: (data.video && data.video.h) || meta.height,
      fps: (data.video && data.video.fps) || meta.fps,
      keyTimes: data.keys && data.keys.length ? data.keys : meta.keyTimes
    });

    // Restore the saved view: zoom level and the keyframe we left the cursor
    // on. When the cursor sits mid-video, centre it; at the very start/end just
    // show the edge.
    const tl = this.timeline;
    if (data.zoom > 0) tl.pxPerSec = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, data.zoom));
    const c = Math.min(Math.max(0, data.cursor || 0), duration);
    this.seek(c);
    tl.cursor = c;
    const viewW = tl.w / tl.pxPerSec;
    if (c > 0.05 && c < duration - 0.05) {
      tl.viewStart = Math.max(0, Math.min(c - viewW / 2, duration - viewW));
    } else {
      tl.viewStart = 0;
    }
    tl.clampView();
    tl.needsRender = true;
    tl.tick();
    this.updateStats();
    this.setStatus('Project loaded: ' + filePath);
  },

  async export() {
    if (this.state.exporting) return;
    const runs = this.model.keptRuns();
    if (!runs.length) { this.setStatus('Nothing to export - all segments are deleted'); return; }

    const base = this.state.source.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') + '.mp4';
    const outPath = await window.keycut.saveExportDialog(base);
    if (!outPath) return;

    this.state.exporting = true;
    $('btn-export').disabled = true;
    if (this.video && !this.video.paused) this.pause();
    this.setStatus('Exporting…', true);
    this.setProgress(0);
    $('export-modal').classList.remove('hidden');
    $('export-modal-status').textContent = 'Preparing…';

    const setModalStatus = (s) => { $('export-modal-status').textContent = s; };
    const unsub = window.keycut.onExportProgress((p) => {
      if (p.phase === 'cut') {
        this.setProgress(p.total > 0 ? p.index / p.total : 0);
        this.setStatus(`Exporting… cutting ${p.index}/${p.total}`);
        setModalStatus(`Cutting ${p.index}/${p.total}`);
      } else if (p.phase === 'concat') {
        this.setProgress(EXPORT_CONCAT_PROGRESS);
        this.setStatus('Exporting… muxing');
        setModalStatus('Muxing…');
      } else if (p.phase === 'error') {
        this.setStatus('Export failed: ' + p.message);
        this.setProgress(null);
        setModalStatus('Error: ' + p.message);
      }
    });

    const res = await window.keycut.exportStart({
      sourcePath: this.state.source,
      segments: runs,
      outputPath: outPath
    });

    unsub();
    this.state.exporting = false;
    $('btn-export').disabled = false;
    this.setProgress(null);
    this.setStatus('', false);
    $('export-modal').classList.add('hidden');

    if (res && res.ok) {
      this.setStatus('Export complete: ' + outPath);
    } else {
      this.setStatus('Export failed: ' + (res && res.error ? res.error : 'unknown error'));
    }
  }
};

document.addEventListener('DOMContentLoaded', () => app.init());
window.__app = app;
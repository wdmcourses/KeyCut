const PREVIEW_HEIGHT = 800;
const PREVIEW_FPS = 30;
const BUFFER_AHEAD = 10;
const BUFFER_MAX = 60;
const STALL_MS = 2500;
const RESTART_DEBOUNCE_MS = 500;

function normPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

class CompatPlayer {
  constructor(app) {
    this.app = app;
    this.master = null;
    this.src = null;
    this.active = false;
    this.compatSources = new Set();
    this.dummyPaths = new Map();
    this.overlay = null;
    this.slave = null;
    this.canvas = null;
    this.spinner = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.objectUrl = null;
    this.bufferStart = 0;
    this.bufferEnd = null;
    this.reading = false;
    this.stopping = false;
    this.throttle = false;
    this.fps = 30;
    this.prevMuted = false;
    this._weMuted = false;
    this.masterIsDummy = true;
    this._pendingResume = false;
    this._gen = 0;
    this._syncTimer = null;
    this._watchTimer = null;
    this._restartTimer = null;
    this._dummyUnsub = null;
    this._frozenAt = 0;
    this._watchLast = -1;
    this._dummyResolve = null;
    this._fallbackPending = false;
    this._dummyPreparing = false;
  }

  attach() {
    this.master = this.app.video;
    this.fps = this.app.state && this.app.state.fps ? this.app.state.fps : 30;
    this._dummyUnsub = window.keycut.onCompatDummyProgress(({ progress }) => {
      if (this._dummyPreparing && progress != null && progress >= 0) {
        this.app.setStatus('Preparing... ' + Math.round(progress * 100) + '%', true);
        this.app.setProgress(progress);
      }
    });
  }

  norm(src) { return normPath(src); }

  hasCompat(src) {
    return !!src && this.compatSources.has(this.norm(src));
  }

  flagSource(src) {
    if (src) this.compatSources.add(this.norm(src));
  }

  showCompatMode(on) {
    const el = document.getElementById('compat-mode');
    if (el) el.classList.toggle('hidden', !on);
  }

  async _ensureDummy(src, duration) {
    const key = this.norm(src);
    this._dummyPreparing = true;
    this.app.setStatus('Preparing... 0%', true);
    this.app.setProgress(0);
    try {
      const res = await window.keycut.compatEnsureDummy({ src, duration });
      if (res && res.ok && res.dummyPath) {
        this.dummyPaths.set(key, res.dummyPath);
        return res.dummyPath;
      }
      return null;
    } finally {
      this._dummyPreparing = false;
      this.app.setProgress(null);
      this.app.setStatus('', false);
    }
  }

  async forgetAll() {
    this.stop();
    const paths = new Set(this.dummyPaths.values());
    this.dummyPaths.clear();
    this.compatSources.clear();
    for (const p of paths) {
      try { await window.keycut.compatDeleteDummy(p); } catch {}
    }
  }

  _muteMaster() {
    if (!this.master) return;
    if (!this._weMuted) {
      this._weMuted = true;
      this.prevMuted = this.master.muted;
    }
    this.master.muted = true;
  }

  async _switchMasterToDummy(dummyPath) {
    if (!this.master || !dummyPath) return false;
    this.masterIsDummy = true;
    this._muteMaster();
    const cur = this.app.state.cursor || 0;
    const ready = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      this.master.addEventListener('loadedmetadata', () => {
        try { this.master.currentTime = Math.min(Math.max(0, cur), this.master.duration || cur); } catch {}
        finish();
      }, { once: true });
      setTimeout(finish, 5000);
    });
    this.master.src = toFileUrl(dummyPath);
    this.master.load();
    if (this.app.scrubAudio && this.app.scrubAudio.src) {
      this.app.scrubAudio.pause();
    }
    await ready;
    return true;
  }

  _ensureOverlay() {
    if (this.overlay) return;
    const wrap = document.getElementById('video-wrap');
    if (!wrap) return;
    this.overlay = document.createElement('div');
    this.overlay.className = 'compat-overlay';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'compat-canvas';
    this.slave = document.createElement('video');
    this.slave.className = 'compat-slave';
    this.slave.playsInline = true;
    this.slave.muted = false;
    this.slave.autoplay = false;
    this.spinner = document.createElement('div');
    this.spinner.className = 'compat-spinner';
    this.spinner.textContent = 'Preparing playback…';
    this.overlay.appendChild(this.slave);
    this.overlay.appendChild(this.canvas);
    this.overlay.appendChild(this.spinner);
    wrap.appendChild(this.overlay);
    this.showSpinner(true);
  }

  _removeOverlay() {
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    this.slave = null;
    this.canvas = null;
    this.spinner = null;
  }

  showSpinner(on) {
    if (this.spinner) this.spinner.style.display = on ? 'flex' : 'none';
  }

  async afterSource(src, duration) {
    if (!src) return;
    const gen = ++this._gen;
    this.src = src;
    if (!this.hasCompat(src)) {
      this.stop();
      return;
    }
    this.showCompatMode(true);
    this._ensureOverlay();
    this.masterIsDummy = true;
    if (this._masterCanShowReal()) {
      this.masterIsDummy = false;
      this._muteMaster();
      if (this.app.scrubAudio && this.app.scrubAudio.src) {
        this.app.scrubAudio.pause();
      }
      this._showOverlay(true);
    } else {
      const dummyPath = await this._ensureDummy(src, duration);
      if (gen !== this._gen || this.stopping) return;
      if (!dummyPath) {
        this.stop();
        this.app.setStatus('Preparing playback failed');
        return;
      }
      if (!(await this._switchMasterToDummy(dummyPath))) {
        this.stop();
        return;
      }
    }
    this.fps = this.app.state.fps || 30;
    await this.startStream(this.app.state.cursor || 0);
    if (this._pendingResume) {
      this._pendingResume = false;
      const p = this.master.play();
      if (p) p.catch(() => {});
    }
  }

  _masterCanShowReal() {
    const m = this.master;
    return !!(m && !m.error && m.videoWidth > 0 && m.duration > 0);
  }

  _showOverlay(show) {
    if (this.overlay) this.overlay.style.visibility = show ? '' : 'hidden';
  }

  _hasAudio() {
    const streams = (this.app.state && this.app.state.streams) || [];
    if (!streams.length) return true;
    return streams.some((s) => s && s.codec_type === 'audio');
  }

  _mimeCodec() {
    const codecs = ['avc1.42C01F'];
    if (this._hasAudio()) codecs.push('mp4a.40.2');
    return 'video/mp4; codecs="' + codecs.join(', ') + '"';
  }

  async startStream(seekTo) {
    if (!this.master || !this.slave || !this.src) return;
    this.active = true;
    if (!this._syncTimer) this._syncTimer = setInterval(() => this._sync(), 30);
    this._teardownStream();
    const mime = this._mimeCodec();
    if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) {
      this._stopStreaming('MediaSource unsupported');
      return;
    }
    const started = await window.keycut.compatStart({
      path: this.src,
      seekTo,
      videoIndex: 0,
      audioIndex: this._hasAudio() ? 0 : null,
      size: PREVIEW_HEIGHT,
      fps: PREVIEW_FPS
    });
    if (!started || !started.ok || this.stopping) {
      if (!this.stopping) this._stopStreaming(started && started.error ? started.error : 'start failed');
      return;
    }
    const firstChunk = started.chunk || null;
    if (firstChunk == null) {
      const err = await window.keycut.compatStderr();
      this._stopStreaming(err ? err.slice(-200) : 'ffmpeg produced no data');
      return;
    }
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.slave.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', async () => {
      if (this.stopping) return;
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      } catch (err) {
        const mime2 = 'video/mp4; codecs="avc1.42C01F"';
        if (MediaSource.isTypeSupported(mime2)) this.sourceBuffer = this.mediaSource.addSourceBuffer(mime2);
        else { this._stopStreaming('MediaSource codec unsupported'); return; }
      }
      this.bufferStart = seekTo;
      this.bufferEnd = null;
      this.throttle = false;
      try {
        this.sourceBuffer.timestampOffset = seekTo - 1 / Math.max(1, this.fps || 30);
      } catch {}
      try { this.sourceBuffer.appendBuffer(firstChunk); } catch (err) {}
      await this._waitIdle();
      await this._afterAppend();
      this._unfreeze();
      this._readLoop();
    }, { once: true });
  }

  _teardownStream() {
    if (this.objectUrl) { try { URL.revokeObjectURL(this.objectUrl); } catch {} this.objectUrl = null; }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.bufferEnd = null;
  }

  _stopStreaming(reason) {
    this._teardownStream();
    if (this.slave) this.slave.removeAttribute('src');
    this._unfreeze();
    if (reason) this.app.setStatus('Compatibility playback unavailable: ' + reason);
  }

  async _readLoop() {
    if (this.reading) return;
    this.reading = true;
    let gotChunk = true;
    try {
      while (this.active && !this.stopping && this.sourceBuffer) {
        if (this.throttle) {
          this.throttle = false;
          await new Promise((r) => setTimeout(r, 1000));
          if (!this.active || this.stopping || !this.sourceBuffer) break;
        }
        const chunk = await window.keycut.compatChunk();
        if (chunk == null) {
          if (!gotChunk) {
            const err = await window.keycut.compatStderr();
            this._stopStreaming(err ? err.slice(-200) : 'ffmpeg produced no data');
          } else {
            try {
              if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
            } catch {}
          }
          break;
        }
        gotChunk = true;
        if (!this.active || this.stopping || !this.sourceBuffer) break;
        try { this.sourceBuffer.appendBuffer(chunk); } catch (err) {}
        await this._waitIdle();
        await this._afterAppend();
        await this._waitIdle();
      }
    } finally {
      this.reading = false;
    }
  }

  _waitIdle() {
    return new Promise((resolve) => {
      const sb = this.sourceBuffer;
      if (!sb || !sb.updating) return resolve();
      const done = () => { sb.removeEventListener('updateend', done); resolve(); };
      sb.addEventListener('updateend', done);
    });
  }

  async _afterAppend() {
    const sb = this.sourceBuffer;
    const m = this.master;
    if (!sb || !m) return;
    let end = null;
    try {
      if (sb.buffered.length) end = sb.buffered.end(sb.buffered.length - 1);
    } catch {}
    if (end == null) return;
    this.bufferEnd = end;
    if (end - this.bufferStart > BUFFER_MAX) {
      const removeTo = end - BUFFER_MAX;
      try {
        if (!sb.updating) {
          sb.remove(0, removeTo);
          await this._waitIdle();
          this.bufferStart = removeTo;
        }
      } catch {}
    }
    if (end - m.currentTime > BUFFER_AHEAD) this.throttle = true;
  }

  _sync() {
    const m = this.master;
    const s = this.slave;
    if (!m || !s || !this.active || this.stopping) return;
    const mt = m.currentTime;
    if (m.paused || m.ended) {
      if (!s.paused) { try { s.pause(); } catch {} }
      if (Math.round(s.currentTime * 1000) !== Math.round(mt * 1000)) { try { s.currentTime = mt; } catch {} }
      if (!this.masterIsDummy) this._showOverlay(false);
    } else {
      this._showOverlay(true);
      if (s.paused) { const p = s.play(); if (p) p.catch(() => {}); }
      const diff = mt - s.currentTime;
      if (Math.abs(diff) > 1) { try { s.currentTime = mt; } catch {} this._setRate(1.05); }
      else if (diff != null && diff > 0.3) this._setRate(1.5);
      else this._setRate(1.05);
    }
    if (s.volume !== m.volume) { try { s.volume = m.volume; } catch {} }
    if (this.sourceBuffer) {
      if (mt < this.bufferStart - 0.2 || (this.bufferEnd != null && mt > this.bufferEnd + 5)) {
        this._scheduleRestart(mt);
      }
    }
  }

  _setRate(r) {
    const s = this.slave;
    if (s && s.playbackRate !== r) { try { s.playbackRate = r; } catch {} }
  }

  _scheduleRestart(t) {
    if (this._restartTimer) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.restart(t);
    }, RESTART_DEBOUNCE_MS);
  }

  _freezeFrame() {
    const s = this.slave;
    const c = this.canvas;
    if (s && c) {
      try {
        if (s.readyState >= 2 && s.videoWidth > 0 && s.videoHeight > 0) {
          c.width = s.videoWidth;
          c.height = s.videoHeight;
          c.getContext('2d').drawImage(s, 0, 0, c.width, c.height);
          c.style.display = 'block';
          s.style.visibility = 'hidden';
        } else {
          c.style.display = 'none';
          c.getContext('2d').clearRect(0, 0, c.width, c.height);
        }
      } catch {}
    }
    this.showSpinner(true);
  }

  _unfreeze() {
    if (this.canvas) {
      this.canvas.style.display = 'none';
      try { this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height); } catch {}
    }
    if (this.slave) this.slave.style.visibility = 'visible';
    this.showSpinner(false);
  }

  async restart(t) {
    if (!this.active || this.stopping) return;
    this._freezeFrame();
    await window.keycut.compatStop();
    if (this.stopping) return;
    this._teardownStream();
    await this.startStream(Math.max(0, t));
  }

  startWatch() {
    this._watchLast = -1;
    this._frozenAt = 0;
    if (this._watchTimer) clearInterval(this._watchTimer);
    this._watchTimer = setInterval(() => this._watchTick(), 500);
    if (this._syncTimer) clearInterval(this._syncTimer);
    this._syncTimer = setInterval(() => this._sync(), 30);
  }

  _watchTick() {
    const m = this.master;
    if (!m || this.stopping) return;
    const src = this.app.state.source;
    if (!src) return;
    if (this.active) {
      if (!this.masterIsDummy && !m.paused && !m.ended && !m.seeking) {
        if (m.currentTime === this._watchLast) {
          if (!this._frozenAt) this._frozenAt = Date.now();
          else if (Date.now() - this._frozenAt > STALL_MS) {
            this._frozenAt = 0;
            this._fallbackToDummy(src);
          }
        } else {
          this._frozenAt = 0;
        }
      }
      this._watchLast = m.currentTime;
      return;
    }
    if (this.hasCompat(src)) return;
    if (m.paused || m.ended || m.seeking) { this._frozenAt = 0; this._watchLast = m.currentTime; return; }
    if (m.error) { this.activateFor(src); return; }
    if (m.currentTime === this._watchLast) {
      if (!this._frozenAt) this._frozenAt = Date.now();
      else if (Date.now() - this._frozenAt > STALL_MS) {
        this._pendingResume = true;
        this.activateFor(src);
      }
    } else {
      this._watchLast = m.currentTime;
      this._frozenAt = 0;
    }
  }

  async _fallbackToDummy(src) {
    if (this._fallbackPending) return;
    this._fallbackPending = true;
    try {
      const gen = this._gen;
      const dummyPath = await this._ensureDummy(src, this.app.state.duration);
      if (gen !== this._gen || this.stopping) return;
      if (!dummyPath) return;
      if (!(await this._switchMasterToDummy(dummyPath))) return;
      this.restart(this.app.state.cursor || 0);
    } finally {
      this._fallbackPending = false;
    }
  }

  activateFor(src) {
    if (!src || this.active || this.hasCompat(src)) return;
    this.flagSource(src);
    this.afterSource(src, this.app.state.duration);
  }

  onNativeError() {
    const src = this.app.state.source;
    if (!src) return;
    if (this.active) {
      this._recover(src);
      return;
    }
    this._pendingResume = true;
    this.activateFor(src);
  }

  async _recover(src) {
    const gen = ++this._gen;
    const dummyPath = await this._ensureDummy(src, this.app.state.duration);
    if (gen !== this._gen || this.stopping) return;
    if (!dummyPath) return;
    this._switchMasterToDummy(dummyPath);
    this.restart(this.app.state.cursor || 0);
  }

  stop() {
    this.stopping = true;
    this._gen++;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
    this._teardownStream();
    if (this.slave) this.slave.removeAttribute('src');
    this._removeOverlay();
    window.keycut.compatStop();
    if (this._weMuted && this.master) {
      this.master.muted = this.prevMuted;
      this._weMuted = false;
    }
    this.active = false;
    this.stopping = false;
    this.src = null;
    this.masterIsDummy = true;
    this._fallbackPending = false;
    this._dummyPreparing = false;
    this._pendingResume = false;
    this.showCompatMode(false);
    this._frozenAt = 0;
    this._watchLast = -1;
  }
}

window.CompatPlayer = CompatPlayer;
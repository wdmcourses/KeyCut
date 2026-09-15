window.FileList = class FileList {
  constructor(opts) {
    this.el = opts.listEl;
    this.getItemName = opts.getItemName || ((item) => String(item.name || ''));
    this.getItemExt = opts.getItemExt || ((item) => { const n = String(item.name || ''); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1) : ''; });
    this.getItemPath = opts.getItemPath || ((item) => item.path || '');
    this.isActive = opts.isActive || (() => false);
    this.isMissing = opts.isMissing || (() => false);
    this.onRemove = opts.onRemove || (() => {});
    this.onReorder = opts.onReorder || (() => {});
    this.onClick = opts.onClick || (() => {});
    this.onRename = opts.onRename || (() => {});
    this.onLocate = opts.onLocate || (() => {});
    this.onDropFiles = opts.onDropFiles || (() => {});
    this.busy = opts.busy || (() => false);
    this.allowRename = opts.allowRename !== false;
    this.dragIndex = null;
    this.dropIndex = null;
    this.dropBefore = false;
    this.dragDir = null;
    this.dragLastY = null;
    this.emptyEl = null;
    this._renaming = null;
  }

  setItems(items) {
    this.items = items || [];
    this.render();
  }

  render() {
    const list = this.el;
    list.innerHTML = '';
    if (!this.items || !this.items.length) {
      const empty = document.createElement('div');
      empty.className = 'fl-empty';
      empty.textContent = 'No timelines. Click or drop to add.';
      empty.addEventListener('click', () => this.onClick(null));
      empty.addEventListener('dragover', (e) => { e.preventDefault(); empty.classList.add('drag-over'); });
      empty.addEventListener('dragleave', () => empty.classList.remove('drag-over'));
      empty.addEventListener('drop', (e) => this.handleFileDrop(e, empty));
      list.appendChild(empty);
      this.emptyEl = empty;
      return;
    } 
    const listLeave = (e) => {
      if (e.relatedTarget && list.contains(e.relatedTarget)) return;
      this.clearDropHints();
    };
    this.items.forEach((item, i) => {
      const row = document.createElement('div');
      const missing = this.isMissing(item);
      row.className = 'fl-item' + (this.isActive(item) ? ' active' : '') + (missing ? ' missing' : '');
      row.dataset.index = i;
      const name = this.getItemName(item);
      const ext = this.getItemExt(item);
      const title = this.getItemPath(item) || name;
      row.innerHTML =
        '<span class="fl-drag" title="Drag to reorder"><span class="fl-idx">' + (i + 1) + '</span><span class="fl-handle">⠿</span></span>' +
        '<span class="fl-name" title="' + title.replace(/"/g, '&quot;') + '"></span>' +
        '<span class="fl-actions">' +
        (ext ? '<span class="fl-badge" title="' + ext + '">' + ext + '</span>' : '') +
        (this.allowRename ? '<button class="btn btn--xs fl-rename' + (missing ? ' disabled' : '') + '" title="Rename"' + (missing ? ' disabled' : '') + '><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 21h8"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg></button>' : '') +
        '<button class="btn btn--xs btn--danger fl-del" title="Remove">✕</button>' +
        '</span>' +
        (missing ? '<button class="btn btn--xs btn--accent fl-locate" title="Browse for the file">Browse</button>' : '');
      row.querySelector('.fl-name').textContent = name;
      if (missing) {
        row.querySelector('.fl-locate').addEventListener('click', (e) => { e.stopPropagation(); if (this.busy()) return; this.onLocate(item); });
      }

      const drag = row.querySelector('.fl-drag');
      drag.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.beginReorder(i, e, false);
      });
      const nameEl = row.querySelector('.fl-name');
      nameEl.addEventListener('mousedown', (e) => {
        this.beginReorder(i, e, true);
      });
      row.addEventListener('click', (e) => {
        if (this._suppressClickUntil && Date.now() < this._suppressClickUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
      row.addEventListener('dragover', (e) => {
        if (this.busy()) return;
        if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
      });
      row.addEventListener('drop', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
          this.handleFileDrop(e, row);
          return;
        }
        e.preventDefault();
      });
      row.querySelector('.fl-name').addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.busy()) return;
        if (this._renaming === item) return;
        this.onClick(item);
      });
      row.querySelector('.fl-del').addEventListener('click', (e) => { e.stopPropagation(); if (this.busy()) return; this.onRemove(item); });
      if (this.allowRename) {
        row.querySelector('.fl-rename').addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.busy() || missing) return;
          this.startRename(row, item, name);
        });
      }
      list.appendChild(row);
    });
    list.addEventListener('dragleave', listLeave);
  }

startRename(row, item, currentName) {
    this._renaming = item;
    const nameEl = row.querySelector('.fl-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fl-rename-input';
    input.value = currentName;
    input.spellcheck = false;
    input.maxLength = 120;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const done = (keep) => {
      if (finished) return;
      finished = true;
      this._renaming = null;
      const val = input.value.trim();
      const text = keep ? currentName : (val || currentName);
      const next = document.createElement('span');
      next.className = 'fl-name';
      next.textContent = text;
      next.title = this.getItemPath(item) || text;
      next.addEventListener('click', (e) => { e.stopPropagation(); this.onClick(item); });
      input.replaceWith(next);
      if (!keep && val && val !== currentName) this.onRename(item, val);
    };
    input.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') { e.preventDefault(); done(false); }
      else if (e.code === 'Escape') { e.preventDefault(); done(true); }
    });
    input.addEventListener('blur', () => done(false));
  }

  beginReorder(i, e, fromName) {
    if (this.busy()) return;
    if (e.button !== 0) return;
    const rows = this.el.querySelectorAll('.fl-item');
    const row = rows[i];
    if (!row) return;
    this.dragIndex = i;
    this.dragDir = null;
    this.dragLastY = e.clientY;
    this._reorder = { index: i, row, fromName, active: !fromName, moved: false, startX: e.clientX, startY: e.clientY };
    if (!fromName) {
      e.preventDefault();
      row.classList.add('dragging');
      document.body.classList.add('reorder-dragging');
      this._reorder.active = true;
    }
    window.addEventListener('mousemove', this._reorderMove);
    window.addEventListener('mouseup', this._reorderUp);
  }

  _reorderMove = (e) => {
    const r = this._reorder;
    if (!r) return;
    if (!r.active) {
      if (Math.abs(e.clientX - r.startX) <= 3 && Math.abs(e.clientY - r.startY) <= 3) return;
      r.active = true;
      r.moved = true;
      r.row.classList.add('dragging');
      document.body.classList.add('reorder-dragging');
      this._suppressClickUntil = Date.now() + 600;
    }
    const rows = this.el.querySelectorAll('.fl-item');
    let target = null;
    let before = false;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        target = i;
        before = (e.clientY - rect.top) < rect.height / 2;
        break;
      }
    }
    if (target == null && rows.length) {
      const first = rows[0].getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      if (e.clientY < first.top) { target = 0; before = true; }
      else if (e.clientY > last.bottom) { target = rows.length - 1; before = false; }
    }
    this.dragDir = target != null && target !== this.dragIndex ? (before ? -1 : 1) : null;
    this.setDropHint(target, before);
    this.dragScroll(e);
  }

  _reorderUp = (e) => {
    window.removeEventListener('mousemove', this._reorderMove);
    window.removeEventListener('mouseup', this._reorderUp);
    const r = this._reorder;
    this._reorder = null;
    if (!r) return;
    r.row.classList.remove('dragging');
    document.body.classList.remove('reorder-dragging');
    const from = this.dragIndex;
    const to = this.dropIndex;
    const before = this.dropBefore;
    this.clearDropHints();
    this.dragIndex = null;
    this.dragDir = null;
    this.dragLastY = null;
    if (!r.active || from == null || to == null || to === from) return;
    let target = before ? to : to + 1;
    if (from < target) target--;
    if (target !== from) this.onReorder(from, target);
  }

  handleFileDrop(e, target) {
    e.preventDefault();
    e.stopPropagation();
    if (document.body.classList.contains('drag-over')) document.body.classList.remove('drag-over');
    const cm = document.querySelector('#concat-modal');
    if (cm) cm.classList.remove('drag-over');
    if (this.busy()) return;
    target.classList.remove('drag-over');
    const paths = [];
    for (const f of (e.dataTransfer ? e.dataTransfer.files : [])) {
      const p = window.keycut.getFilePath ? window.keycut.getFilePath(f) : null;
      if (p) paths.push(p);
    }
    if (paths.length) this.onDropFiles(paths);
  }

  setDropHint(index, before) {
    this.dropIndex = index;
    this.dropBefore = before;
    const rows = this.el.querySelectorAll('.fl-item');
    rows.forEach((r, i) => {
      r.classList.remove('drop-before', 'drop-after');
      if (i === index && i !== this.dragIndex) r.classList.add(before ? 'drop-before' : 'drop-after');
    });
  }

  clearDropHints() {
    this.dropIndex = null;
    this.dropBefore = false;
    this.el.querySelectorAll('.fl-item').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  }

  dragScroll(e) {
    const rect = this.el.getBoundingClientRect();
    const zone = 36;
    if (e.clientY < rect.top + zone) {
      this.el.scrollTop -= 24;
    } else if (e.clientY > rect.bottom - zone) {
      this.el.scrollTop += 24;
    }
  }

  scrollToItem(item) {
    if (!item) return;
    const rows = this.el.querySelectorAll('.fl-item');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (this.isActive(item) && this.items[i] === item) {
        const wrap = this.el;
        const wr = wrap.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        const top = rr.top - wr.top;
        const bottom = rr.bottom - wr.top;
        const vis = wr.height;
        const want = (vis - rr.height) / 2;
        let target;
        if (rr.height >= vis) target = top;
        else if (top < want) target = 0;
        else if (bottom > vis - want) target = wrap.scrollHeight - vis;
        else return;
        wrap.scrollTop = Math.max(0, Math.min(target, wrap.scrollHeight - vis));
        return;
      }
    }
  }
};
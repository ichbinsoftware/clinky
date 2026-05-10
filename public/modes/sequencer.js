import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, relGlyph } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey } from '/synth.js';

const STEPS = 16;
const BPM = 100;
const stepMs = (60000 / BPM) / 2;
const LEFT_GUTTER = 44;
const G_MINOR = [196.00, 233.08, 261.63, 293.66, 349.23, 392.00, 466.16, 523.25, 587.33, 698.46];
const NOTE_NAMES = ['G3', 'Bb3', 'C4', 'D4', 'F4', 'G4', 'Bb4', 'C5', 'D5', 'F5'];

class SequencerMode extends Mode {
  grid = [];
  playhead = 0;
  lastStepTime = 0;
  flashCells = [];
  primePhase = false;
  ghostPattern = null;
  ghostSpawnDelay = 0;

  constructor() {
    super({
      mode: 'sequencer',
      aesthetic: 'industrial',
      topicFallbackColor: '#ff006e',
      vars: {
        '--e-bg': '#0a0a0a', '--e-text': '#e8e8e8',
        '--e-text-mute': 'rgba(232,232,232,0.7)', '--e-text-faint': 'rgba(232,232,232,0.45)',
        '--e-rule': 'rgba(232,232,232,0.12)',
        '--e-narration': '#ffdb28', '--e-pivot-tint': 'rgba(255,219,40,0.06)', '--e-accent': '#00e1da',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('click', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (this.grid.length === 0) return;
      const cellW = (this.W - LEFT_GUTTER) / STEPS, padTop = 30;
      const cellH = (this.H - padTop - 30) / this.grid.length;
      const col = Math.floor((mx - LEFT_GUTTER) / cellW), row = Math.floor((my - padTop) / cellH);
      if (row >= 0 && row < this.grid.length && col >= 0 && col < STEPS) {
        if (this.grid[row][col]) { this.grid[row][col] = null; }
        else {
          this.grid[row][col] = { topic: this.topics[row]?.id || '', type: 'claim', text: 'manual note', confidence: 0.7 };
          this.initAural();
          this.fmBassStab(this.rowCutoff(row, this.grid.length), 0.18, 0.10);
        }
      }
    });
    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const cellW = (this.W - LEFT_GUTTER) / STEPS, padTop = 30;
      const cellH = this.grid.length > 0 ? (this.H - padTop - 30) / this.grid.length : 1;
      const col = Math.floor((mx - LEFT_GUTTER) / cellW), row = Math.floor((my - padTop) / cellH);
      if (row >= 0 && row < this.grid.length && col >= 0 && col < STEPS && this.grid[row][col]) {
        showTooltip(e, this.grid[row][col], this.topicInfo(this.topics[row]?.id).color); this.app.highlightLegendTopic(this.grid[row][col].topic);
      } else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
  }

  count() { return this.grid.reduce((s, r) => s + r.filter(Boolean).length, 0); }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    let count = 0;
    for (const row of this.grid) for (const cell of row) { if (cell && Array.isArray(cell.refs) && cell.refs.includes(id)) count++; }
    return count;
  }

  hasExternalBecause(n) { const b = n && n.because; return Array.isArray(b) && b.some(x => typeof x === 'string'); }

  rowNote(idx) { return G_MINOR[idx % G_MINOR.length]; }
  rowNoteName(idx) { return NOTE_NAMES[idx % NOTE_NAMES.length]; }
  rowCutoff(rowIdx, totalRows) { const t = totalRows <= 1 ? 0.5 : rowIdx / (totalRows - 1); return 280 + t * (1400 - 280); }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('industrial');
      pickSessionKey(this.app.prompt() || 'sequencer');
    });
  }

  fmBassStab(cutoffHz, dur = 0.18, vol = 0.13) {
    playSynth({ midi: 33, wave: 'sawtooth', voices: 4, detune: 35, attack: 0.001, decay: 0.05, sustain: 0.7, release: 0.15, duration: dur, vol, filter: { type: 'lowpass', freq: cutoffHz, Q: 8 }, distortion: { drive: 0.4, tone: 'crunch', mix: 0.55 }, reverbSend: 0.15, delaySend: 0.20 });
  }

  crushedKick(vol = 0.20) {
    playSynth({ freq: 55, wave: 'sawtooth', voices: 2, detune: 12, attack: 0.001, decay: 0.09, sustain: 0.0, release: 0.05, duration: 0.06, vol, filter: { type: 'lowpass', freq: 240, Q: 4 }, distortion: { drive: 0.65, tone: 'crunch', mix: 0.75 }, reverbSend: 0.10, delaySend: 0.05 });
  }

  ensureRows() { while (this.grid.length < this.topics.length) this.grid.push(new Array(STEPS).fill(null)); }

  addNote(node) {
    const topicIdx = this.topics.findIndex(t => t.id === node.topic);
    if (topicIdx < 0) return;
    if (!this.grid[topicIdx]) this.grid[topicIdx] = new Array(STEPS).fill(null);
    const empty = [];
    for (let s = 0; s < STEPS; s++) if (!this.grid[topicIdx][s]) empty.push(s);
    if (empty.length === 0) return;
    const step = empty[Math.floor(Math.random() * empty.length)];
    this.grid[topicIdx][step] = node;
  }

  spawnGhostPattern() {
    const count = 3 + Math.floor(Math.random() * 3);
    const cells = [], used = new Set();
    for (let i = 0; i < count; i++) {
      let c; do { c = Math.floor(Math.random() * STEPS); } while (used.has(c));
      used.add(c); cells.push({ col: c, note: G_MINOR[Math.floor(Math.random() * G_MINOR.length)] });
    }
    this.ghostPattern = { cells, age: 0, maxAge: 360, alpha: 0, targetAlpha: 1 };
  }

  startPrime() { this.primePhase = true; this.ghostPattern = null; this.ghostSpawnDelay = 30; }
  stopPrime() { this.primePhase = false; if (this.ghostPattern) this.ghostPattern.targetAlpha = 0; }

  simulatePrime() {
    if (this.primePhase) {
      if (!this.ghostPattern) { this.ghostSpawnDelay--; if (this.ghostSpawnDelay <= 0) this.spawnGhostPattern(); }
      else { this.ghostPattern.age++; if (this.ghostPattern.age > this.ghostPattern.maxAge) this.ghostPattern.targetAlpha = 0; }
    }
    if (this.ghostPattern) {
      this.ghostPattern.alpha += (this.ghostPattern.targetAlpha - this.ghostPattern.alpha) * 0.08;
      if (this.ghostPattern.targetAlpha === 0 && this.ghostPattern.alpha < 0.02) {
        this.ghostPattern = null; this.ghostSpawnDelay = 60 + Math.random() * 240;
      }
    }
  }

  triggerGhostStepAudio() {
    if (!this.ghostPattern || this.ghostPattern.alpha < 0.05) return;
    const cell = this.ghostPattern.cells.find(c => c.col === this.playhead);
    if (!cell) return;
    this.initAural();
    this.fmBassStab(700, 0.16, 0.04 * this.ghostPattern.alpha);
  }

  drawGhostPattern() {
    if (!this.ghostPattern || this.grid.length > 0) return;
    const cellW = (this.W - LEFT_GUTTER) / STEPS, padTop = 30;
    const cellH = this.H - padTop - 30;
    const y = padTop, a = this.ghostPattern.alpha;
    for (let s = 0; s < STEPS; s++) {
      const x = LEFT_GUTTER + s * cellW;
      this.ctx.fillStyle = s === this.playhead ? `rgba(26,26,42,${a})` : `rgba(17,17,17,${a})`;
      this.ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
    }
    const rowH = 40, ghostY = y + cellH / 2 - rowH / 2;
    for (const cell of this.ghostPattern.cells) {
      const x = LEFT_GUTTER + cell.col * cellW;
      this.ctx.fillStyle = `rgba(180,180,200,${a * 0.3})`; this.ctx.fillRect(x + 3, ghostY + 3, cellW - 6, rowH - 6);
      if (cell.col === this.playhead) { this.ctx.fillStyle = `rgba(200,200,220,${a * 0.55})`; this.ctx.fillRect(x + 3, ghostY + 3, cellW - 6, rowH - 6); }
    }
  }

  onTopics(t) { this.ensureRows(); }

  onStart() {
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: light up one cell per token in greyscale using hashed row+col.
  // Cells appear in the ghost pattern row before the grid has real topics.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    // We want to pre-populate a ghost pattern that lives in ghostPattern.cells
    // but with per-token positions. Replace or extend the existing ghost pattern.
    const cells = [];
    const used = new Set();
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      let col = h % STEPS;
      // Avoid duplicate columns
      let tries = 0;
      while (used.has(col) && tries < STEPS) { col = (col + 1) % STEPS; tries++; }
      if (used.has(col)) continue;
      used.add(col);
      cells.push({ col, note: G_MINOR[(h >> 4) % G_MINOR.length] });
    }
    if (cells.length > 0) {
      this.ghostPattern = { cells, age: 0, maxAge: 480, alpha: 0, targetAlpha: 1 };
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.initAural();
    this.addNote(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.grid = [];
    this.playhead = 0;
    this.flashCells = [];
    this.ghostPattern = null;
    this.primePhase = false;
  }

  // VHS scanlines — horizontal lines every 2px at low alpha, tiled via a 2×2
  // pattern (top row filled, bottom row transparent). Analog memory.
  drawScanlines() {
    if (!this._scanPattern) {
      const tile = document.createElement('canvas');
      tile.width = 2; tile.height = 2;
      const tc = tile.getContext('2d');
      tc.fillStyle = 'rgba(120, 130, 160, 0.10)';
      tc.fillRect(0, 0, 2, 1);
      this._scanPattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._scanPattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    const now = performance.now();
    this.simulatePrime();
    if (now - this.lastStepTime > stepMs) {
      this.lastStepTime = now;
      this.playhead = (this.playhead + 1) % STEPS;
      if (this.auralInit && this.playhead % 4 === 0 && this.grid.some(r => r[this.playhead])) this.crushedKick();
      this.grid.forEach((row, ri) => {
        const cell = row[this.playhead]; if (!cell) return;
        const stance = cell.stance;
        let dur = 0.18, stanceVolMult = 1;
        if (stance === 'claiming') { dur = 0.10; stanceVolMult = 1.1; }
        else if (stance === 'exploring') { dur = 0.20; }
        else if (stance === 'questioning') { dur = 0.45; }
        else if (stance === 'conceding') { dur = 0.20; stanceVolMult = 0.6; }
        const heat = typeof cell.heat === 'number' ? cell.heat : 0;
        const heatMult = 0.6 + heat * 0.8;
        const inbound = this.nodeIncoming(cell.id);
        const pivotMult = inbound >= 3 ? 1.4 : 1;
        const conf = cell.confidence || 0.7;
        const baseVol = 0.06 + conf * 0.06;
        const vol = baseVol * stanceVolMult * heatMult * pivotMult;
        this.fmBassStab(this.rowCutoff(ri, this.grid.length), dur, vol);
        this.flashCells.push({ row: ri, col: this.playhead, alpha: 1, pivot: inbound >= 3 });
      });
      this.triggerGhostStepAudio();
    }
    const cellW = (this.W - LEFT_GUTTER) / STEPS, padTop = 30;
    const rows = Math.max(this.grid.length, 1);
    const cellH = (this.H - padTop - 30) / rows;
    this.ctx.fillStyle = '#0a0a0a'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawScanlines();
    this.drawGhostPattern();
    this.ctx.font = '9px "JetBrains Mono", monospace'; this.ctx.textAlign = 'center';
    for (let s = 0; s < STEPS; s++) { this.ctx.fillStyle = s === this.playhead ? '#ff006e' : '#333'; this.ctx.fillText(s + 1, LEFT_GUTTER + (s + 0.5) * cellW, 18); }
    this.ctx.textAlign = 'end'; this.ctx.font = '10px "JetBrains Mono", monospace';
    this.grid.forEach((_, ri) => { const y = padTop + ri * cellH + cellH / 2 + 4; this.ctx.fillStyle = '#666'; this.ctx.fillText(this.rowNoteName(ri), LEFT_GUTTER - 6, y); });
    this.ctx.textAlign = 'center';
    this.grid.forEach((row, ri) => {
      const cell = row[this.playhead]; if (!cell) return;
      const inbound = this.nodeIncoming(cell.id); if (inbound < 3) return;
      const info = this.topicInfo(this.topics[ri]?.id);
      const [hr, hg, hb] = hexToRgb(info.color);
      const intensity = Math.min(1, (inbound - 2) / 4);
      const x = LEFT_GUTTER + this.playhead * cellW;
      this.ctx.fillStyle = `rgba(${hr},${hg},${hb},${0.10 * intensity})`; this.ctx.fillRect(x, padTop, cellW, this.H - padTop - 30);
      this.ctx.fillStyle = `rgba(${hr},${hg},${hb},${0.18 * intensity})`; this.ctx.fillRect(x + cellW * 0.3, padTop, cellW * 0.4, this.H - padTop - 30);
    });
    const ht = this.app.highlightedTopic;
    this.grid.forEach((row, ri) => {
      const info = this.topicInfo(this.topics[ri]?.id);
      const [r, g, b] = hexToRgb(info.color);
      const rowDim = ht && this.topics[ri]?.id !== ht ? 0.25 : 1;
      for (let s = 0; s < STEPS; s++) {
        const x = LEFT_GUTTER + s * cellW, y = padTop + ri * cellH;
        this.ctx.fillStyle = s === this.playhead ? '#1a1a2a' : '#111'; this.ctx.globalAlpha = 1;
        this.ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        const cell = row[s]; if (!cell) continue;
        const conf = cell.confidence || 0.7;
        const heat = typeof cell.heat === 'number' ? cell.heat : 0;
        const heatMult = 0.85 + heat * 0.4;
        const baseAlpha = Math.min(0.95, (0.3 + conf * 0.5) * heatMult);
        this.ctx.fillStyle = `rgba(${r},${g},${b},${baseAlpha * rowDim})`; this.ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
        if (cell.type === 'resolution') { this.ctx.fillStyle = `rgba(${r},${g},${b},0.15)`; this.ctx.fillRect(x, y, cellW, cellH); }
        const stance = cell.stance;
        if (stance === 'claiming') {
          this.ctx.strokeStyle = `rgba(${r},${g},${b},0.95)`; this.ctx.lineWidth = 2.2;
          this.ctx.beginPath(); this.ctx.moveTo(x + 2, y + 2); this.ctx.lineTo(x + cellW - 2, y + 2); this.ctx.stroke();
        } else if (stance === 'questioning') {
          this.ctx.strokeStyle = `rgba(${r},${g},${b},0.7)`; this.ctx.lineWidth = 1; this.ctx.setLineDash([2, 2]);
          this.ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4); this.ctx.setLineDash([]);
        } else if (stance === 'conceding') {
          this.ctx.strokeStyle = `rgba(${r},${g},${b},0.35)`; this.ctx.lineWidth = 0.6;
          this.ctx.save(); this.ctx.beginPath(); this.ctx.rect(x + 2, y + 2, cellW - 4, cellH - 4); this.ctx.clip();
          for (let k = -cellH; k < cellW + cellH; k += 5) { this.ctx.beginPath(); this.ctx.moveTo(x + k, y); this.ctx.lineTo(x + k + cellH, y + cellH); this.ctx.stroke(); }
          this.ctx.restore();
        }
        const inbound = this.nodeIncoming(cell.id);
        if (inbound >= 3) {
          const intensity = Math.min(1, (inbound - 2) / 4);
          this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.45 + 0.35 * intensity})`; this.ctx.lineWidth = 1.3;
          this.ctx.strokeRect(x + 1.5, y + 1.5, cellW - 3, cellH - 3);
        }
        const g2 = relGlyph(cell.rel);
        if (g2 && cellW >= 16 && cellH >= 12) {
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const ink = luma > 140 ? 'rgba(10,10,20,0.85)' : 'rgba(240,240,250,0.9)';
          this.ctx.fillStyle = ink; this.ctx.font = `${Math.min(12, Math.floor(cellH * 0.45))}px "JetBrains Mono", monospace`;
          this.ctx.textAlign = 'end'; this.ctx.textBaseline = 'top'; this.ctx.fillText(g2, x + cellW - 4, y + 3);
        }
      }
    });
    this.flashCells.forEach(fc => {
      if (fc.alpha <= 0) return;
      const info = this.topicInfo(this.topics[fc.row]?.id);
      const x = LEFT_GUTTER + fc.col * cellW, y = padTop + fc.row * cellH;
      this.ctx.fillStyle = info.color; this.ctx.globalAlpha = fc.alpha * 0.4;
      this.ctx.fillRect(x, y, cellW, cellH); fc.alpha *= 0.9;
    });
    this.flashCells = this.flashCells.filter(f => f.alpha > 0.01);
    this.ctx.strokeStyle = '#ff006e'; this.ctx.globalAlpha = 0.6; this.ctx.lineWidth = 2;
    const px = LEFT_GUTTER + (this.playhead + 0.5) * cellW;
    this.ctx.beginPath(); this.ctx.moveTo(px, padTop); this.ctx.lineTo(px, padTop + this.grid.length * cellH); this.ctx.stroke();
    this.ctx.globalAlpha = 1; this.ctx.textAlign = 'start';
  }
}

export { SequencerMode };

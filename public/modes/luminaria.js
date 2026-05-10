import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey } from '/synth.js';

const COLS = 16, ROWS = 10;
const DIRS = [[1,0],[0,1],[-1,0],[0,-1]];
const ARROWS = ['→','↓','←','↑'];

class LuminariaMode extends Mode {
  grid = [];
  walkers = [];
  primePhase = false;
  signalR = 0;
  signalC = 0;
  signalStepTimer = 0;
  signalAlpha = 0;
  signalTargetAlpha = 0;
  pulses = [];
  refParticles = [];
  refSpawnTimer = 200;
  frame = 0;

  constructor() {
    super({
      mode: 'luminaria',
      aesthetic: 'industrial',
      topicFallbackColor: '#ffd60a',
      vars: {
        '--e-bg': '#000000', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#f29f05', '--e-pivot-tint': 'rgba(166,47,3,0.12)', '--e-accent': '#a62f03',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.initGrid();

    this.canvas.addEventListener('click', e => {
      const rect = this.canvas.getBoundingClientRect();
      const cellW = this.W / COLS, cellH = this.H / ROWS;
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const c = Math.floor(mx / cellW), r = Math.floor(my / cellH);
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
      if (this.primePhase) { this.pulses.push({ r, c, age: 0, maxAge: 110 }); this.signalR = r; this.signalC = c; this.signalStepTimer = 55 + Math.floor(Math.random() * 30); return; }
      let hitWalker = null, bestD = 12;
      this.walkers.forEach(w => {
        const wx = (w.c + 0.5) * cellW, wy = (w.r + 0.5) * cellH;
        const d = Math.hypot(wx - mx, wy - my);
        if (d < bestD) { bestD = d; hitWalker = w; }
      });
      if (hitWalker) { hitWalker._flickDir = Math.floor(Math.random() * 4); return; }
      if (this.grid[r][c]) { this.grid[r][c].dir = (this.grid[r][c].dir + 1) % 4; }
      else { const dir = Math.floor(Math.random() * 4); this.grid[r][c] = { dir, color: '#888', note: 440, node: null, manual: true }; }
    });
    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect();
      const cellW = this.W / COLS, cellH = this.H / ROWS;
      const c = Math.floor((e.clientX - rect.left) / cellW), r = Math.floor((e.clientY - rect.top) / cellH);
      const cell = (r >= 0 && r < ROWS && c >= 0 && c < COLS) ? this.grid[r][c] : null;
      if (cell && cell.node && !cell.manual) { showTooltip(e, cell.node, cell.color); this.app.highlightLegendTopic(cell.node.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
  }

  count() { return this.walkers.length; }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    const arr = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const cell = this.grid[r]?.[c]; if (cell && cell.node) arr.push(cell.node); }
    return incomingRefsOf(id, arr);
  }

  hasExternalBecause(n) { const b = n && n.because; return Array.isArray(b) && b.some(x => typeof x === 'string'); }

  findCellOfNode(id) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const cell = this.grid[r]?.[c]; if (cell && cell.node && cell.node.id === id) return { r, c }; }
    return null;
  }

  hexToRgba(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  initGrid() { this.grid = []; for (let r = 0; r < ROWS; r++) this.grid.push(new Array(COLS).fill(null)); this.walkers = []; }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('industrial');
      pickSessionKey(this.app.prompt() || 'luminaria');
    });
  }

  freqToMidi(hz) { return Math.round(69 + 12 * Math.log2(hz / 440)); }

  edgeCutoff(c, r) {
    const d = Math.min(c, COLS - 1 - c, r, ROWS - 1 - r);
    const maxD = Math.min((COLS - 1) / 2, (ROWS - 1) / 2);
    const t = maxD <= 0 ? 0 : Math.min(1, d / maxD);
    return 260 + t * (900 - 260);
  }

  walkerStab(midi, cutoff, vol = 0.10, dur = 0.16) {
    playSynth({ midi, wave: 'sawtooth', voices: 4, detune: 35, attack: 0.001, decay: 0.05, sustain: 0.7, release: 0.15, duration: dur, vol, filter: { type: 'lowpass', freq: cutoff, Q: 8 }, distortion: { drive: 0.4, tone: 'crunch', mix: 0.55 }, reverbSend: 0.20, delaySend: 0.95 });
  }

  walkerStepStab(cell, c, r) {
    this.initAural();
    const baseHz = cell.note || 440;
    const midi = this.freqToMidi(baseHz) - 24;
    const cutoff = this.edgeCutoff(c, r);
    this.walkerStab(midi, cutoff, 0.10, 0.16);
  }

  placementStab(cell, c, r) {
    this.initAural();
    const baseHz = cell.note || 440;
    const midi = this.freqToMidi(baseHz) - 24;
    const cutoff = this.edgeCutoff(c, r);
    this.walkerStab(midi, cutoff, 0.13, 0.22);
  }

  addToGrid(node, atR, atC, atDir) {
    const info = this.topicInfo(node.topic);
    if (atR !== undefined && atC !== undefined && !this.grid[atR][atC]) {
      const dir = atDir !== undefined ? atDir : Math.floor(Math.random() * 4);
      this.grid[atR][atC] = { dir, color: info.color, node, note: info.note };
      this.walkers.push({ c: atC, r: atR, color: info.color, trail: [], note: info.note }); return;
    }
    let placed = false;
    for (let attempts = 0; attempts < 50 && !placed; attempts++) {
      const r = Math.floor(Math.random() * ROWS), c = Math.floor(Math.random() * COLS);
      if (!this.grid[r][c]) {
        const dir = Math.floor(Math.random() * 4);
        this.grid[r][c] = { dir, color: info.color, node, note: info.note };
        placed = true;
        this.walkers.push({ c, r, color: info.color, trail: [], note: info.note });
      }
    }
  }

  startPrime() {
    this.primePhase = true; this.pulses = [];
    this.signalR = Math.floor(Math.random() * ROWS); this.signalC = Math.floor(Math.random() * COLS);
    this.signalStepTimer = 12; this.signalAlpha = 0; this.signalTargetAlpha = 0.9;
  }

  stopPrime() { this.primePhase = false; this.signalTargetAlpha = 0; }

  adoptSignal(node) {
    if (this.grid[this.signalR][this.signalC]) return false;
    this.addToGrid(node, this.signalR, this.signalC); return true;
  }

  simulatePrime() {
    this.signalAlpha += (this.signalTargetAlpha - this.signalAlpha) * 0.08;
    if (this.primePhase) {
      this.signalStepTimer--;
      if (this.signalStepTimer <= 0) {
        this.pulses.push({ r: this.signalR, c: this.signalC, age: 0, maxAge: 110 });
        const [dc, dr] = DIRS[Math.floor(Math.random() * 4)];
        this.signalR = (this.signalR + dr + ROWS) % ROWS; this.signalC = (this.signalC + dc + COLS) % COLS;
        this.signalStepTimer = 55 + Math.floor(Math.random() * 30);
      }
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) { this.pulses[i].age++; if (this.pulses[i].age > this.pulses[i].maxAge) this.pulses.splice(i, 1); }
  }

  simulateRefParticles() {
    this.refSpawnTimer--;
    if (this.refSpawnTimer <= 0) {
      this.refSpawnTimer = 180 + Math.floor(Math.random() * 120);
      const pairs = [];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const cell = this.grid[r]?.[c];
        if (!cell || !cell.node || !Array.isArray(cell.node.refs)) continue;
        for (const tid of cell.node.refs) { const tgt = this.findCellOfNode(tid); if (tgt) pairs.push({ from: { r, c }, to: tgt, color: cell.color }); }
      }
      if (pairs.length > 0 && this.refParticles.length < 4) {
        const pick = pairs[Math.floor(Math.random() * pairs.length)];
        this.refParticles.push({ fromR: pick.from.r, fromC: pick.from.c, toR: pick.to.r, toC: pick.to.c, t: 0, color: pick.color });
      }
    }
    for (let i = this.refParticles.length - 1; i >= 0; i--) {
      this.refParticles[i].t += 0.012;
      if (this.refParticles[i].t >= 1) this.refParticles.splice(i, 1);
    }
  }

  simulate() {
    this.simulateRefParticles();
    if (this.frame % 8 !== 0) return;
    this.walkers.forEach(w => {
      let dir;
      if (w._flickDir !== undefined) { dir = w._flickDir; delete w._flickDir; }
      else { const cell = this.grid[w.r]?.[w.c]; if (!cell) return; dir = cell.dir; }
      const [dc, dr] = DIRS[dir];
      w.c = ((w.c + dc) + COLS) % COLS; w.r = ((w.r + dr) + ROWS) % ROWS;
      w.trail.push({ c: w.c, r: w.r }); if (w.trail.length > 30) w.trail.shift();
      const next = this.grid[w.r]?.[w.c]; if (!next) { w._lastNote = null; return; }
      if (next.note === w._lastNote) return;
      this.walkerStepStab(next, w.c, w.r);
      w._lastNote = next.note;
    });
  }

  drawPivotGlows(cellW, cellH) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const cell = this.grid[r]?.[c]; if (!cell || !cell.node) continue;
      const inbound = this.nodeIncoming(cell.node.id); if (inbound < 3) continue;
      const intensity = Math.min(1, (inbound - 2) / 4);
      const cx = (c + 0.5) * cellW, cy = (r + 0.5) * cellH, rr = Math.min(cellW, cellH) * 0.48;
      const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      grad.addColorStop(0, this.hexToRgba(cell.color, 0.25 * intensity)); grad.addColorStop(1, this.hexToRgba(cell.color, 0));
      this.ctx.fillStyle = grad; this.ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
    }
  }

  drawPortals(cellW, cellH) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const cell = this.grid[r]?.[c]; if (!cell || !cell.node || !this.hasExternalBecause(cell.node)) continue;
      const cx = (c + 0.5) * cellW, cy = (r + 0.5) * cellH;
      const dL = cx, dR = this.W - cx, dT = cy, dB = this.H - cy;
      const minD = Math.min(dL, dR, dT, dB);
      let px, py;
      if (minD === dL) { px = 0; py = cy; } else if (minD === dR) { px = this.W; py = cy; }
      else if (minD === dT) { px = cx; py = 0; } else { px = cx; py = this.H; }
      const r0 = 12, r1 = Math.max(cellW, cellH) * 0.9;
      const grad = this.ctx.createRadialGradient(px, py, r0, px, py, r1);
      grad.addColorStop(0, this.hexToRgba(cell.color, 0.42)); grad.addColorStop(1, this.hexToRgba(cell.color, 0));
      this.ctx.fillStyle = grad; this.ctx.fillRect(px - r1, py - r1, r1 * 2, r1 * 2);
    }
  }

  drawRefParticles(cellW, cellH) {
    for (const p of this.refParticles) {
      const sx = (p.fromC + 0.5) * cellW, sy = (p.fromR + 0.5) * cellH;
      const ex = (p.toC + 0.5) * cellW, ey = (p.toR + 0.5) * cellH;
      const x = sx + (ex - sx) * p.t, y = sy + (ey - sy) * p.t;
      const envelope = Math.sin(p.t * Math.PI);
      this.ctx.fillStyle = this.hexToRgba(p.color, 0.75 * envelope); this.ctx.beginPath(); this.ctx.arc(x, y, 3, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = this.hexToRgba(p.color, 0.25 * envelope); this.ctx.beginPath(); this.ctx.arc(x, y, 7, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  drawSignalPulse() {
    if (this.pulses.length === 0 && this.signalAlpha < 0.01) return;
    const cellW = this.W / COLS, cellH = this.H / ROWS;
    for (const p of this.pulses) {
      const t = p.age / p.maxAge, cx = (p.c + 0.5) * cellW, cy = (p.r + 0.5) * cellH;
      const r = Math.min(cellW, cellH) * (0.15 + t * 0.55), alpha = (1 - t) * 0.32;
      this.ctx.strokeStyle = `rgba(180,190,230,${alpha})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.arc(cx, cy, r, 0, Math.PI * 2); this.ctx.stroke();
    }
    if (this.signalAlpha > 0.01) {
      const cx = (this.signalC + 0.5) * cellW, cy = (this.signalR + 0.5) * cellH;
      this.ctx.fillStyle = `rgba(220,225,245,${this.signalAlpha * 0.7})`; this.ctx.beginPath(); this.ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.strokeStyle = `rgba(220,225,245,${this.signalAlpha * 0.28})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.arc(cx, cy, 7, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  onStart() {
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: place one arrow cell per token at a hashed grid position,
  // demonstrating the Langton-ant vocabulary before real nodes arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const r = h % ROWS;
      const c = (h >> 4) % COLS;
      if (!this.grid[r][c]) {
        const dir = (h >> 8) % 4;
        this.grid[r][c] = { dir, color: '#888877', note: 440, node: null, manual: true };
      }
    }
  }

  onNode(n) {
    if (this.primePhase && this.adoptSignal(n)) this.stopPrime();
    else this.addToGrid(n);
    const placed = this.walkers[this.walkers.length - 1];
    if (placed && this.grid[placed.r] && this.grid[placed.r][placed.c]) this.placementStab(this.grid[placed.r][placed.c], placed.c, placed.r);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.pulses = [];
    this.primePhase = false;
    this.signalAlpha = 0;
    this.signalTargetAlpha = 0;
    this.refParticles = [];
    this.refSpawnTimer = 200;
    this.initGrid();
  }

  // Copper traces — thin orange polylines walking the canvas with right-angle
  // turns, plus small vias at endpoints. Reads as a circuit board underneath
  // the automata grid. Cached.
  drawCopperTraces() {
    if (!this._tracesOff || this._tracesW !== this.W || this._tracesH !== this.H) {
      if (!this._tracesOff) this._tracesOff = document.createElement('canvas');
      this._tracesOff.width = Math.max(1, Math.ceil(this.W));
      this._tracesOff.height = Math.max(1, Math.ceil(this.H));
      this._tracesW = this.W; this._tracesH = this.H;
      const oc = this._tracesOff.getContext('2d');
      oc.clearRect(0, 0, this.W, this.H);
      oc.strokeStyle = 'rgba(220, 130, 60, 0.07)';
      oc.lineWidth = 1;
      const grid = 24;
      const count = Math.max(12, Math.floor((this.W * this.H) / 80000));
      for (let i = 0; i < count; i++) {
        let x = Math.floor(Math.random() * (this.W / grid)) * grid;
        let y = Math.floor(Math.random() * (this.H / grid)) * grid;
        const startX = x, startY = y;
        const segments = 3 + Math.floor(Math.random() * 6);
        let horiz = Math.random() < 0.5;
        oc.beginPath();
        oc.moveTo(x, y);
        for (let s = 0; s < segments; s++) {
          const len = (1 + Math.floor(Math.random() * 5)) * grid;
          const dir = Math.random() < 0.5 ? 1 : -1;
          if (horiz) x += len * dir; else y += len * dir;
          oc.lineTo(x, y);
          horiz = !horiz;
        }
        oc.stroke();
        oc.fillStyle = 'rgba(220, 130, 60, 0.12)';
        oc.beginPath(); oc.arc(startX, startY, 1.6, 0, Math.PI * 2); oc.fill();
        oc.beginPath(); oc.arc(x, y, 1.6, 0, Math.PI * 2); oc.fill();
      }
    }
    this.ctx.drawImage(this._tracesOff, 0, 0);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.frame++;
    this.simulate();
    this.simulatePrime();
    const cellW = this.W / COLS, cellH = this.H / ROWS;
    this.ctx.fillStyle = '#04120a'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawCopperTraces();
    this.ctx.strokeStyle = '#242448'; this.ctx.lineWidth = 0.75;
    for (let r = 0; r <= ROWS; r++) { this.ctx.beginPath(); this.ctx.moveTo(0, r * cellH); this.ctx.lineTo(this.W, r * cellH); this.ctx.stroke(); }
    for (let c = 0; c <= COLS; c++) { this.ctx.beginPath(); this.ctx.moveTo(c * cellW, 0); this.ctx.lineTo(c * cellW, this.H); this.ctx.stroke(); }
    this.drawPivotGlows(cellW, cellH);
    this.drawPortals(cellW, cellH);
    const ht = this.app.highlightedTopic;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const cell = this.grid[r][c]; if (!cell) continue;
      const cx = (c + 0.5) * cellW, cy = (r + 0.5) * cellH;
      const node = cell.node;
      const heat = (node && typeof node.heat === 'number') ? node.heat : 0;
      const heatAlpha = 0.85 + heat * 0.15;
      const stance = node && node.stance;
      const dim = ht && node && node.topic !== ht ? 0.25 : 1;
      const fontSize = Math.min(cellW, cellH) * 0.5;
      this.ctx.font = `${fontSize}px sans-serif`; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
      if (stance === 'conceding') {
        this.ctx.fillStyle = cell.color; this.ctx.globalAlpha = heatAlpha * 0.4 * dim; this.ctx.fillText(ARROWS[cell.dir], cx, cy);
      } else if (stance === 'exploring') {
        this.ctx.strokeStyle = cell.color; this.ctx.globalAlpha = heatAlpha * 0.9 * dim; this.ctx.lineWidth = 1.2; this.ctx.setLineDash([2, 2]); this.ctx.strokeText(ARROWS[cell.dir], cx, cy); this.ctx.setLineDash([]);
        this.ctx.fillStyle = cell.color; this.ctx.font = `${fontSize * 0.3}px 'Space Grotesk', sans-serif`; this.ctx.globalAlpha = heatAlpha * 0.65 * dim;
        this.ctx.fillText('~', cx + fontSize * 0.32, cy - fontSize * 0.32);
      } else if (stance === 'questioning') {
        this.ctx.fillStyle = cell.color; this.ctx.globalAlpha = heatAlpha * dim; this.ctx.fillText(ARROWS[cell.dir], cx, cy);
        this.ctx.font = `${fontSize * 0.3}px 'Space Grotesk', sans-serif`; this.ctx.globalAlpha = heatAlpha * 0.65 * dim;
        this.ctx.fillText('?', cx + fontSize * 0.32, cy - fontSize * 0.32);
      } else {
        this.ctx.fillStyle = cell.color; this.ctx.globalAlpha = heatAlpha * dim; this.ctx.fillText(ARROWS[cell.dir], cx, cy);
      }
    }
    this.ctx.globalAlpha = 1;
    this.drawRefParticles(cellW, cellH);
    this.drawSignalPulse();
    this.walkers.forEach(w => {
      w.trail.forEach((pos, i) => {
        const alpha = (i / w.trail.length) * 0.5;
        const cx = (pos.c + 0.5) * cellW, cy = (pos.r + 0.5) * cellH;
        this.ctx.fillStyle = w.color; this.ctx.globalAlpha = alpha;
        this.ctx.beginPath(); this.ctx.arc(cx, cy, 3 + (i / w.trail.length) * 3, 0, Math.PI * 2); this.ctx.fill();
      });
      const cx = (w.c + 0.5) * cellW, cy = (w.r + 0.5) * cellH;
      this.ctx.fillStyle = w.color; this.ctx.globalAlpha = 0.9;
      this.ctx.beginPath(); this.ctx.arc(cx, cy, 5, 0, Math.PI * 2); this.ctx.fill();
    });
    this.ctx.globalAlpha = 1; this.ctx.textAlign = 'start';
  }
}

export { LuminariaMode };

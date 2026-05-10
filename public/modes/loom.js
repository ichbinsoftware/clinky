import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, relColor, playTone } from '/clinky.js';
import { playSynth, playChord, midiToFreq, PRESETS, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

const COLS = 12, ROWS = 16;
const PENT_MAJOR_INDICES = [0, 1, 2, 4, 5];
const PENT_MINOR_INDICES = [0, 2, 3, 4, 6];
const TALEAE = [[1.00, 0.50, 0.75],[1.00, 0.40, 0.70, 0.30, 0.80],[0.90, 0.30, 0.60, 0.85, 0.20, 0.70, 0.50],[1.00, 0.55, 0.40, 0.70]];
const COLORS = [[0, 2, 4, 3, 5],[0, 4, 2, 6, 1, 3, 5],[0, 3, 2, 5],[0, 2, 4, 6, 3, 5]];

function hashTopic(topicId) {
  const s = String(topicId || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

class LoomMode extends Mode {
  grid = [];
  nextCol = 0;
  primePhase = false;
  shimmerPhase = 0;
  downCell = null;
  primeTrail = [];
  primeDragging = false;
  rowSteps = new Map();

  constructor() {
    super({
      mode: 'loom',
      aesthetic: 'videogame',
      topicFallbackColor: '#d8c4a0',
      vars: {
        '--e-bg': '#221812', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#e4c889', '--e-pivot-tint': 'rgba(248,161,64,0.08)', '--e-accent': '#f8a140',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.initGrid();

    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (this.primeDragging) {
        const cell = this.cellAt(mx, my);
        if (cell && !this.primeTrail.some(t => t.r === cell.r && t.c === cell.c)) this.primeTrail.push(cell);
        return;
      }
      const cell = this.cellAt(mx, my);
      if (cell && this.grid[cell.r][cell.c] && this.grid[cell.r][cell.c].node) {
        showTooltip(e, this.grid[cell.r][cell.c].node, this.grid[cell.r][cell.c].color);
        this.app.highlightLegendTopic(this.grid[cell.r][cell.c].topic);
      } else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('mouseleave', () => { this.downCell = null; this.primeDragging = false; });
    this.canvas.addEventListener('mousedown', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const cell = this.cellAt(mx, my); if (!cell) return;
      if (this.primePhase) { this.primeDragging = true; this.primeTrail = [cell]; return; }
      if (this.grid[cell.r][cell.c]) this.downCell = cell;
    });
    this.canvas.addEventListener('mouseup', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const cell = this.cellAt(mx, my);
      if (this.primeDragging) { this.primeDragging = false; return; }
      const from = this.downCell; this.downCell = null;
      if (!cell) return;
      if (from && !(from.r === cell.r && from.c === cell.c)) {
        const adjacent = (from.r === cell.r && Math.abs(from.c - cell.c) === 1) || (from.c === cell.c && Math.abs(from.r - cell.r) === 1);
        if (adjacent && this.grid[cell.r][cell.c]) {
          const tmp = this.grid[from.r][from.c];
          this.grid[from.r][from.c] = this.grid[cell.r][cell.c];
          this.grid[cell.r][cell.c] = tmp;
          if (this.grid[from.r][from.c]) { this.grid[from.r][from.c].dropY = from.r; this.grid[from.r][from.c].targetRow = from.r; }
          if (this.grid[cell.r][cell.c]) { this.grid[cell.r][cell.c].dropY = cell.r; this.grid[cell.r][cell.c].targetRow = cell.r; }
          this.applyGravity(); return;
        }
      }
      const bead = this.grid[cell.r]?.[cell.c];
      if (bead && bead.topic !== '__spacer__') {
        const runs = this.matchRunsAt(cell.r, cell.c);
        if (runs.length > 0) {
          const now = performance.now();
          for (const run of runs) { for (const pt of run) { const b = this.grid[pt.r][pt.c]; if (b) b.flashUntil = now + 800; } }
          this.playMatchChord();
        }
        return;
      }
      if (!bead) this.grid[cell.r][cell.c] = { color: '#555555', topic: '__spacer__', node: null, dropY: cell.r, targetRow: cell.r };
    });
  }

  count() { let n = 0; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (this.grid[r][c]) n++; return n; }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    const arr = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const b = this.grid[r]?.[c]; if (b && b.node) arr.push(b.node); }
    return incomingRefsOf(id, arr);
  }

  hasExternalBecause(n) { const b = n && n.because; return Array.isArray(b) && b.some(x => typeof x === 'string'); }

  cellOfNodeId(id) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const b = this.grid[r]?.[c]; if (b && b.node && b.node.id === id) return { r, c }; }
    return null;
  }

  initGrid() {
    this.grid = [];
    for (let r = 0; r < ROWS; r++) this.grid.push(new Array(COLS).fill(null));
    this.nextCol = 0;
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('videogame');
      pickSessionKey(this.app.prompt() || 'loom');
    });
  }

  topicThumpMidi(topicId) {
    const key = getSessionKey();
    const mask = (key.scale === 'minor') ? PENT_MINOR_INDICES : PENT_MAJOR_INDICES;
    const pentNotes = mask.map(i => key.notes[i % key.notes.length]);
    const slot = hashTopic(topicId) % pentNotes.length;
    return pentNotes[slot] - 12;
  }

  playBeadThump(node) {
    const elapsed = (typeof node.elapsed_ms === 'number') ? node.elapsed_ms : 0;
    const velocity = Math.max(0, 1 - elapsed / 1800);
    if (velocity <= 0.05) return;
    const heat = (typeof node.heat === 'number') ? node.heat : 0;
    const accent = 1 + heat * 0.7;
    const midi = this.topicThumpMidi(node.topic);
    playSynth({ midi, wave: 'sine', attack: 0.001, decay: 0.14, sustain: 0, release: 0.05, duration: 0, vol: 0.14 * velocity * accent, filter: { type: 'lowpass', freq: 250, Q: 1 } });
  }

  playIsorhythmPluck(node, row) {
    const talea = TALEAE[row % TALEAE.length];
    const color = COLORS[(row + 2) % COLORS.length];
    const step = this.rowSteps.get(row) || 0;
    this.rowSteps.set(row, step + 1);
    const accent = talea[step % talea.length];
    if (accent < 0.2) return;
    const key = getSessionKey();
    const degree = color[step % color.length];
    const midi = key.notes[degree % key.notes.length] + 12;
    const heat = (typeof node.heat === 'number') ? node.heat : 0;
    playSynth({ midi, ...PRESETS.pluck, vol: 0.08 * accent * (1 + heat * 0.5), reverbSend: 0.18, delaySend: 0.28 });
  }

  playMatchChord() {
    const key = getSessionKey();
    const root = key.rootMidi + 24;
    const isMinor = key.scale === 'minor';
    const midis = isMinor ? [root, root + 3, root + 7] : [root, root + 4, root + 7];
    playChord(midis.map(midiToFreq), { ...PRESETS.pad, duration: 1.0, vol: 0.18, reverbSend: 0.35, delaySend: 0.12 });
  }

  gridRect() {
    const target = Math.min(this.W, this.H) * 0.6;
    const cellSize = Math.min(target / COLS, target / ROWS);
    const w = cellSize * COLS, h = cellSize * ROWS;
    return { x: (this.W - w) / 2, y: (this.H - h) / 2, w, h, cell: cellSize };
  }

  cellAt(mx, my) {
    const g = this.gridRect();
    const c = Math.floor((mx - g.x) / g.cell), r = Math.floor((my - g.y) / g.cell);
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) return { r, c };
    return null;
  }

  addBead(node) {
    const info = this.topicInfo(node.topic);
    const topicIdx = this.topics.findIndex(t => t.id === node.topic);
    let col;
    if (this.primeTrail.length > 0) { const target = this.primeTrail.shift(); col = target.c; }
    else {
      const base = topicIdx >= 0 ? (topicIdx * 3) % COLS : this.nextCol;
      const offset = Math.floor(Math.random() * 5) - 2;
      col = ((base + offset) % COLS + COLS) % COLS;
    }
    this.nextCol = (this.nextCol + 1) % COLS;
    for (let attempt = 0; attempt < COLS; attempt++) {
      const c = (col + attempt) % COLS;
      for (let r = ROWS - 1; r >= 0; r--) {
        if (!this.grid[r][c]) {
          this.grid[r][c] = { color: info.color, topic: node.topic, node, dropY: -1, targetRow: r };
          return { r, c };
        }
      }
    }
    return null;
  }

  isTopic(r, c) { return this.grid[r]?.[c] && this.grid[r][c].topic !== '__spacer__'; }

  matchRunsAt(hr, hc) {
    const topic = this.grid[hr]?.[hc]?.topic; if (!topic || topic === '__spacer__') return [];
    const runs = [];
    let left = hc, right = hc;
    while (left > 0 && this.isTopic(hr, left-1) && this.grid[hr][left-1].topic === topic) left--;
    while (right < COLS-1 && this.isTopic(hr, right+1) && this.grid[hr][right+1].topic === topic) right++;
    if (right - left >= 2) { const pts = []; for (let c = left; c <= right; c++) pts.push({ r: hr, c }); runs.push(pts); }
    let top = hr, bot = hr;
    while (top > 0 && this.isTopic(top-1, hc) && this.grid[top-1][hc].topic === topic) top--;
    while (bot < ROWS-1 && this.isTopic(bot+1, hc) && this.grid[bot+1][hc].topic === topic) bot++;
    if (bot - top >= 2) { const pts = []; for (let r = top; r <= bot; r++) pts.push({ r, c: hc }); runs.push(pts); }
    return runs;
  }

  findMatches() {
    const matched = new Set();
    for (let r = 0; r < ROWS; r++) {
      let run = 1;
      for (let c = 1; c < COLS; c++) {
        if (this.isTopic(r, c) && this.isTopic(r, c-1) && this.grid[r][c].topic === this.grid[r][c-1].topic) run++;
        else { if (run >= 3) for (let k = c - run; k < c; k++) matched.add(r * COLS + k); run = 1; }
      }
      if (run >= 3) for (let k = COLS - run; k < COLS; k++) matched.add(r * COLS + k);
    }
    for (let c = 0; c < COLS; c++) {
      let run = 1;
      for (let r = 1; r < ROWS; r++) {
        if (this.isTopic(r, c) && this.isTopic(r-1, c) && this.grid[r][c].topic === this.grid[r-1][c].topic) run++;
        else { if (run >= 3) for (let k = r - run; k < r; k++) matched.add(k * COLS + c); run = 1; }
      }
      if (run >= 3) for (let k = ROWS - run; k < ROWS; k++) matched.add(k * COLS + c);
    }
    return matched;
  }

  applyGravity() {
    for (let c = 0; c < COLS; c++) {
      const beads = [];
      for (let r = ROWS - 1; r >= 0; r--) { if (this.grid[r][c]) { beads.push(this.grid[r][c]); this.grid[r][c] = null; } }
      for (let i = 0; i < beads.length; i++) {
        const newR = ROWS - 1 - i;
        this.grid[newR][c] = beads[i];
        if (beads[i].targetRow !== newR) { beads[i].dropY = beads[i].dropY ?? beads[i].targetRow; beads[i].targetRow = newR; }
      }
    }
  }

  startPrime() { this.primePhase = true; this.shimmerPhase = 0; }
  stopPrime() { this.primePhase = false; }

  drawShimmer() {
    if (!this.primePhase) return;
    this.shimmerPhase += 0.03;
    const g = this.gridRect(); const cs = g.cell;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (this.grid[r][c]) continue;
        const phase = this.shimmerPhase + r * 0.4 + c * 0.7;
        const alpha = 0.04 + Math.max(0, Math.sin(phase)) * 0.12;
        const cx = g.x + (c + 0.5) * cs, cy = g.y + (r + 0.5) * cs;
        this.ctx.fillStyle = `rgba(180,160,130,${alpha})`;
        this.ctx.beginPath(); this.ctx.arc(cx, cy, cs * 0.12, 0, Math.PI * 2); this.ctx.fill();
      }
    }
  }

  drawStanceTexture(bead, cx, cy, r) {
    const stance = bead.node && bead.node.stance; if (!stance || stance === 'claiming') return;
    if (stance === 'exploring') {
      this.ctx.strokeStyle = 'rgba(255, 245, 220, 0.35)'; this.ctx.lineWidth = 0.9;
      this.ctx.beginPath(); this.ctx.moveTo(cx - r * 0.55, cy + r * 0.15); this.ctx.lineTo(cx + r * 0.5, cy + r * 0.1); this.ctx.stroke();
      this.ctx.beginPath(); this.ctx.moveTo(cx - r * 0.4, cy - r * 0.25); this.ctx.lineTo(cx + r * 0.3, cy - r * 0.3); this.ctx.stroke();
    } else if (stance === 'questioning') {
      this.ctx.fillStyle = '#221812'; this.ctx.beginPath(); this.ctx.arc(cx + r * 0.45, cy, r * 0.22, 0, Math.PI * 2); this.ctx.fill();
    } else if (stance === 'conceding') {
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.3)'; this.ctx.beginPath(); this.ctx.arc(cx, cy, r, Math.PI / 2, -Math.PI / 2, false); this.ctx.closePath(); this.ctx.fill();
    }
  }

  drawFringe(bead, cx, cy, r) {
    const br = parseInt(bead.color.slice(1, 3), 16);
    const bg = parseInt(bead.color.slice(3, 5), 16);
    const bb = parseInt(bead.color.slice(5, 7), 16);
    const dL = cx, dR = this.W - cx, dT = cy, dB = this.H - cy;
    const minD = Math.min(dL, dR, dT, dB);
    let dx, dy;
    if (minD === dL) { dx = -1; dy = 0; } else if (minD === dR) { dx = 1; dy = 0; }
    else if (minD === dT) { dx = 0; dy = -1; } else { dx = 0; dy = 1; }
    const sx = cx + dx * r, sy = cy + dy * r;
    const ex = sx + dx * r * 1.3, ey = sy + dy * r * 1.3;
    this.ctx.strokeStyle = `rgba(${br},${bg},${bb},0.75)`; this.ctx.lineWidth = 1.4; this.ctx.lineCap = 'round';
    this.ctx.beginPath(); this.ctx.moveTo(sx, sy); this.ctx.lineTo(ex, ey); this.ctx.stroke();
    this.ctx.fillStyle = `rgba(${br},${bg},${bb},0.9)`; this.ctx.beginPath(); this.ctx.arc(ex, ey, 1.4, 0, Math.PI * 2); this.ctx.fill();
  }

  drawRefsThreads(g, cs, beadR) {
    this.ctx.lineCap = 'round';
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const bead = this.grid[r]?.[c];
      if (!bead || !bead.node || !Array.isArray(bead.node.refs)) continue;
      const drawRow = bead.dropY !== undefined ? bead.dropY : r;
      const sx = g.x + (c + 0.5) * cs, sy = g.y + (drawRow + 0.5) * cs;
      for (const tid of bead.node.refs) {
        const tgt = this.cellOfNodeId(tid); if (!tgt) continue;
        const tBead = this.grid[tgt.r][tgt.c];
        const tDrawRow = tBead.dropY !== undefined ? tBead.dropY : tgt.r;
        const ex = g.x + (tgt.c + 0.5) * cs, ey = g.y + (tDrawRow + 0.5) * cs;
        const rel = bead.node.rel;
        this.ctx.strokeStyle = relColor(rel); this.ctx.globalAlpha = 0.22;
        if (rel === 'supports') { this.ctx.setLineDash([]); this.ctx.lineWidth = 1; }
        else if (rel === 'contradicts') { this.ctx.setLineDash([2, 5]); this.ctx.lineWidth = 1; }
        else if (rel === 'synthesizes') { this.ctx.setLineDash([]); this.ctx.lineWidth = 1.6; }
        else if (rel === 'refines') { this.ctx.setLineDash([1, 3]); this.ctx.lineWidth = 0.8; }
        else if (rel === 'questions') { this.ctx.setLineDash([4, 4]); this.ctx.lineWidth = 0.9; }
        else if (rel === 'supersedes') { this.ctx.setLineDash([3, 6]); this.ctx.lineWidth = 0.9; }
        else { this.ctx.setLineDash([3, 4]); this.ctx.lineWidth = 0.8; }
        this.ctx.beginPath(); this.ctx.moveTo(sx, sy); this.ctx.lineTo(ex, ey); this.ctx.stroke();
      }
    }
    this.ctx.setLineDash([]); this.ctx.globalAlpha = 1;
  }

  // Cloth weave — fine cross-hatch tile showing alternating warp/weft thread
  // segments. Cached as a Pattern; single fillRect per frame.
  drawWeave() {
    if (!this._weavePattern) {
      const tile = document.createElement('canvas');
      tile.width = 8; tile.height = 8;
      const tc = tile.getContext('2d');
      tc.strokeStyle = 'rgba(170, 140, 100, 0.08)';
      tc.lineWidth = 1;
      // Two short horizontal weft segments + two vertical warp segments,
      // offset to fake the over/under crossings of woven thread.
      tc.beginPath();
      tc.moveTo(0, 1.5); tc.lineTo(4, 1.5);
      tc.moveTo(4, 5.5); tc.lineTo(8, 5.5);
      tc.moveTo(2.5, 2); tc.lineTo(2.5, 6);
      tc.moveTo(6.5, 0); tc.lineTo(6.5, 2);
      tc.moveTo(6.5, 6); tc.lineTo(6.5, 8);
      tc.stroke();
      this._weavePattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._weavePattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  redraw() {
    this.ctx.fillStyle = '#221812'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawWeave();
    const g = this.gridRect(); const cs = g.cell, beadR = cs * 0.4;
    const matched = this.findMatches();
    this.ctx.strokeStyle = '#3a2a1e'; this.ctx.lineWidth = 1.5;
    for (let c = 0; c < COLS; c++) { const x = g.x + (c + 0.5) * cs; this.ctx.beginPath(); this.ctx.moveTo(x, g.y); this.ctx.lineTo(x, g.y + g.h); this.ctx.stroke(); }
    this.ctx.lineWidth = 0.8;
    for (let r = 0; r < ROWS; r++) { const y = g.y + (r + 0.5) * cs; this.ctx.beginPath(); this.ctx.moveTo(g.x, y); this.ctx.lineTo(g.x + g.w, y); this.ctx.stroke(); }
    this.drawRefsThreads(g, cs, beadR);
    this.drawShimmer();
    if (this.primeTrail.length > 0) {
      for (let i = 0; i < this.primeTrail.length; i++) {
        const t = this.primeTrail[i];
        const tx = g.x + (t.c + 0.5) * cs, ty = g.y + (t.r + 0.5) * cs;
        this.ctx.fillStyle = 'rgba(220,200,150,0.35)'; this.ctx.beginPath(); this.ctx.arc(tx, ty, cs * 0.2, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.fillStyle = 'rgba(220,200,150,0.5)'; this.ctx.font = `${cs * 0.25}px "JetBrains Mono", monospace`; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
        this.ctx.fillText(i + 1, tx, ty);
      }
      this.ctx.textAlign = 'start';
    }
    const ht = this.app.highlightedTopic;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const bead = this.grid[r][c]; if (!bead) continue;
        const cx = g.x + (c + 0.5) * cs;
        const drawRow = bead.dropY !== undefined ? bead.dropY : r;
        const cy = g.y + (drawRow + 0.5) * cs;
        const [br, bg, bb] = hexToRgb(bead.color);
        const beadDim = ht && bead.topic && bead.topic !== '__spacer__' && bead.topic !== '__ghost__' && bead.topic !== ht ? 0.25 : 1;
        const isMatch = matched.has(r * COLS + c);
        const flashing = bead.flashUntil && performance.now() < bead.flashUntil;
        if (flashing) {
          const flashGlow = this.ctx.createRadialGradient(cx, cy, beadR * 0.3, cx, cy, beadR * 2.5);
          flashGlow.addColorStop(0, 'rgba(255,255,255,0.4)'); flashGlow.addColorStop(1, `rgba(${br},${bg},${bb},0)`);
          this.ctx.fillStyle = flashGlow; this.ctx.fillRect(cx - beadR * 2.5, cy - beadR * 2.5, beadR * 5, beadR * 5);
        }
        if (isMatch) {
          const glow = this.ctx.createRadialGradient(cx, cy, beadR * 0.5, cx, cy, beadR * 2);
          glow.addColorStop(0, `rgba(${br},${bg},${bb},0.25)`); glow.addColorStop(1, `rgba(${br},${bg},${bb},0)`);
          this.ctx.fillStyle = glow; this.ctx.fillRect(cx - beadR * 2, cy - beadR * 2, beadR * 4, beadR * 4);
        }
        const heat = (bead.node && typeof bead.node.heat === 'number') ? bead.node.heat : 0;
        const satDelta = -30 + heat * 80;
        const highR = Math.min(255, br + 60 - satDelta * 0.4), highG = Math.min(255, bg + 60 - satDelta * 0.4), highB = Math.min(255, bb + 60 - satDelta * 0.4);
        const lowR = Math.max(0, br - 40 - satDelta * 0.5), lowG = Math.max(0, bg - 40 - satDelta * 0.5), lowB = Math.max(0, bb - 40 - satDelta * 0.5);
        const inbound = bead.node ? this.nodeIncoming(bead.node.id) : 0;
        if (inbound >= 3) {
          const intensity = Math.min(1, (inbound - 2) / 4);
          this.ctx.fillStyle = `rgba(${br},${bg},${bb},${0.22 * intensity})`; this.ctx.beginPath(); this.ctx.arc(cx, cy, beadR * 1.5, 0, Math.PI * 2); this.ctx.fill();
        }
        const dome = this.ctx.createRadialGradient(cx - beadR * 0.25, cy - beadR * 0.25, beadR * 0.1, cx, cy, beadR);
        dome.addColorStop(0, `rgba(${highR},${highG},${highB},1)`); dome.addColorStop(0.7, bead.color); dome.addColorStop(1, `rgba(${lowR},${lowG},${lowB},1)`);
        this.ctx.globalAlpha = beadDim;
        this.ctx.fillStyle = dome; this.ctx.beginPath(); this.ctx.arc(cx, cy, beadR, 0, Math.PI * 2); this.ctx.fill();
        this.drawStanceTexture(bead, cx, cy, beadR);
        if (inbound >= 3) {
          this.ctx.strokeStyle = `rgba(${br},${bg},${bb},0.9)`; this.ctx.lineWidth = 2.2;
          this.ctx.beginPath(); this.ctx.arc(cx, cy, beadR, 0, Math.PI * 2); this.ctx.stroke();
        } else {
          this.ctx.strokeStyle = `rgba(${Math.max(0, br - 50)},${Math.max(0, bg - 50)},${Math.max(0, bb - 50)},0.6)`; this.ctx.lineWidth = 1;
          this.ctx.beginPath(); this.ctx.arc(cx, cy, beadR, 0, Math.PI * 2); this.ctx.stroke();
        }
        if (bead.node && this.hasExternalBecause(bead.node)) this.drawFringe(bead, cx, cy, beadR);
        this.ctx.globalAlpha = 1;
      }
    }
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: light a greyscale warp thread (column) per token by pre-placing
  // a ghost bead in the top row of that column so the grid feels alive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const col = h % COLS;
      const row = (h >> 4) % ROWS;
      if (!this.grid[row][col]) {
        this.grid[row][col] = {
          color: '#666055',
          topic: '__ghost__',
          node: null,
          dropY: row,
          targetRow: row,
          _ghost: true,
        };
      }
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    const pos = this.addBead(n);
    this.playBeadThump(n);
    if (pos) this.playIsorhythmPluck(n, pos.r);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.primePhase = false;
    this.downCell = null;
    this.primeTrail = [];
    this.primeDragging = false;
    this.rowSteps.clear();
    this.initGrid();
    this.redraw();
  }

  draw() {
    if (this.app.isPaused()) return;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const b = this.grid[r][c]; if (!b || b.dropY === undefined) continue;
      b.dropY += (b.targetRow - b.dropY) * 0.06;
      if (Math.abs(b.dropY - b.targetRow) < 0.05) b.dropY = b.targetRow;
    }
    this.redraw();
  }
}

export { LoomMode };

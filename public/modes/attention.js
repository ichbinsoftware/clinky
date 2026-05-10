import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, relGlyph } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

class AttentionMode extends Mode {
  isolated = null;
  primePhase = false;
  ghostCells = [];
  ghostFlashTimer = 0;
  ghostPulsePhase = 0;

  static GHOST_N = 6;
  static TOP_RESERVED = 100;
  static BOTTOM_RESERVED = 80;
  static STRIPE_HIT = 20;
  static BECAUSE_GREY = '#9ca3af';
  static FUGUE_SUBJECT = [0, 2, 4, 7];
  static FUGUE_STRIDE_MS = 180;

  constructor() {
    super({
      mode: 'attention',
      aesthetic: 'classical',
      topicFallbackColor: '#888',
      vars: {
        '--e-bg': '#0a0a18', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#aac8ff', '--e-pivot-tint': 'rgba(170,200,255,0.06)', '--e-accent': '#7a8acc',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const cell = this.hitMatrixCell(mx, my);
      const leftHit = this.hitLeftStripe(mx, my);
      const topHit = this.hitTopStripe(mx, my);
      if (cell) {
        const a = this.nodes[cell.row];
        showTooltip(e, a, this.topicInfo(a.topic).color);
        this.app.highlightLegendTopic(a.topic);
        this.canvas.style.cursor = 'pointer';
      } else if (leftHit !== null || topHit !== null) {
        const idx = leftHit !== null ? leftHit : topHit;
        const a = this.nodes[idx];
        showTooltip(e, a, this.topicInfo(a.topic).color);
        this.app.highlightLegendTopic(a.topic);
        this.canvas.style.cursor = 'pointer';
      } else {
        hideTooltip();
        this.app.highlightLegendTopic(null);
        this.canvas.style.cursor = 'crosshair';
      }
    });
    this.canvas.addEventListener('mouseleave', () => { this.canvas.style.cursor = 'crosshair'; });
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.primePhase) {
        const gh = this.hitGhostCell(mx, my);
        if (gh) this.flashCellAt(gh.row, gh.col);
        return;
      }
      const leftHit = this.hitLeftStripe(mx, my);
      const topHit = this.hitTopStripe(mx, my);
      if (leftHit !== null || topHit !== null) {
        const idx = leftHit !== null ? leftHit : topHit;
        if (this.isolated && this.isolated.kind === 'thought' && this.isolated.idx === idx) this.isolated = null;
        else this.isolated = { kind: 'thought', idx };
        return;
      }
      const cell = this.hitMatrixCell(mx, my);
      if (cell) {
        if (this.isolated && this.isolated.kind === 'pair' && this.isolated.row === cell.row && this.isolated.col === cell.col) {
          this.isolated = null;
        } else {
          this.isolated = { kind: 'pair', row: cell.row, col: cell.col };
        }
        return;
      }
      this.isolated = null;
    });
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('classical');
      pickSessionKey(this.app.prompt() || 'attention');
    });
  }

  scaleNote(degree) {
    const key = getSessionKey();
    const len = key.notes.length;
    const oct = Math.floor(degree / len) * 12;
    return key.notes[((degree % len) + len) % len] + oct;
  }

  fugueTransposition(voiceIdx) {
    if (voiceIdx === 0) return 12;
    if (voiceIdx === 1) return 19;
    if (voiceIdx === 2) return 24;
    // Cap at 36 semitones — beyond that frequencies exceed audible range on
    // sessions with many topics. Extra voices share the highest register.
    return Math.min(36, 24 + (voiceIdx - 2) * 12);
  }

  fugueVol(voiceIdx) { return Math.max(0.05, 0.10 - voiceIdx * 0.01); }

  playFugueEntry(voiceIdx) {
    const transp = this.fugueTransposition(voiceIdx);
    const vol = this.fugueVol(voiceIdx);
    AttentionMode.FUGUE_SUBJECT.forEach((deg, i) => {
      setTimeout(() => playSynth({ midi: this.scaleNote(deg) + transp, ...PRESETS.pluck, vol }), i * AttentionMode.FUGUE_STRIDE_MS);
    });
  }

  getCellRel(i, j) {
    if (i === j) return null;
    const a = this.nodes[i];
    const targetId = this.nodes[j].id;
    if (!a || targetId == null) return null;
    if (Array.isArray(a.refs) && a.refs.includes(targetId)) {
      return { rel: a.rel, stance: a.stance, heat: a.heat, kind: 'refs' };
    }
    if (Array.isArray(a.because)) {
      for (const b of a.because) {
        if (typeof b === 'number' && b === targetId) {
          return { rel: 'because', stance: a.stance, heat: a.heat, kind: 'because' };
        }
      }
    }
    return null;
  }

  nodeHasExternalBecause(i) {
    const a = this.nodes[i];
    return Array.isArray(a.because) && a.because.some(b => typeof b === 'string');
  }


  weight(i, j) {
    if (i === j) return 1;
    const a = this.nodes[i], b = this.nodes[j];
    let w = 0.06;
    if (a.topic === b.topic) w += 0.55 + a.confidence * 0.15;
    if (a.type === b.type) w += 0.2;
    const dt = Math.abs(i - j);
    if (dt <= 2) w += 0.18 * (1 - dt / 3);
    return Math.min(1, w);
  }

  matrixLayout() {
    const n = this.nodes.length;
    const availableH = Math.max(60, this.H - AttentionMode.TOP_RESERVED - AttentionMode.BOTTOM_RESERVED);
    const maxSize = Math.min(this.W - 120, availableH);
    const gridSize = Math.min(maxSize, n * 48);
    const cell = n > 0 ? gridSize / n : 0;
    const x0 = (this.W - gridSize) / 2;
    const y0 = AttentionMode.TOP_RESERVED + (availableH - gridSize) / 2;
    return { x0, y0, cell, gridSize, n };
  }

  initGhostCells() {
    this.ghostCells = [];
    for (let i = 0; i < AttentionMode.GHOST_N * AttentionMode.GHOST_N; i++) {
      this.ghostCells.push({ value: 0.3, alpha: 0, targetAlpha: 0 });
    }
  }

  flashGhostCell() {
    const idx = Math.floor(Math.random() * this.ghostCells.length);
    const c = this.ghostCells[idx];
    c.value = 0.2 + Math.random() * 0.8;
    c.alpha = 0.4 + Math.random() * 0.35;
    c.targetAlpha = 0;
  }

  startPrime() {
    this.primePhase = true;
    this.initGhostCells();
    this.ghostFlashTimer = 0;
    this.ghostPulsePhase = 0;
  }

  stopPrime() {
    this.primePhase = false;
    for (const c of this.ghostCells) c.targetAlpha = 0;
  }

  simulatePrime() {
    if (this.primePhase) {
      this.ghostPulsePhase += 0.022;
      this.ghostFlashTimer--;
      if (this.ghostFlashTimer <= 0) {
        const count = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < count; i++) this.flashGhostCell();
        this.ghostFlashTimer = 25 + Math.random() * 45;
      }
    }
    for (const c of this.ghostCells) {
      c.alpha += (c.targetAlpha - c.alpha) * 0.05;
    }
  }

  ghostLayout() {
    const availableH = Math.max(60, this.H - AttentionMode.TOP_RESERVED - AttentionMode.BOTTOM_RESERVED);
    const maxSize = Math.min(this.W - 120, availableH);
    const gridSize = Math.min(maxSize, AttentionMode.GHOST_N * 48);
    const cell = gridSize / AttentionMode.GHOST_N;
    return {
      x0: (this.W - gridSize) / 2,
      y0: AttentionMode.TOP_RESERVED + (availableH - gridSize) / 2,
      cell, gridSize,
    };
  }

  drawGhost() {
    if (this.ghostCells.length === 0) return;
    if (!this.primePhase && this.ghostCells.every(c => c.alpha < 0.01)) return;
    const L = this.ghostLayout();
    const pulse = 0.8 + (Math.sin(this.ghostPulsePhase) + 1) * 0.1;
    this.ctx.strokeStyle = `rgba(180, 200, 255, ${0.09 * pulse})`;
    this.ctx.lineWidth = 0.8;
    this.ctx.beginPath();
    for (let i = 0; i <= AttentionMode.GHOST_N; i++) {
      this.ctx.moveTo(L.x0, L.y0 + i * L.cell);
      this.ctx.lineTo(L.x0 + L.gridSize, L.y0 + i * L.cell);
      this.ctx.moveTo(L.x0 + i * L.cell, L.y0);
      this.ctx.lineTo(L.x0 + i * L.cell, L.y0 + L.gridSize);
    }
    this.ctx.stroke();
    for (let i = 0; i < this.ghostCells.length; i++) {
      const c = this.ghostCells[i];
      if (c.alpha < 0.01) continue;
      const row = Math.floor(i / AttentionMode.GHOST_N);
      const col = i % AttentionMode.GHOST_N;
      const v = Math.floor(c.value * 160);
      this.ctx.fillStyle = `rgba(${v + 40}, ${v + 60}, ${v + 100}, ${c.alpha * pulse})`;
      this.ctx.fillRect(L.x0 + col * L.cell, L.y0 + row * L.cell, L.cell - 0.5, L.cell - 0.5);
    }
    this.ctx.strokeStyle = `rgba(180, 200, 255, ${0.22 * pulse})`;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(L.x0 - 0.5, L.y0 - 0.5, L.gridSize, L.gridSize);
  }

  // Cathedral arch — vertical gradient (light ceiling fading to dark floor) plus
  // a soft radial glow above the top edge so light appears to crest through an
  // arch window overhead. Reading the matrix becomes "looking up."
  drawBackground() {
    const v = this.ctx.createLinearGradient(0, 0, 0, this.H);
    v.addColorStop(0, '#10122a');
    v.addColorStop(1, '#04040d');
    this.ctx.fillStyle = v;
    this.ctx.fillRect(0, 0, this.W, this.H);
    const cx = this.W / 2, cy = this.H * 0.05;
    const r = Math.max(this.W, this.H) * 0.55;
    const a = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    a.addColorStop(0, 'rgba(140, 150, 220, 0.10)');
    a.addColorStop(0.5, 'rgba(120, 130, 200, 0.04)');
    a.addColorStop(1, 'rgba(100, 110, 180, 0)');
    this.ctx.fillStyle = a;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  isInIsolation(i, j) {
    if (!this.isolated) return true;
    if (this.isolated.kind === 'pair') return i === this.isolated.row || j === this.isolated.col;
    return i === this.isolated.idx || j === this.isolated.idx;
  }

  drawV2Cell(i, j, info, L, dim) {
    const x = L.x0 + j * L.cell;
    const y = L.y0 + i * L.cell;
    const w = L.cell - 0.5;
    const baseHex = info.kind === 'because' ? AttentionMode.BECAUSE_GREY : this.topicInfo(this.nodes[i].topic).color;
    const [cr, cg, cb] = hexToRgb(baseHex);
    const heatMult = info.heat != null ? 0.55 + info.heat * 0.6 : 1;
    const stanceAlpha = info.stance === 'conceding' ? 0.45 : info.stance === 'questioning' ? 0.7 : 1;
    const alpha = dim * heatMult * stanceAlpha;
    const rgba = (a) => `rgba(${cr},${cg},${cb},${a})`;
    switch (info.rel) {
      case 'contradicts':
        this.ctx.fillStyle = rgba(alpha * 0.18); this.ctx.fillRect(x, y, w, w);
        this.ctx.strokeStyle = rgba(alpha); this.ctx.lineWidth = 0.7;
        this.ctx.beginPath();
        for (let k = -w; k < w; k += 3) { this.ctx.moveTo(x + k, y); this.ctx.lineTo(x + k + w, y + w); }
        this.ctx.stroke();
        break;
      case 'questions':
        this.ctx.strokeStyle = rgba(alpha); this.ctx.lineWidth = 1.1;
        this.ctx.strokeRect(x + 1, y + 1, w - 2, w - 2);
        break;
      case 'supersedes':
        this.ctx.fillStyle = rgba(alpha * 0.4); this.ctx.fillRect(x, y, w, w);
        this.ctx.strokeStyle = rgba(alpha); this.ctx.lineWidth = 1.1;
        this.ctx.beginPath();
        this.ctx.moveTo(x + 2, y + 2); this.ctx.lineTo(x + w - 2, y + w - 2);
        this.ctx.moveTo(x + 2, y + w - 2); this.ctx.lineTo(x + w - 2, y + 2);
        this.ctx.stroke();
        break;
      case 'refines': {
        const grad = this.ctx.createLinearGradient(x, y, x + w, y);
        grad.addColorStop(0, rgba(alpha * 0.85)); grad.addColorStop(1, rgba(alpha * 0.2));
        this.ctx.fillStyle = grad; this.ctx.fillRect(x, y, w, w);
        break;
      }
      case 'synthesizes':
        this.ctx.fillStyle = rgba(alpha); this.ctx.fillRect(x, y, w, w);
        this.ctx.strokeStyle = rgba(alpha * 0.6); this.ctx.lineWidth = 0.5;
        this.ctx.strokeRect(x + 1, y + 1, w - 2, w - 2);
        break;
      case 'because':
        this.ctx.fillStyle = rgba(alpha * 0.55); this.ctx.fillRect(x, y, w, w);
        break;
      case 'supports':
      default:
        if (info.stance === 'exploring') {
          this.ctx.fillStyle = rgba(alpha);
          for (let dx = 1; dx < w; dx += 3) for (let dy = 1; dy < w; dy += 3) this.ctx.fillRect(x + dx, y + dy, 1, 1);
        } else {
          this.ctx.fillStyle = rgba(alpha); this.ctx.fillRect(x, y, w, w);
        }
        break;
    }
    if (info.kind === 'refs' && L.cell >= 12) {
      const glyph = relGlyph(info.rel);
      if (glyph) {
        const fontSize = Math.max(7, Math.min(10, L.cell * 0.33));
        this.ctx.font = `700 ${fontSize}px 'JetBrains Mono', monospace`;
        const luma = (0.299 * cr + 0.587 * cg + 0.114 * cb) / 255;
        this.ctx.fillStyle = luma > 0.55 ? `rgba(10, 10, 24, ${Math.min(1, alpha + 0.25)})` : `rgba(255, 248, 230, ${Math.min(1, alpha + 0.25)})`;
        this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
        this.ctx.fillText(glyph, x + 2.5, y + 2);
      }
    }
  }

  drawBatchBlocks(L) {
    this.ctx.strokeStyle = 'rgba(180, 200, 255, 0.18)'; this.ctx.lineWidth = 1;
    for (let i = 1; i < L.n; i++) {
      if (this.nodes[i].batch_id == null || this.nodes[i].batch_id === this.nodes[i - 1].batch_id) continue;
      this.ctx.beginPath();
      this.ctx.moveTo(L.x0, L.y0 + i * L.cell); this.ctx.lineTo(L.x0 + L.gridSize, L.y0 + i * L.cell);
      this.ctx.moveTo(L.x0 + i * L.cell, L.y0); this.ctx.lineTo(L.x0 + i * L.cell, L.y0 + L.gridSize);
      this.ctx.stroke();
    }
  }

  drawExternalStrip(L) {
    const stripY = L.y0 - 18, stripH = 5;
    this.ctx.font = "9px 'JetBrains Mono', monospace";
    this.ctx.fillStyle = 'rgba(200, 210, 230, 0.55)';
    this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'middle';
    this.ctx.fillText('ext ↗', L.x0 - 8, stripY + stripH / 2);
    for (let j = 0; j < L.n; j++) {
      if (!this.nodeHasExternalBecause(j)) continue;
      this.ctx.fillStyle = 'rgba(225, 220, 205, 0.78)';
      this.ctx.fillRect(L.x0 + j * L.cell + 1, stripY, L.cell - 2.5, stripH);
    }
  }

  drawMatrix() {
    const L = this.matrixLayout();
    if (L.n === 0) return;
    const ht = this.app.highlightedTopic;
    const v2 = this.sessionHasRefs();
    for (let i = 0; i < L.n; i++) {
      for (let j = 0; j < L.n; j++) {
        const w = this.weight(i, j);
        const [ra, ga, ba] = hexToRgb(this.topicInfo(this.nodes[i].topic).color);
        const [rb, gb, bb] = hexToRgb(this.topicInfo(this.nodes[j].topic).color);
        const r = (ra + rb) / 2, g = (ga + gb) / 2, b = (ba + bb) / 2;
        const rowTopic = this.nodes[i].topic, colTopic = this.nodes[j].topic;
        const legendDim = ht && rowTopic !== ht && colTopic !== ht ? 0.25 : 1;
        const dim = (this.isInIsolation(i, j) ? 1 : 0.15) * legendDim;
        const alpha = (0.05 + w * 0.85) * dim;
        this.ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        this.ctx.fillRect(L.x0 + j * L.cell, L.y0 + i * L.cell, L.cell - 0.5, L.cell - 0.5);
      }
    }
    if (v2) {
      for (let i = 0; i < L.n; i++) {
        for (let j = 0; j < L.n; j++) {
          if (i === j) continue;
          const dim = this.isInIsolation(i, j) ? 1 : 0.15;
          const cellInfo = this.getCellRel(i, j);
          if (cellInfo) this.drawV2Cell(i, j, cellInfo, L, dim);
        }
      }
      this.drawBatchBlocks(L);
    }
    const strip = 3;
    for (let i = 0; i < L.n; i++) {
      const [r, g, b] = hexToRgb(this.topicInfo(this.nodes[i].topic).color);
      const stripLegendDim = ht && this.nodes[i].topic !== ht ? 0.25 : 1;
      let stripAlpha = 0.95 * stripLegendDim;
      if (this.isolated) {
        const focused = this.isolated.kind === 'pair' ? (i === this.isolated.row || i === this.isolated.col) : (i === this.isolated.idx);
        stripAlpha = (focused ? 1 : 0.25) * stripLegendDim;
      }
      const incBoost = v2 ? Math.min(4, this.nodeIncoming(this.nodes[i]?.id) * 0.7) : 0;
      const thick = strip + incBoost;
      this.ctx.fillStyle = `rgba(${r},${g},${b},${stripAlpha})`;
      this.ctx.fillRect(L.x0 - thick - 4, L.y0 + i * L.cell, thick, L.cell - 0.5);
      this.ctx.fillRect(L.x0 + i * L.cell, L.y0 - thick - 4, L.cell - 0.5, thick);
    }
    if (v2) this.drawExternalStrip(L);
    if (this.isolated && this.isolated.kind === 'pair') {
      this.ctx.strokeStyle = 'rgba(255,255,255,0.65)'; this.ctx.lineWidth = 1.2;
      this.ctx.strokeRect(L.x0 + this.isolated.col * L.cell - 0.5, L.y0 + this.isolated.row * L.cell - 0.5, L.cell, L.cell);
    }
    this.ctx.strokeStyle = 'rgba(255,255,255,0.08)'; this.ctx.lineWidth = 1;
    this.ctx.strokeRect(L.x0 - 0.5, L.y0 - 0.5, L.gridSize, L.gridSize);
  }

  hitMatrixCell(mx, my) {
    const L = this.matrixLayout();
    if (L.n === 0) return null;
    if (mx < L.x0 || mx > L.x0 + L.gridSize || my < L.y0 || my > L.y0 + L.gridSize) return null;
    const col = Math.floor((mx - L.x0) / L.cell);
    const row = Math.floor((my - L.y0) / L.cell);
    if (row < 0 || row >= L.n || col < 0 || col >= L.n) return null;
    return { row, col };
  }

  hitLeftStripe(mx, my) {
    const L = this.matrixLayout();
    if (L.n === 0) return null;
    if (mx >= L.x0 - AttentionMode.STRIPE_HIT && mx < L.x0 && my >= L.y0 && my <= L.y0 + L.gridSize) {
      const idx = Math.floor((my - L.y0) / L.cell);
      if (idx >= 0 && idx < L.n) return idx;
    }
    return null;
  }

  hitTopStripe(mx, my) {
    const L = this.matrixLayout();
    if (L.n === 0) return null;
    if (my >= L.y0 - AttentionMode.STRIPE_HIT && my < L.y0 && mx >= L.x0 && mx <= L.x0 + L.gridSize) {
      const idx = Math.floor((mx - L.x0) / L.cell);
      if (idx >= 0 && idx < L.n) return idx;
    }
    return null;
  }

  hitGhostCell(mx, my) {
    const L = this.ghostLayout();
    if (mx < L.x0 || mx > L.x0 + L.gridSize || my < L.y0 || my > L.y0 + L.gridSize) return null;
    const col = Math.floor((mx - L.x0) / L.cell);
    const row = Math.floor((my - L.y0) / L.cell);
    if (row < 0 || row >= AttentionMode.GHOST_N || col < 0 || col >= AttentionMode.GHOST_N) return null;
    return { row, col };
  }

  flashCellAt(row, col) {
    const idx = row * AttentionMode.GHOST_N + col;
    const c = this.ghostCells[idx];
    if (!c) return;
    c.value = 0.6 + Math.random() * 0.4;
    c.alpha = 0.75 + Math.random() * 0.2;
    c.targetAlpha = 0;
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: light up one self-cell per token in the ghost matrix
  // using a hashed row+col so the same prompt → the same lit pattern.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const N = AttentionMode.GHOST_N;
      const row = h % N;
      const col = (h >> 4) % N;
      const idx = row * N + col;
      const c = this.ghostCells[idx];
      if (c) {
        c.value = 0.25 + 0.3 * ((h >> 8) % 100) / 100;
        c.alpha = 0.45;
        c.targetAlpha = 0;
      }
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    const voiceIdx = this.topics.findIndex(t => t.id === n.topic);
    if (voiceIdx >= 0) this.playFugueEntry(voiceIdx);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.ghostCells = [];
    this.primePhase = false;
    this.isolated = null;
    this.incomingRefsMap = {};
    this.canvas.style.cursor = 'crosshair';
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime();
    this.drawBackground();
    this.drawGhost();
    this.drawMatrix();
  }
}

export { AttentionMode };

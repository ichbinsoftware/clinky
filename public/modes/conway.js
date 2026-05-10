import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey } from '/synth.js';

const COLS = 160, ROWS = 90;
const GHOST_COLOR = '#6a6a6a';
const FADE_LERP = 0.4;
const ALIVE_ALPHA = 0.8;

const PATTERNS = {
  claim: [[0,1],[1,0],[1,1],[1,2],[2,0]],
  branch: [[0,0],[0,1],[0,2],[1,0],[2,1]],
  choice: [[0,0],[0,1],[1,0],[1,1]],
  'dead-end': [[0,0],[0,1],[0,2]],
  aside: [[0,1],[1,0],[1,2],[2,1]],
  resolution: [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[0,7],[0,8],[0,9]],
};

const STANCE_PATTERNS = {
  claiming:    [[0,0],[0,1],[1,0],[1,1]],
  exploring:   [[0,1],[1,2],[2,0],[2,1],[2,2]],
  questioning: [[0,0],[0,1],[0,2]],
  conceding:   [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6]],
};

const PIVOT_PATTERNS = [
  [[0,1],[0,2],[1,0],[1,3],[2,1],[2,2]],
  [[0,1],[0,2],[0,3],[1,0],[1,1],[1,2]],
  [[0,1],[0,2],[1,0],[1,3],[2,1],[2,3],[3,2]],
];

const GHOST_PATTERNS = [[[0,0]],[[0,0]],[[0,0],[0,1],[0,2]],[[0,1],[1,2],[2,0],[2,1],[2,2]]];

class ConwayMode extends Mode {
  grid = [];
  colors = [];
  fadeAlpha = [];
  fadeColor = [];
  primePhase = false;
  ghostCursor = null;
  hoverCell = null;
  pulseCounter = 0;
  lastMask = -1;
  frame = 0;

  constructor() {
    super({
      mode: 'conway',
      aesthetic: 'industrial',
      topicFallbackColor: '#2a9d8f',
      vars: {
        '--e-bg': '#ffffff', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#1a4a8a', '--e-pivot-tint': 'rgba(45,210,192,0.10)', '--e-accent': '#2dd2c0',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.initGrid();

    this.canvas.addEventListener('mouseleave', () => { this.hoverCell = null; });
    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      this.hoverCell = this.pxToCell(mx, my);
      const gc = Math.floor(mx / (this.W / COLS)), gr = Math.floor(my / (this.H / ROWS));
      let closest = null, cd = 20;
      this.nodes.forEach(n => { if (n._ox === undefined) return; const d = Math.hypot(n._ox - gc, n._oy - gr); if (d < cd) { cd = d; closest = n; } });
      if (closest) { showTooltip(e, closest, this.topicInfo(closest.topic).color); this.app.highlightLegendTopic(closest.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('click', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const cell = this.pxToCell(mx, my);
      if (!cell) return;
      if (this.primePhase) { this.dropGhostSeed(cell.c, cell.r); return; }
      if (this.grid[cell.r][cell.c]) { this.grid[cell.r][cell.c] = 0; this.colors[cell.r][cell.c] = null; }
      else {
        this.grid[cell.r][cell.c] = 1;
        const recentTopic = this.nodes.length > 0 ? this.topicInfo(this.nodes[this.nodes.length - 1].topic).color : '#888';
        this.colors[cell.r][cell.c] = recentTopic;
      }
    });
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('industrial');
      pickSessionKey(this.app.prompt() || 'conway');
    });
  }

  pianoVoice(midi, vol = 0.07, dur = 0.40) {
    playSynth({ midi, wave: 'triangle', voices: 2, detune: 4, attack: 0.045, decay: 0.55, sustain: 0.0, release: 0.80, duration: dur, vol, filter: { type: 'lowpass', freq: 1300, Q: 0.7 }, distortion: { drive: 0.08, tone: 'warm', mix: 0.18 }, reverbSend: 0.50, delaySend: 0.18 });
  }

  gridMask() {
    let mask = 0;
    const regH = ROWS / 3, regW = COLS / 4;
    for (let i = 0; i < 12; i++) {
      const ry = Math.floor(i / 4), rx = i % 4;
      const r0 = Math.floor(ry * regH), r1 = Math.floor((ry + 1) * regH);
      const c0 = Math.floor(rx * regW), c1 = Math.floor((rx + 1) * regW);
      let any = 0;
      outer: for (let r = r0; r < r1; r++) { for (let c = c0; c < c1; c++) { if (this.grid[r][c]) { any = 1; break outer; } } }
      if (any) mask |= (1 << i);
    }
    return mask;
  }

  clusterFromMask(mask) {
    const pitches = [];
    for (let i = 0; i < 12 && pitches.length < 5; i++) { if (mask & (1 << i)) pitches.push(i); }
    return pitches;
  }

  pianoCluster(mask, rootMidi = 60, vol = 0.07) {
    const offsets = this.clusterFromMask(mask);
    if (offsets.length === 0) return;
    offsets.forEach(d => this.pianoVoice(rootMidi + d, vol, 0.45));
  }

  aliveCount() {
    let n = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (this.grid[r][c]) n++;
    return n;
  }

  maybePulseCluster() {
    if (!this.auralInit) return;
    const total = ROWS * COLS;
    const ratio = this.aliveCount() / total;
    if (ratio < 0.001) { this.pulseCounter = 0; return; }
    const interval = Math.max(6, Math.round(32 - ratio * 520));
    this.pulseCounter++;
    if (this.pulseCounter < interval) return;
    this.pulseCounter = 0;
    const mask = this.gridMask();
    const vol = 0.05 + Math.min(0.05, ratio * 1.0);
    this.pianoCluster(mask, 60, vol);
    this.lastMask = mask;
  }

  initGrid() {
    this.grid = []; this.colors = []; this.fadeAlpha = []; this.fadeColor = [];
    for (let r = 0; r < ROWS; r++) {
      this.grid.push(new Uint8Array(COLS));
      this.colors.push(new Array(COLS).fill(null));
      this.fadeAlpha.push(new Float32Array(COLS));
      this.fadeColor.push(new Array(COLS).fill(null));
    }
  }

  pxToCell(mx, my) {
    const c = Math.floor(mx / (this.W / COLS));
    const r = Math.floor(my / (this.H / ROWS));
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
    return { r, c };
  }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.nodes);
  }

  hasExternalBecause(n) {
    const b = n && n.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  findNodeById(id) { return this.nodes.find(n => n.id === id); }

  dominantRel(n) {
    if (!n || !Array.isArray(n.rel)) return null;
    const counts = {};
    for (const r of n.rel) counts[r] = (counts[r] || 0) + 1;
    let best = null, bestN = 0;
    for (const [k, v] of Object.entries(counts)) if (v > bestN) { bestN = v; best = k; }
    return best;
  }

  seedPattern(node, atOx, atOy) {
    const info = this.topicInfo(node.topic);
    const inbound = this.nodeIncoming(node.id);
    const stance = node && node.stance;
    let pattern;
    if (inbound >= 3) { const idx = Math.abs((node.id || 0)) % PIVOT_PATTERNS.length; pattern = PIVOT_PATTERNS[idx]; }
    else pattern = PATTERNS[node.type] || PATTERNS.claim;

    let ox, oy;
    if (atOx !== undefined && atOy !== undefined) { ox = atOx; oy = atOy; }
    else {
      const rel = this.dominantRel(node);
      const refTarget = Array.isArray(node.refs) && node.refs.length > 0 ? this.findNodeById(node.refs[0]) : null;
      const refHasPos = refTarget && refTarget._ox !== undefined;
      if (refHasPos && (rel === 'supports' || rel === 'refines' || rel === 'synthesizes')) {
        const offset = rel === 'synthesizes' ? 4 : 7;
        const angle = Math.random() * Math.PI * 2;
        ox = Math.round(refTarget._ox + Math.cos(angle) * offset);
        oy = Math.round(refTarget._oy + Math.sin(angle) * offset);
      } else if (refHasPos && rel === 'contradicts') {
        const dx = refTarget._ox - COLS / 2, dy = refTarget._oy - ROWS / 2;
        ox = Math.round(COLS / 2 - dx + (Math.random() - 0.5) * 20);
        oy = Math.round(ROWS / 2 - dy + (Math.random() - 0.5) * 14);
      } else if (this.hasExternalBecause(node)) {
        const edge = Math.floor(Math.random() * 4);
        if (edge === 0) { ox = 3 + Math.floor(Math.random() * 6); oy = 10 + Math.floor(Math.random() * (ROWS - 20)); }
        else if (edge === 1) { ox = COLS - 10 - Math.floor(Math.random() * 6); oy = 10 + Math.floor(Math.random() * (ROWS - 20)); }
        else if (edge === 2) { oy = 3 + Math.floor(Math.random() * 6); ox = 10 + Math.floor(Math.random() * (COLS - 20)); }
        else { oy = ROWS - 10 - Math.floor(Math.random() * 6); ox = 10 + Math.floor(Math.random() * (COLS - 20)); }
      } else { ox = Math.floor(Math.random() * (COLS - 20)) + 10; oy = Math.floor(Math.random() * (ROWS - 20)) + 10; }
      ox = Math.max(2, Math.min(COLS - 12, ox));
      oy = Math.max(2, Math.min(ROWS - 12, oy));
    }

    pattern.forEach(([dr, dc]) => {
      const r = oy + dr, c = ox + dc;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) { this.grid[r][c] = 1; this.colors[r][c] = info.color; }
    });

    if (inbound < 3 && stance && STANCE_PATTERNS[stance]) {
      const sp = STANCE_PATTERNS[stance];
      const angle = Math.random() * Math.PI * 2;
      const dist = 6 + Math.floor(Math.random() * 3);
      const sox = Math.max(2, Math.min(COLS - 12, Math.round(ox + Math.cos(angle) * dist)));
      const soy = Math.max(2, Math.min(ROWS - 12, Math.round(oy + Math.sin(angle) * dist)));
      sp.forEach(([dr, dc]) => {
        const r = soy + dr, c = sox + dc;
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS && !this.grid[r][c]) { this.grid[r][c] = 1; this.colors[r][c] = info.color; }
      });
    }

    const heat = (typeof node.heat === 'number') ? node.heat : 0;
    const extras = Math.round(heat * 8);
    for (let i = 0; i < extras; i++) {
      const dr = Math.floor((Math.random() - 0.5) * 14);
      const dc = Math.floor((Math.random() - 0.5) * 14);
      const r = oy + dr, c = ox + dc;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS && !this.grid[r][c]) { this.grid[r][c] = 1; this.colors[r][c] = info.color; }
    }

    node._ox = ox; node._oy = oy;
  }

  dropGhostSeed(ox, oy) {
    const pattern = GHOST_PATTERNS[Math.floor(Math.random() * GHOST_PATTERNS.length)];
    pattern.forEach(([dr, dc]) => {
      const r = oy + dr, c = ox + dc;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) { this.grid[r][c] = 1; this.colors[r][c] = GHOST_COLOR; }
    });
  }

  startPrime() {
    this.primePhase = true;
    this.ghostCursor = { x: COLS / 2 + (Math.random() - 0.5) * 30, y: ROWS / 2 + (Math.random() - 0.5) * 20, vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, alpha: 0, targetAlpha: 0.75, seedTimer: 40 };
  }

  stopPrime() {
    this.primePhase = false;
    if (this.ghostCursor) this.ghostCursor.targetAlpha = 0;
  }

  simulatePrime() {
    if (!this.ghostCursor) return;
    const gc = this.ghostCursor;
    gc.alpha += (gc.targetAlpha - gc.alpha) * 0.06;
    gc.vx += (Math.random() - 0.5) * 0.02; gc.vy += (Math.random() - 0.5) * 0.02;
    const sp = Math.hypot(gc.vx, gc.vy);
    if (sp > 0.5) { gc.vx = gc.vx / sp * 0.5; gc.vy = gc.vy / sp * 0.5; }
    gc.x += gc.vx; gc.y += gc.vy;
    const m = 8;
    if (gc.x < m) { gc.x = m; gc.vx *= -0.6; }
    if (gc.x > COLS - m) { gc.x = COLS - m; gc.vx *= -0.6; }
    if (gc.y < m) { gc.y = m; gc.vy *= -0.6; }
    if (gc.y > ROWS - m) { gc.y = ROWS - m; gc.vy *= -0.6; }
    if (this.primePhase) {
      gc.seedTimer--;
      if (gc.seedTimer <= 0) { this.dropGhostSeed(Math.round(gc.x), Math.round(gc.y)); gc.seedTimer = 60 + Math.floor(Math.random() * 60); }
    }
    if (gc.targetAlpha === 0 && gc.alpha < 0.01) this.ghostCursor = null;
  }

  step() {
    const next = [], nextColors = [];
    for (let r = 0; r < ROWS; r++) { next.push(new Uint8Array(COLS)); nextColors.push(new Array(COLS).fill(null)); }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let n = 0, colorVotes = {}, hasColouredNeighbour = false;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = (r + dr + ROWS) % ROWS, nc = (c + dc + COLS) % COLS;
          if (this.grid[nr][nc]) {
            n++;
            const col = this.colors[nr][nc] || '#2a9d8f';
            colorVotes[col] = (colorVotes[col] || 0) + 1;
            if (col !== GHOST_COLOR) hasColouredNeighbour = true;
          }
        }
        const isGhost = this.grid[r][c] && this.colors[r][c] === GHOST_COLOR;
        if (isGhost && hasColouredNeighbour) { next[r][c] = 0; continue; }
        next[r][c] = this.grid[r][c] ? ((n === 2 || n === 3) ? 1 : 0) : (n === 3 ? 1 : 0);
        if (next[r][c]) {
          if (this.grid[r][c] && this.colors[r][c]) nextColors[r][c] = this.colors[r][c];
          else {
            let bestCol = null, bestColN = 0, bestGhost = null, bestGhostN = 0;
            Object.entries(colorVotes).forEach(([col, cnt]) => {
              if (col === GHOST_COLOR) { if (cnt > bestGhostN) { bestGhostN = cnt; bestGhost = col; } }
              else { if (cnt > bestColN) { bestColN = cnt; bestCol = col; } }
            });
            nextColors[r][c] = bestCol || bestGhost;
          }
        }
      }
    }
    this.grid = next; this.colors = nextColors;
  }

  drawHoverNeighbourhood() {
    if (!this.hoverCell) return;
    const { r, c } = this.hoverCell;
    if (!this.grid[r] || !this.grid[r][c]) return;
    const cw = this.W / COLS, ch = this.H / ROWS;
    this.ctx.strokeStyle = 'rgba(220,220,230,0.45)'; this.ctx.lineWidth = 1;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = (r + dr + ROWS) % ROWS, nc = (c + dc + COLS) % COLS;
        this.ctx.strokeRect(nc * cw + 0.5, nr * ch + 0.5, cw - 1, ch - 1);
      }
    }
    this.ctx.strokeStyle = 'rgba(255,255,255,0.8)'; this.ctx.lineWidth = 1.5;
    this.ctx.strokeRect(c * cw + 0.5, r * ch + 0.5, cw - 1, ch - 1);
  }

  drawGhostCursor() {
    if (!this.ghostCursor || this.ghostCursor.alpha < 0.01) return;
    const cw = this.W / COLS, ch = this.H / ROWS;
    const x = this.ghostCursor.x * cw + cw / 2;
    const y = this.ghostCursor.y * ch + ch / 2;
    this.ctx.fillStyle = `rgba(210,210,230,${this.ghostCursor.alpha * 0.5})`;
    this.ctx.beginPath(); this.ctx.arc(x, y, 4, 0, Math.PI * 2); this.ctx.fill();
    this.ctx.strokeStyle = `rgba(210,210,230,${this.ghostCursor.alpha * 0.3})`; this.ctx.lineWidth = 1;
    this.ctx.beginPath(); this.ctx.arc(x, y, 8, 0, Math.PI * 2); this.ctx.stroke();
  }

  onStart() {
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: seed one ghost pattern per token at a hashed grid position.
  // Uses existing GHOST_PATTERNS so the cells are coloured GHOST_COLOR and will
  // be displaced by real nodes when they arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const ox = 5 + (h % (COLS - 10));
      const oy = 5 + ((h >> 5) % (ROWS - 10));
      const patIdx = (h >> 10) % GHOST_PATTERNS.length;
      const pattern = GHOST_PATTERNS[patIdx];
      pattern.forEach(([dr, dc]) => {
        const r = oy + dr, c = ox + dc;
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
          this.grid[r][c] = 1;
          this.colors[r][c] = GHOST_COLOR;
        }
      });
    }
  }

  onNode(n) {
    if (this.primePhase && this.ghostCursor) {
      this.seedPattern(n, Math.round(this.ghostCursor.x), Math.round(this.ghostCursor.y));
      this.stopPrime();
    } else {
      this.seedPattern(n);
    }
    this.initAural();
    this.pianoCluster(this.gridMask(), 60, 0.09);
    this.pulseCounter = 0;
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.ghostCursor = null;
    this.hoverCell = null;
    this.primePhase = false;
    this.initGrid();
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime();
    if (this.frame % 3 === 0) { this.step(); this.maybePulseCluster(); }
    this.frame++;
    const ht = this.app.highlightedTopic;
    const htColor = ht ? this.topicInfo(ht).color : null;
    const w = this.W, h = this.H, cw = w / COLS, ch = h / ROWS;
    this.ctx.fillStyle = '#181a1c'; this.ctx.fillRect(0, 0, w, h);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const alive = this.grid[r][c];
      if (alive) this.fadeColor[r][c] = this.colors[r][c] || this.fadeColor[r][c] || '#2a9d8f';
      const target = alive ? ALIVE_ALPHA : 0;
      this.fadeAlpha[r][c] += (target - this.fadeAlpha[r][c]) * FADE_LERP;
      if (this.fadeAlpha[r][c] < 0.02) { this.fadeAlpha[r][c] = 0; continue; }
      const cellColor = this.fadeColor[r][c] || '#2a9d8f';
      const dim = htColor && cellColor !== GHOST_COLOR ? (cellColor !== htColor ? 0.25 : 1) : 1;
      this.ctx.fillStyle = cellColor;
      this.ctx.globalAlpha = this.fadeAlpha[r][c] * dim;
      this.ctx.fillRect(c * cw, r * ch, cw - 0.5, ch - 0.5);
    }
    this.ctx.globalAlpha = 1;
    this.drawHoverNeighbourhood();
    this.drawGhostCursor();
    // Petri dish — radial vignette so cells at the rim dim and the colony reads as contained.
    const vg = this.ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.85)');
    this.ctx.fillStyle = vg;
    this.ctx.fillRect(0, 0, w, h);
  }
}

export { ConwayMode };

import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, relColor } from '/clinky.js';
import { playSynth, playChord, midiToFreq, PRESETS, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

const QUAD_LABELS = ['MAJOR PROJECTS', 'QUICK WINS', 'MONEY PITS', 'FILL-INS'];
const QUADRANT_BASE = { 0: 12, 1: 19, 2: 0, 3: 7 };
const QUARTAL_INTERVALS = [0, 5, 10, 15];
const XH_MOVE_FRAMES = 42, XH_STOP_FRAMES = 22;

class MatrixMode extends Mode {
  primePhase = false;
  xhPath = [];
  xhIdx = 0;
  xhFromPos = { x: 0, y: 0 };
  xhToPos = { x: 0, y: 0 };
  xhPos = { x: 0, y: 0 };
  xhPhase = 0;
  xhStopTimer = 0;
  droppedDots = [];
  plotRevealAlpha = 1.0;
  threadFocus = null;
  quadLock = null;
  hoverQuad = null;
  cursorPos = null;
  cursorInPlot = false;
  cursorOverInteractive = false;
  nodeBorn = new Map();

  constructor() {
    super({
      mode: 'matrix',
      aesthetic: 'classical',
      topicFallbackColor: '#003049',
      vars: {
        '--e-bg': '#fafafa', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#0a4a8a', '--e-pivot-tint': 'rgba(10,74,138,0.08)', '--e-accent': '#0a4a8a',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      this.cursorPos = { x: e.clientX, y: e.clientY };
      this.cursorInPlot = this.inPlotArea(e.clientX, e.clientY);
      if (this.primePhase) { this.canvas.style.cursor = 'default'; return; }
      const dot = this.dotHitTest(e.clientX, e.clientY);
      const lbl = this.quadLabelHitTest(e.clientX, e.clientY);
      this.cursorOverInteractive = !!(dot || lbl);
      this.hoverQuad = lbl;
      if (dot) { showTooltip(e, dot, this.topicInfo(dot.topic).color); this.app.highlightLegendTopic(dot.topic); this.canvas.style.cursor = 'pointer'; }
      else if (lbl !== null) { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'pointer'; }
      else if (this.cursorInPlot) { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'pointer'; }
      else { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'default'; }
    });
    this.canvas.addEventListener('mouseleave', () => { this.cursorInPlot = false; this.cursorPos = null; this.hoverQuad = null; this.cursorOverInteractive = false; });
    this.canvas.addEventListener('click', e => {
      if (this.primePhase) return;
      const dot = this.dotHitTest(e.clientX, e.clientY);
      if (dot) { this.threadFocus = (this.threadFocus === dot) ? null : dot; this.quadLock = null; return; }
      const lbl = this.quadLabelHitTest(e.clientX, e.clientY);
      if (lbl !== null) { this.quadLock = (this.quadLock === lbl) ? null : lbl; this.threadFocus = null; return; }
      const qArea = this.quadAreaHitTest(e.clientX, e.clientY);
      if (qArea !== null) { this.quadLock = (this.quadLock === qArea) ? null : qArea; this.threadFocus = null; return; }
      this.threadFocus = null; this.quadLock = null;
    });
  }

  nodeIncoming(id) { if (id == null) return 0; return this.incomingRefsMap[id] != null ? this.incomingRefsMap[id] : incomingRefsOf(id, this.nodes); }
  hasExternalBecause(n) { const b = n && n.because; return Array.isArray(b) && b.some(x => typeof x === 'string'); }
  nodeById(id) { for (const n of this.nodes) if (n.id === id) return n; return null; }

  sideBuffer() {
    const el = document.querySelector('.topic-legend');
    if (!el) return 40;
    const rect = el.getBoundingClientRect();
    return Math.max(40, window.innerWidth - rect.left + 12);
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('classical');
      pickSessionKey(this.app.prompt() || 'matrix');
    });
  }

  impactFor(n) {
    const m = { resolution: 0.95, choice: 0.75, claim: 0.65, branch: 0.45, aside: 0.25, 'dead-end': 0.15 };
    return m[n.type] ?? 0.5;
  }

  hashSeed(id) { const s = String(id ?? 'x'); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
  pseudoRand(seed, k) { const x = Math.sin(seed * 9301.0 + k * 49297.0) * 233280.0; return x - Math.floor(x); }

  quadrantOf(node) {
    const conf = node.confidence ?? 0.7, imp = this.impactFor(node);
    const confHi = conf >= 0.5, impHi = imp >= 0.5;
    if (impHi && !confHi) return 0; if (impHi && confHi) return 1; if (!impHi && !confHi) return 2; return 3;
  }

  playQuartalCluster(node) {
    const q = this.quadrantOf(node);
    const root = getSessionKey().rootMidi + (QUADRANT_BASE[q] ?? 12);
    const midis = QUARTAL_INTERVALS.map(d => root + d);
    playChord(midis.map(midiToFreq), { ...PRESETS.pad, duration: 1.6, vol: 0.10, reverbSend: 0.45 });
  }

  computeLayout() {
    const pad = Math.max(110, this.sideBuffer());
    const plot = { x: pad, y: 110, w: this.W - pad * 2, h: this.H - 110 - 90 };
    const positions = new Map();
    const GRID = 30, JITTER = 60;
    const used = new Set();
    this.nodes.forEach(n => {
      const cx = plot.x + (n.confidence || 0.7) * plot.w;
      const cy = plot.y + (1 - this.impactFor(n)) * plot.h;
      const seed = this.hashSeed(n.id);
      let ox = 0, oy = 0, tries = 0;
      while (tries < 24) {
        const k = `${Math.round((cx + ox) / GRID)}:${Math.round((cy + oy) / GRID)}`;
        if (!used.has(k)) { used.add(k); break; }
        ox = (this.pseudoRand(seed, tries * 2) - 0.5) * JITTER;
        oy = (this.pseudoRand(seed, tries * 2 + 1) - 0.5) * JITTER;
        tries++;
      }
      const inbound = this.nodeIncoming(n.id);
      const pivotScale = inbound >= 3 ? 1 + Math.min(inbound - 2, 5) * 0.14 : 1;
      const baseR = 11 + (n.confidence || 0.7) * 4;
      positions.set(n, { x: cx + ox, y: cy + oy, r: baseR * pivotScale, pivotScale, inbound });
    });
    return { plot, positions };
  }

  planCrosshairPath() {
    const { plot } = this.computeLayout();
    const pts = [];
    const cols = 6, rows = 3;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const baseX = plot.x + (c + 0.5) / cols * plot.w, baseY = plot.y + (r + 0.5) / rows * plot.h;
        pts.push({ x: baseX + (Math.random() - 0.5) * (plot.w / cols) * 0.55, y: baseY + (Math.random() - 0.5) * (plot.h / rows) * 0.55 });
      }
    }
    for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
    return pts;
  }

  confFromX(x) { const { plot } = this.computeLayout(); return Math.max(0, Math.min(1, (x - plot.x) / plot.w)); }
  impFromY(y) { const { plot } = this.computeLayout(); return Math.max(0, Math.min(1, 1 - (y - plot.y) / plot.h)); }

  startPrime() {
    this.primePhase = true;
    this.xhPath = this.planCrosshairPath(); this.xhIdx = 0; this.xhPhase = 0; this.xhStopTimer = 0; this.droppedDots = [];
    if (this.xhPath.length > 0) { this.xhFromPos = { ...this.xhPath[0] }; this.xhToPos = { ...this.xhPath[Math.min(1, this.xhPath.length - 1)] }; this.xhPos = { ...this.xhFromPos }; }
    this.plotRevealAlpha = 0.18;
  }

  stopPrime() { this.primePhase = false; for (const d of this.droppedDots) d.fadingOut = true; }

  simulatePrime() {
    const target = this.primePhase ? 0.18 : 1.0;
    this.plotRevealAlpha += (target - this.plotRevealAlpha) * 0.1;
    if (this.primePhase && this.xhPath.length > 1) {
      if (this.xhStopTimer > 0) {
        this.xhStopTimer--;
        if (this.xhStopTimer === 0) {
          this.xhFromPos = { ...this.xhToPos }; this.xhIdx = (this.xhIdx + 1) % this.xhPath.length;
          this.xhToPos = { ...this.xhPath[this.xhIdx] }; this.xhPhase = 0;
        }
      } else {
        this.xhPhase = Math.min(1, this.xhPhase + 1 / XH_MOVE_FRAMES);
        const eased = 1 - Math.pow(1 - this.xhPhase, 3);
        this.xhPos.x = this.xhFromPos.x + (this.xhToPos.x - this.xhFromPos.x) * eased;
        this.xhPos.y = this.xhFromPos.y + (this.xhToPos.y - this.xhFromPos.y) * eased;
        if (this.xhPhase >= 1) {
          this.droppedDots.push({ x: this.xhToPos.x, y: this.xhToPos.y, conf: this.confFromX(this.xhToPos.x), imp: this.impFromY(this.xhToPos.y), age: 0, fadingOut: false, fadeAge: 0 });
          this.xhStopTimer = XH_STOP_FRAMES;
        }
      }
    }
    for (const d of this.droppedDots) { d.age++; if (d.fadingOut) d.fadeAge++; }
  }

  dotHitTest(mx, my) {
    const { positions } = this.computeLayout();
    for (const node of this.nodes) { const pos = positions.get(node); if (!pos) continue; if (Math.hypot(pos.x - mx, pos.y - my) < pos.r + 3) return node; }
    return null;
  }

  inPlotArea(mx, my) { const { plot } = this.computeLayout(); return mx >= plot.x && mx <= plot.x + plot.w && my >= plot.y && my <= plot.y + plot.h; }

  quadAreaHitTest(mx, my) {
    const { plot } = this.computeLayout();
    if (!this.inPlotArea(mx, my)) return null;
    const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2;
    const leftHalf = mx < cx, topHalf = my < cy;
    if (topHalf && leftHalf) return 0; if (topHalf && !leftHalf) return 1; if (!topHalf && leftHalf) return 2; return 3;
  }

  quadLabelHitTest(mx, my) {
    const { plot } = this.computeLayout();
    const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2;
    const labelCentres = [{ x: plot.x + plot.w / 4, y: plot.y + 10, qi: 0 }, { x: cx + plot.w / 4, y: plot.y + 10, qi: 1 }, { x: plot.x + plot.w / 4, y: cy + 10, qi: 2 }, { x: cx + plot.w / 4, y: cy + 10, qi: 3 }];
    this.ctx.font = "700 11px 'JetBrains Mono', monospace";
    for (const lc of labelCentres) {
      const w = this.ctx.measureText(QUAD_LABELS[lc.qi]).width;
      if (mx > lc.x - w / 2 - 8 && mx < lc.x + w / 2 + 8 && my > lc.y - 4 && my < lc.y + 32) return lc.qi;
    }
    return null;
  }

  getThreadSet() {
    if (!this.threadFocus) return { ancestors: new Set(), descendants: new Set() };
    const ancestors = new Set(), descendants = new Set();
    for (const refId of (this.threadFocus.refs || [])) { const a = this.nodes.find(x => x.id === refId); if (a) ancestors.add(a); }
    for (const other of this.nodes) { if (other === this.threadFocus) continue; if (other.refs && other.refs.includes(this.threadFocus.id)) descendants.add(other); }
    return { ancestors, descendants };
  }

  getNodeDim(node) {
    if (this.threadFocus) {
      if (node === this.threadFocus) return 1;
      const { ancestors, descendants } = this.getThreadSet();
      if (ancestors.has(node) || descendants.has(node)) return 1;
      return 0.2;
    }
    if (this.quadLock !== null) return this.quadrantOf(node) === this.quadLock ? 1 : 0.22;
    return 1;
  }

  drawAllRefsArcs(positions) {
    const focusChain = new Set();
    if (this.threadFocus) {
      focusChain.add(this.threadFocus);
      for (const refId of (this.threadFocus.refs || [])) { const anc = this.nodes.find(x => x.id === refId); if (anc) focusChain.add(anc); }
      for (const other of this.nodes) { if (other.refs && other.refs.includes(this.threadFocus.id)) focusChain.add(other); }
    }
    for (const src of this.nodes) {
      if (!Array.isArray(src.refs) || !src.refs.length) continue;
      const sp = positions.get(src); if (!sp) continue;
      for (const tid of src.refs) {
        const tgt = this.nodeById(tid); if (!tgt) continue;
        const tp = positions.get(tgt); if (!tp) continue;
        let alpha, lineW, dash;
        if (this.threadFocus) { const focused = focusChain.has(src) && focusChain.has(tgt); alpha = focused ? 0.85 : 0.07; lineW = focused ? 1.6 : 0.9; dash = focused ? [4, 4] : [2, 5]; }
        else { alpha = 0.15; lineW = 1; dash = [3, 4]; }
        this.ctx.strokeStyle = relColor(src.rel); this.ctx.globalAlpha = alpha; this.ctx.lineWidth = lineW; this.ctx.setLineDash(dash);
        const mx = (sp.x + tp.x) / 2, my = (sp.y + tp.y) / 2;
        const dx = tp.x - sp.x, dy = tp.y - sp.y, len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const bend = Math.min(36, len * 0.18), bx = mx + (-dy / len) * bend, by = my + (dx / len) * bend;
        this.ctx.beginPath(); this.ctx.moveTo(sp.x, sp.y); this.ctx.quadraticCurveTo(bx, by, tp.x, tp.y); this.ctx.stroke();
      }
    }
    this.ctx.setLineDash([]); this.ctx.globalAlpha = 1;
  }

  drawIndustryBenchmarks(positions) {
    const { plot } = this.computeLayout();
    for (const node of this.nodes) {
      if (!this.hasExternalBecause(node)) continue;
      const pos = positions.get(node); if (!pos) continue;
      const info = this.topicInfo(node.topic);
      const sx = plot.x + plot.w + 22, sy = pos.y;
      const ex = pos.x + (sx < pos.x ? +22 : -22), ey = pos.y;
      this.ctx.strokeStyle = info.color; this.ctx.globalAlpha = 0.65; this.ctx.lineWidth = 1.3; this.ctx.setLineDash([4, 3]);
      this.ctx.beginPath(); this.ctx.moveTo(sx, sy); this.ctx.lineTo(ex, ey); this.ctx.stroke(); this.ctx.setLineDash([]);
      const ang = Math.atan2(ey - sy, ex - sx), headSize = 6;
      this.ctx.fillStyle = info.color; this.ctx.globalAlpha = 0.85;
      this.ctx.beginPath(); this.ctx.moveTo(ex, ey); this.ctx.lineTo(ex - Math.cos(ang - 0.4) * headSize, ey - Math.sin(ang - 0.4) * headSize); this.ctx.lineTo(ex - Math.cos(ang + 0.4) * headSize, ey - Math.sin(ang + 0.4) * headSize); this.ctx.closePath(); this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  drawCrosshair() {
    if (!this.primePhase || this.xhPath.length === 0) return;
    const { plot } = this.computeLayout();
    this.ctx.strokeStyle = 'rgba(20, 20, 20, 0.42)'; this.ctx.lineWidth = 1; this.ctx.setLineDash([]);
    this.ctx.beginPath(); this.ctx.moveTo(this.xhPos.x, plot.y); this.ctx.lineTo(this.xhPos.x, plot.y + plot.h); this.ctx.stroke();
    this.ctx.beginPath(); this.ctx.moveTo(plot.x, this.xhPos.y); this.ctx.lineTo(plot.x + plot.w, this.xhPos.y); this.ctx.stroke();
    this.ctx.fillStyle = '#0a0a0a'; this.ctx.beginPath(); this.ctx.arc(this.xhPos.x, this.xhPos.y, 3, 0, Math.PI * 2); this.ctx.fill();
  }

  drawDroppedDots() {
    if (this.droppedDots.length === 0) return;
    this.ctx.setLineDash([]);
    for (const d of this.droppedDots) {
      let alpha = 0.72;
      if (d.age < 6) alpha *= d.age / 6;
      const holdFrames = 240;
      if (d.age > holdFrames) alpha *= Math.max(0, 1 - (d.age - holdFrames) / 40);
      if (d.fadingOut) alpha *= Math.max(0, 1 - d.fadeAge / 20);
      if (alpha < 0.02) continue;
      this.ctx.fillStyle = `rgba(20, 20, 20, ${alpha})`; this.ctx.beginPath(); this.ctx.arc(d.x, d.y, 3.5, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.strokeStyle = `rgba(20, 20, 20, ${alpha * 0.5})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.arc(d.x, d.y, 6.5, 0, Math.PI * 2); this.ctx.stroke();
      this.ctx.fillStyle = `rgba(50, 50, 50, ${alpha * 0.95})`;
      this.ctx.font = "500 9px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
      this.ctx.fillText(`${d.conf.toFixed(2)}, ${d.imp.toFixed(2)}`, d.x + 10, d.y - 1);
    }
  }

  drawLiveCrosshair(plot) {
    if (this.primePhase || !this.cursorInPlot || !this.cursorPos || this.cursorOverInteractive) return;
    this.ctx.strokeStyle = 'rgba(20, 20, 20, 0.25)'; this.ctx.lineWidth = 1; this.ctx.setLineDash([3, 3]);
    this.ctx.beginPath(); this.ctx.moveTo(this.cursorPos.x, plot.y); this.ctx.lineTo(this.cursorPos.x, plot.y + plot.h); this.ctx.stroke();
    this.ctx.beginPath(); this.ctx.moveTo(plot.x, this.cursorPos.y); this.ctx.lineTo(plot.x + plot.w, this.cursorPos.y); this.ctx.stroke();
    this.ctx.setLineDash([]);
    const conf = this.confFromX(this.cursorPos.x), imp = this.impFromY(this.cursorPos.y), txt = `${conf.toFixed(2)}, ${imp.toFixed(2)}`;
    this.ctx.font = "500 10px 'JetBrains Mono', monospace";
    const tw = this.ctx.measureText(txt).width;
    let tx = this.cursorPos.x + 10, ty = this.cursorPos.y - 14;
    if (tx + tw > plot.x + plot.w - 4) tx = this.cursorPos.x - tw - 10;
    if (ty < plot.y + 10) ty = this.cursorPos.y + 14;
    this.ctx.fillStyle = 'rgba(250, 250, 250, 0.88)'; this.ctx.fillRect(tx - 3, ty - 9, tw + 6, 14);
    this.ctx.fillStyle = 'rgba(40, 40, 40, 0.85)'; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle'; this.ctx.fillText(txt, tx, ty - 2);
  }

  drawQuadCallout(plot) {
    if (this.hoverQuad === null || this.primePhase) return;
    const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2;
    const inQuad = this.nodes.filter(n => this.quadrantOf(n) === this.hoverQuad);
    const n = inQuad.length;
    const avgConf = n > 0 ? inQuad.reduce((s, x) => s + (x.confidence ?? 0.7), 0) / n : 0;
    const avgImp = n > 0 ? inQuad.reduce((s, x) => s + this.impactFor(x), 0) / n : 0;
    const lines = [`${n} thought${n === 1 ? '' : 's'} in ${QUAD_LABELS[this.hoverQuad].toLowerCase()}`, `avg conf ${avgConf.toFixed(2)} · avg imp ${avgImp.toFixed(2)}`];
    const calloutW = 250, padX = 10, padY = 8, lineH = 16, calloutH = lines.length * lineH + padY * 2;
    const anchors = [{ x: plot.x + plot.w / 4, y: plot.y + 44 }, { x: cx + plot.w / 4, y: plot.y + 44 }, { x: plot.x + plot.w / 4, y: cy + 44 }, { x: cx + plot.w / 4, y: cy + 44 }];
    const a = anchors[this.hoverQuad];
    let boxX = a.x - calloutW / 2, boxY = a.y;
    if (boxX < plot.x + 4) boxX = plot.x + 4;
    if (boxX + calloutW > plot.x + plot.w - 4) boxX = plot.x + plot.w - 4 - calloutW;
    this.ctx.fillStyle = 'rgba(25, 25, 25, 0.94)'; this.ctx.strokeStyle = '#0a0a0a'; this.ctx.lineWidth = 1;
    this.ctx.fillRect(boxX, boxY, calloutW, calloutH); this.ctx.strokeRect(boxX, boxY, calloutW, calloutH);
    this.ctx.fillStyle = '#fafafa'; this.ctx.font = "500 11px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
    this.ctx.fillText(lines[0], boxX + padX, boxY + padY);
    this.ctx.fillStyle = 'rgba(250, 250, 250, 0.65)'; this.ctx.font = "400 10px 'JetBrains Mono', monospace";
    this.ctx.fillText(lines[1], boxX + padX, boxY + padY + lineH);
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: drop one ghost crosshair dot per token at a hashed plot
  // coordinate, so the blank 2×2 matrix already has faint presence markers.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const conf = 0.1 + (h % 800) / 1000;
      const imp = 0.1 + ((h >> 10) % 800) / 1000;
      const { plot } = this.computeLayout();
      const x = plot.x + conf * plot.w;
      const y = plot.y + (1 - imp) * plot.h;
      this.droppedDots.push({ x, y, conf, imp, age: 0, fadingOut: false, fadeAge: 0 });
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.nodeBorn.set(n, performance.now());
    this.playQuartalCluster(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.droppedDots = []; this.xhPath = []; this.plotRevealAlpha = 1.0;
    this.threadFocus = null; this.quadLock = null; this.hoverQuad = null;
    this.cursorPos = null; this.cursorInPlot = false; this.cursorOverInteractive = false;
    this.nodeBorn.clear();
    if (this.primePhase) this.stopPrime();
    this.primePhase = false;
  }

  draw() {
    if (this.app.isPaused()) return;
    const grad = this.ctx.createLinearGradient(0, 0, 0, this.H);
    grad.addColorStop(0, '#fafafa');
    grad.addColorStop(1, '#f1ebe0');
    this.ctx.fillStyle = grad; this.ctx.fillRect(0, 0, this.W, this.H);
    this.simulatePrime();
    const { plot, positions } = this.computeLayout();
    const ht = this.app.highlightedTopic;
    this.ctx.globalAlpha = this.plotRevealAlpha;
    const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2;
    const tints = ['rgba(40,160,80,0.06)','rgba(255,191,73,0.08)','rgba(255,127,0,0.08)','rgba(214,40,40,0.06)'];
    const quads = [{ x: plot.x, y: plot.y, w: plot.w/2, h: plot.h/2, label: 'MAJOR PROJECTS', tint: tints[2], desc: 'high impact · low confidence' }, { x: cx, y: plot.y, w: plot.w/2, h: plot.h/2, label: 'QUICK WINS', tint: tints[0], desc: 'high impact · high confidence' }, { x: plot.x, y: cy, w: plot.w/2, h: plot.h/2, label: 'MONEY PITS', tint: tints[3], desc: 'low impact · low confidence' }, { x: cx, y: cy, w: plot.w/2, h: plot.h/2, label: 'FILL-INS', tint: tints[1], desc: 'low impact · high confidence' }];
    quads.forEach((q, qi) => {
      const quadDim = (this.quadLock !== null && this.quadLock !== qi) ? 0.4 : 1;
      this.ctx.globalAlpha = this.plotRevealAlpha * quadDim;
      this.ctx.fillStyle = q.tint; this.ctx.fillRect(q.x, q.y, q.w, q.h);
      this.ctx.fillStyle = '#555'; this.ctx.font = "700 11px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'top';
      this.ctx.fillText(q.label, q.x + q.w / 2, q.y + 10);
      this.ctx.font = "500 9px 'JetBrains Mono', monospace"; this.ctx.fillStyle = '#999'; this.ctx.fillText(q.desc, q.x + q.w / 2, q.y + 26);
      if (this.quadLock === qi) {
        this.ctx.font = "700 11px 'JetBrains Mono', monospace";
        const lw = this.ctx.measureText(q.label).width;
        this.ctx.strokeStyle = '#333'; this.ctx.lineWidth = 1.5;
        this.ctx.beginPath(); this.ctx.moveTo(q.x + q.w / 2 - lw / 2, q.y + 22); this.ctx.lineTo(q.x + q.w / 2 + lw / 2, q.y + 22); this.ctx.stroke();
      }
    });
    this.ctx.globalAlpha = this.plotRevealAlpha;
    this.ctx.strokeStyle = '#0a0a0a'; this.ctx.lineWidth = 1.5;
    this.ctx.beginPath(); this.ctx.moveTo(plot.x, plot.y); this.ctx.lineTo(plot.x, plot.y + plot.h); this.ctx.lineTo(plot.x + plot.w, plot.y + plot.h); this.ctx.stroke();
    this.ctx.fillStyle = '#0a0a0a';
    this.ctx.beginPath(); this.ctx.moveTo(plot.x, plot.y); this.ctx.lineTo(plot.x - 6, plot.y + 10); this.ctx.lineTo(plot.x + 6, plot.y + 10); this.ctx.closePath(); this.ctx.fill();
    this.ctx.beginPath(); this.ctx.moveTo(plot.x + plot.w, plot.y + plot.h); this.ctx.lineTo(plot.x + plot.w - 10, plot.y + plot.h - 6); this.ctx.lineTo(plot.x + plot.w - 10, plot.y + plot.h + 6); this.ctx.closePath(); this.ctx.fill();
    this.ctx.font = "700 11px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'top';
    this.ctx.fillText('CONFIDENCE →', plot.x + plot.w / 2, plot.y + plot.h + 18);
    this.ctx.save(); this.ctx.translate(plot.x - 32, plot.y + plot.h / 2); this.ctx.rotate(-Math.PI / 2); this.ctx.fillText('IMPACT →', 0, 0); this.ctx.restore();
    this.ctx.font = "500 9px 'JetBrains Mono', monospace"; this.ctx.fillStyle = '#888';
    this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'middle';
    this.ctx.fillText('HI', plot.x - 8, plot.y + 4); this.ctx.fillText('LO', plot.x - 8, plot.y + plot.h - 4);
    this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'top';
    this.ctx.fillText('LO', plot.x, plot.y + plot.h + 4); this.ctx.fillText('HI', plot.x + plot.w, plot.y + plot.h + 4);
    this.ctx.strokeStyle = 'rgba(0,0,0,0.15)'; this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath(); this.ctx.moveTo(cx, plot.y); this.ctx.lineTo(cx, plot.y + plot.h); this.ctx.stroke();
    this.ctx.beginPath(); this.ctx.moveTo(plot.x, cy); this.ctx.lineTo(plot.x + plot.w, cy); this.ctx.stroke();
    this.ctx.setLineDash([]); this.ctx.globalAlpha = 1;
    this.drawDroppedDots(); this.drawCrosshair();
    this.drawAllRefsArcs(positions); this.drawIndustryBenchmarks(positions);
    const now = performance.now() / 1000;
    for (const node of this.nodes) {
      const pos = positions.get(node); if (!pos) continue;
      const info = this.topicInfo(node.topic);
      const legendDim = ht && ht !== node.topic ? 0.25 : 1;
      const interactionDim = this.getNodeDim(node);
      const dim = Math.min(legendDim, interactionDim);
      let dx = 0, dy = 0, stanceAlphaMult = 1;
      const stance = node.stance, seed = this.hashSeed(node.id);
      if (stance === 'exploring') { dx = Math.sin(now * 2.1 + seed) * 1.5; dy = Math.cos(now * 1.7 + seed * 1.3) * 1.5; }
      else if (stance === 'questioning') stanceAlphaMult = 0.8 + 0.2 * Math.sin(now * 2 + seed * 0.1);
      else if (stance === 'conceding') stanceAlphaMult = 0.7 + 0.15 * Math.sin(now * 0.6 + seed * 0.2);
      const born = this.nodeBorn.get(node);
      let drawInAlpha = 1;
      if (born != null) { const elapsedNode = typeof node.elapsed_ms === 'number' ? node.elapsed_ms : 400; const drawInMs = Math.min(1800, 200 + elapsedNode * 0.25); const age = performance.now() - born; drawInAlpha = Math.min(1, age / drawInMs); }
      const drawX = pos.x + dx, drawY = pos.y + dy, totalAlpha = dim * stanceAlphaMult * drawInAlpha;
      const heat = typeof node.heat === 'number' ? node.heat : 0;
      if (heat > 0.05) {
        const haloR = pos.r + 6 + heat * 5;
        this.ctx.strokeStyle = info.color; this.ctx.globalAlpha = totalAlpha * (0.18 + heat * 0.25); this.ctx.lineWidth = 2 + heat * 1.5;
        this.ctx.beginPath(); this.ctx.arc(drawX, drawY, haloR, 0, Math.PI * 2); this.ctx.stroke();
      }
      if (pos.inbound >= 3) {
        const intensity = Math.min(1, (pos.inbound - 2) / 4);
        this.ctx.strokeStyle = info.color; this.ctx.globalAlpha = totalAlpha * 0.15 * intensity; this.ctx.lineWidth = 2.5;
        this.ctx.beginPath(); this.ctx.arc(drawX, drawY, pos.r + 10, 0, Math.PI * 2); this.ctx.stroke();
        this.ctx.globalAlpha = totalAlpha * 0.25 * intensity; this.ctx.lineWidth = 1.2;
        this.ctx.beginPath(); this.ctx.arc(drawX, drawY, pos.r + 5, 0, Math.PI * 2); this.ctx.stroke();
      }
      this.ctx.globalAlpha = totalAlpha * 0.9; this.ctx.fillStyle = info.color;
      this.ctx.beginPath(); this.ctx.arc(drawX, drawY, pos.r, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.globalAlpha = totalAlpha; this.ctx.strokeStyle = '#fff'; this.ctx.lineWidth = 1.5;
      this.ctx.beginPath(); this.ctx.arc(drawX, drawY, pos.r, 0, Math.PI * 2); this.ctx.stroke();
      if (node.type === 'resolution') {
        this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 1.5;
        this.ctx.beginPath(); this.ctx.arc(drawX, drawY, pos.r + 4, 0, Math.PI * 2); this.ctx.stroke();
        this.ctx.fillStyle = '#fff'; this.ctx.font = "700 12px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText('★', drawX, drawY + 1);
      }
      if (node === this.threadFocus) { this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 2.5; this.ctx.beginPath(); this.ctx.arc(drawX, drawY, pos.r + 7, 0, Math.PI * 2); this.ctx.stroke(); }
    }
    this.ctx.globalAlpha = 1;
    this.drawLiveCrosshair(plot);
    this.drawQuadCallout(plot);
  }
}

export { MatrixMode };

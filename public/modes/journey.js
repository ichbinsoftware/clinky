import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, relColor, playNodeSound } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

const PHASES = [
  { id: 'awareness', label: 'AWARENESS' }, { id: 'consideration', label: 'CONSIDERATION' },
  { id: 'decision', label: 'DECISION' }, { id: 'retention', label: 'RETENTION' },
  { id: 'advocacy', label: 'ADVOCACY' },
];
const EMOTION = { resolution: 0.85, choice: 0.5, claim: 0.3, branch: 0, aside: -0.2, 'dead-end': -0.8 };
const SONATA_PHRASES = [
  { name: 'exposition', degrees: [0, 4, 7], vol: 0.10 },
  { name: 'development', degrees: [0, -4, -7], vol: 0.09 },
  { name: 'recapitulation', degrees: [0, 4, 7, 12], vol: 0.11 },
];
const PHRASE_STRIDE_MS = 200;
const SCAN_SPEED = 2.0;
const TRAIL_LIFE = 70;

class JourneyMode extends Mode {
  primePhase = false;
  scanX = 0;
  scanTrail = [];
  scanRevealAlpha = 1.0;
  threadFocus = null;
  phaseLock = null;
  hoverPhase = null;
  cursorPos = null;
  cursorInPlot = false;
  cursorOverInteractive = false;
  lastBatchId = null;

  constructor() {
    super({
      mode: 'journey',
      aesthetic: 'classical',
      topicFallbackColor: '#619b8a',
      vars: {
        '--e-bg': '#fdfcdc', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(10,138,168,0.08)', '--e-accent': '#0a8aa8',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      this.cursorPos = { x: e.clientX, y: e.clientY };
      this.cursorInPlot = this.inPlotArea(e.clientX, e.clientY);
      if (this.primePhase) { this.canvas.style.cursor = 'default'; return; }
      const dot = this.dotHitTest(e.clientX, e.clientY);
      const lbl = this.phaseLabelHitTest(e.clientX, e.clientY);
      this.cursorOverInteractive = !!(dot || lbl);
      this.hoverPhase = lbl;
      if (dot) { showTooltip(e, dot, this.topicInfo(dot.topic).color); this.app.highlightLegendTopic(dot.topic); this.canvas.style.cursor = 'pointer'; }
      else if (lbl !== null) { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'pointer'; }
      else if (this.cursorInPlot) { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'pointer'; }
      else { hideTooltip(); this.app.highlightLegendTopic(null); this.canvas.style.cursor = 'default'; }
    });
    this.canvas.addEventListener('mouseleave', () => { this.cursorInPlot = false; this.cursorPos = null; this.hoverPhase = null; this.cursorOverInteractive = false; });
    this.canvas.addEventListener('click', e => {
      if (this.primePhase) return;
      const dot = this.dotHitTest(e.clientX, e.clientY);
      if (dot) { this.threadFocus = (this.threadFocus === dot) ? null : dot; this.phaseLock = null; return; }
      const lbl = this.phaseLabelHitTest(e.clientX, e.clientY);
      if (lbl !== null) { this.phaseLock = (this.phaseLock === lbl) ? null : lbl; this.threadFocus = null; return; }
      const col = this.phaseColumnHitTest(e.clientX, e.clientY);
      if (col !== null) { this.phaseLock = (this.phaseLock === col) ? null : col; this.threadFocus = null; return; }
      this.threadFocus = null; this.phaseLock = null;
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
      pickSessionKey(this.app.prompt() || 'journey');
    });
  }

  scaleNote(degree) {
    const key = getSessionKey();
    const len = key.notes.length;
    const oct = Math.floor(degree / len) * 12;
    return key.notes[((degree % len) + len) % len] + oct;
  }

  maybeFireSonata(node) {
    if (node.batch_id == null || node.batch_id === this.lastBatchId) return;
    this.lastBatchId = node.batch_id;
    const phrase = SONATA_PHRASES[(node.batch_id - 1) % SONATA_PHRASES.length];
    phrase.degrees.forEach((d, i) => {
      setTimeout(() => playSynth({ midi: this.scaleNote(d) + 24, ...PRESETS.bell, duration: 0.5, vol: phrase.vol, reverbSend: 0.5 }), i * PHRASE_STRIDE_MS);
    });
  }

  computeLayout() {
    const pad = Math.max(60, this.sideBuffer());
    const plot = { x: pad, y: 140, w: this.W - pad * 2, h: this.H - 140 - 80 };
    const n = Math.max(this.nodes.length, 1);
    const positions = new Map();
    this.nodes.forEach((nd, i) => {
      const x = plot.x + (n > 1 ? i / (n - 1) : 0.5) * plot.w;
      const e = EMOTION[nd.type] ?? 0;
      const heat = typeof nd.heat === 'number' ? nd.heat : 0;
      const heatAmpMult = 0.8 + heat * 0.6;
      const y = plot.y + plot.h / 2 - (e * plot.h * 0.38 * heatAmpMult);
      const inbound = this.nodeIncoming(nd.id);
      const pivotScale = inbound >= 3 ? 1 + Math.min(inbound - 2, 5) * 0.14 : 1;
      positions.set(nd, { x, y, i, pivotScale, inbound });
    });
    return { plot, positions };
  }

  pulseY(x) {
    const amb = 5 * Math.sin(x * 0.035);
    const period = 180, p = ((x % period) + period) % period;
    let qrs = 0;
    if (p < 20) qrs = -(p / 20) * 14;
    else if (p < 30) qrs = -14 + ((p - 20) / 10) * 45;
    else if (p < 42) qrs = 31 - ((p - 30) / 12) * 35;
    else if (p < 50) qrs = -4 + ((p - 42) / 8) * 4;
    return amb + qrs;
  }

  startPrime() {
    this.primePhase = true;
    const { plot } = this.computeLayout();
    this.scanX = plot.x; this.scanTrail = []; this.scanRevealAlpha = 0.2;
  }

  stopPrime() { this.primePhase = false; }

  simulatePrime() {
    const target = this.primePhase ? 0.2 : 1.0;
    this.scanRevealAlpha += (target - this.scanRevealAlpha) * 0.1;
    if (this.primePhase) {
      const { plot } = this.computeLayout();
      const baseline = plot.y + plot.h / 2;
      this.scanX += SCAN_SPEED;
      if (this.scanX > plot.x + plot.w) this.scanX = plot.x;
      this.scanTrail.push({ x: this.scanX, y: baseline + this.pulseY(this.scanX), age: 0 });
    }
    for (const t of this.scanTrail) t.age++;
    this.scanTrail = this.scanTrail.filter(t => t.age < TRAIL_LIFE + 30);
  }

  drawScanner() {
    if (this.scanTrail.length < 2 && !this.primePhase) return;
    this.ctx.lineWidth = 1.6; this.ctx.lineCap = 'round';
    for (let i = 1; i < this.scanTrail.length; i++) {
      const a = this.scanTrail[i - 1], b = this.scanTrail[i];
      if (Math.abs(a.x - b.x) > 50) continue;
      const alpha = Math.max(0, 1 - a.age / TRAIL_LIFE) * 0.7;
      if (alpha < 0.02) continue;
      this.ctx.strokeStyle = `rgba(97, 155, 138, ${alpha})`;
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
    }
    if (this.primePhase) {
      const { plot } = this.computeLayout();
      this.ctx.strokeStyle = 'rgba(97, 155, 138, 0.55)'; this.ctx.setLineDash([]);
      this.ctx.beginPath(); this.ctx.moveTo(this.scanX, plot.y); this.ctx.lineTo(this.scanX, plot.y + plot.h); this.ctx.stroke();
      const latest = this.scanTrail[this.scanTrail.length - 1];
      if (latest) { this.ctx.fillStyle = '#619b8a'; this.ctx.beginPath(); this.ctx.arc(latest.x, latest.y, 3, 0, Math.PI * 2); this.ctx.fill(); }
    }
  }

  dotHitTest(mx, my) {
    const { positions } = this.computeLayout();
    for (const node of this.nodes) {
      const p = positions.get(node); if (!p) continue;
      const rad = 9 + (node.confidence || 0.7) * 3;
      if (Math.hypot(p.x - mx, p.y - my) < rad + 4) return node;
    }
    return null;
  }

  inPlotArea(mx, my) {
    const { plot } = this.computeLayout();
    return mx >= plot.x && mx <= plot.x + plot.w && my >= plot.y && my <= plot.y + plot.h;
  }

  phaseOfNode(node) {
    const { plot, positions } = this.computeLayout();
    const p = positions.get(node); if (!p) return -1;
    const phaseW = plot.w / PHASES.length;
    return Math.max(0, Math.min(PHASES.length - 1, Math.floor((p.x - plot.x) / phaseW)));
  }

  phaseColumnHitTest(mx, my) {
    const { plot } = this.computeLayout();
    if (!this.inPlotArea(mx, my)) return null;
    const phaseW = plot.w / PHASES.length;
    return Math.max(0, Math.min(PHASES.length - 1, Math.floor((mx - plot.x) / phaseW)));
  }

  phaseLabelHitTest(mx, my) {
    const { plot } = this.computeLayout();
    const phaseW = plot.w / PHASES.length;
    const labelY = plot.y - 20;
    if (my < labelY - 10 || my > labelY + 10) return null;
    this.ctx.font = "700 11px 'JetBrains Mono', monospace";
    for (let i = 0; i < PHASES.length; i++) {
      const cx = plot.x + i * phaseW + phaseW / 2;
      const w = this.ctx.measureText(PHASES[i].label).width;
      if (mx > cx - w / 2 - 8 && mx < cx + w / 2 + 8) return i;
    }
    return null;
  }

  curveHitTest(mx, my) {
    if (this.nodes.length < 1 || !this.inPlotArea(mx, my)) return null;
    const { plot, positions } = this.computeLayout();
    let leftNode = null, rightNode = null;
    for (const n of this.nodes) {
      const p = positions.get(n); if (!p) continue;
      if (p.x <= mx) leftNode = n;
      if (p.x >= mx && !rightNode) rightNode = n;
    }
    let emotion, y;
    if (leftNode && rightNode && leftNode !== rightNode) {
      const lp = positions.get(leftNode), rp = positions.get(rightNode);
      const t = rp.x === lp.x ? 0 : (mx - lp.x) / (rp.x - lp.x);
      emotion = (EMOTION[leftNode.type] ?? 0) + ((EMOTION[rightNode.type] ?? 0) - (EMOTION[leftNode.type] ?? 0)) * t;
      y = lp.y + (rp.y - lp.y) * t;
    } else if (leftNode || rightNode) {
      const n = leftNode || rightNode;
      emotion = EMOTION[n.type] ?? 0;
      y = positions.get(n).y;
    } else return null;
    if (Math.abs(my - y) > 14) return null;
    const phaseW = plot.w / PHASES.length;
    const pi = Math.max(0, Math.min(PHASES.length - 1, Math.floor((mx - plot.x) / phaseW)));
    return { x: mx, y, emotion, phaseLabel: PHASES[pi].label };
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
    if (this.phaseLock !== null) return this.phaseOfNode(node) === this.phaseLock ? 1 : 0.22;
    return 1;
  }

  drawAllRefsArcs(positions) {
    const focusChain = new Set();
    if (this.threadFocus) {
      focusChain.add(this.threadFocus);
      for (const refId of (this.threadFocus.refs || [])) { const anc = this.nodeById(refId); if (anc) focusChain.add(anc); }
      for (const other of this.nodes) { if (other.refs && other.refs.includes(this.threadFocus.id)) focusChain.add(other); }
    }
    for (const src of this.nodes) {
      if (!Array.isArray(src.refs) || !src.refs.length) continue;
      const sp = positions.get(src); if (!sp) continue;
      for (const tid of src.refs) {
        const tgt = this.nodeById(tid); if (!tgt) continue;
        const tp = positions.get(tgt); if (!tp) continue;
        let alpha, lineW, dash;
        if (this.threadFocus) { const focused = focusChain.has(src) && focusChain.has(tgt); alpha = focused ? 0.85 : 0.06; lineW = focused ? 1.6 : 0.9; dash = focused ? [4, 4] : [2, 5]; }
        else { alpha = 0.18; lineW = 1; dash = [3, 4]; }
        this.ctx.strokeStyle = relColor(src.rel); this.ctx.globalAlpha = alpha; this.ctx.lineWidth = lineW; this.ctx.setLineDash(dash);
        const mx = (sp.x + tp.x) / 2, my = (sp.y + tp.y) / 2;
        const dx = tp.x - sp.x, dy = tp.y - sp.y, len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const bend = Math.min(48, len * 0.22);
        const bx = mx + (-dy / len) * bend, by = my + (dx / len) * bend;
        this.ctx.beginPath(); this.ctx.moveTo(sp.x, sp.y); this.ctx.quadraticCurveTo(bx, by, tp.x, tp.y); this.ctx.stroke();
      }
    }
    this.ctx.setLineDash([]); this.ctx.globalAlpha = 1;
  }

  drawEmotionCurve(positions) {
    if (this.nodes.length < 2) return;
    this.ctx.strokeStyle = '#619b8a'; this.ctx.lineWidth = 2.5;
    for (let i = 1; i < this.nodes.length; i++) {
      const prev = positions.get(this.nodes[i - 1]), cur = positions.get(this.nodes[i]);
      if (!prev || !cur) continue;
      const rel = this.nodes[i].rel;
      if (rel === 'questions') {
        const steps = 30; this.ctx.beginPath();
        for (let k = 0; k <= steps; k++) {
          const t = k / steps, bx = prev.x + (cur.x - prev.x) * t;
          const ease = 0.5 - 0.5 * Math.cos(t * Math.PI), by = prev.y + (cur.y - prev.y) * ease;
          const env = Math.sin(t * Math.PI), wobble = Math.sin(t * Math.PI * 5) * 12 * env;
          if (k === 0) this.ctx.moveTo(bx, by); else this.ctx.lineTo(bx, by + wobble);
        }
        this.ctx.stroke();
      } else if (rel === 'contradicts') {
        const dipY = Math.max(prev.y, cur.y) + 40;
        this.ctx.beginPath(); this.ctx.moveTo(prev.x, prev.y);
        const cpx1 = prev.x + (cur.x - prev.x) * 0.35, cpx2 = prev.x + (cur.x - prev.x) * 0.65;
        this.ctx.bezierCurveTo(cpx1, dipY, cpx2, dipY, cur.x, cur.y); this.ctx.stroke();
      } else if (rel === 'synthesizes') {
        const cpx1 = prev.x + (cur.x - prev.x) * 0.65, cpx2 = prev.x + (cur.x - prev.x) * 0.82;
        this.ctx.beginPath(); this.ctx.moveTo(prev.x, prev.y); this.ctx.bezierCurveTo(cpx1, prev.y, cpx2, cur.y, cur.x, cur.y); this.ctx.stroke();
      } else if (rel === 'supersedes') {
        const dropY = prev.y + 28, earlyX = prev.x + (cur.x - prev.x) * 0.15;
        this.ctx.beginPath(); this.ctx.moveTo(prev.x, prev.y); this.ctx.lineTo(earlyX, dropY);
        const cpx = prev.x + (cur.x - prev.x) * 0.58;
        this.ctx.bezierCurveTo(cpx, dropY, cpx, cur.y, cur.x, cur.y); this.ctx.stroke();
      } else {
        const cpx = (prev.x + cur.x) / 2;
        this.ctx.beginPath(); this.ctx.moveTo(prev.x, prev.y); this.ctx.bezierCurveTo(cpx, prev.y, cpx, cur.y, cur.x, cur.y); this.ctx.stroke();
      }
    }
  }

  drawQuoteBubbles(positions) {
    for (const node of this.nodes) {
      if (!this.hasExternalBecause(node)) continue;
      const p = positions.get(node); if (!p) continue;
      const info = this.topicInfo(node.topic);
      const rad = 9 + (node.confidence || 0.7) * 3;
      const textAbove = (p.i % 2 === 0);
      const gy = textAbove ? p.y + rad + 12 : p.y - rad - 10;
      this.ctx.fillStyle = info.color; this.ctx.globalAlpha = 0.85;
      this.ctx.font = "700 14px Georgia, serif"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
      this.ctx.fillText('"', p.x, gy);
    }
    this.ctx.globalAlpha = 1;
  }

  drawLiveEmotionReadout(plot, positions) {
    if (this.primePhase || !this.cursorPos || !this.cursorInPlot || this.cursorOverInteractive) return;
    const hit = this.curveHitTest(this.cursorPos.x, this.cursorPos.y); if (!hit) return;
    const sign = hit.emotion >= 0 ? '+' : '';
    const txt = `emotion: ${sign}${hit.emotion.toFixed(2)} · ${hit.phaseLabel.toLowerCase()}`;
    this.ctx.font = "500 10px 'JetBrains Mono', monospace";
    const tw = this.ctx.measureText(txt).width;
    let tx = hit.x + 12, ty = hit.y - 18;
    if (tx + tw + 10 > plot.x + plot.w - 4) tx = hit.x - tw - 12;
    if (ty < plot.y + 6) ty = hit.y + 18;
    this.ctx.fillStyle = 'rgba(253, 252, 220, 0.92)'; this.ctx.strokeStyle = 'rgba(97, 155, 138, 0.55)'; this.ctx.lineWidth = 1;
    this.ctx.fillRect(tx - 6, ty - 10, tw + 12, 18); this.ctx.strokeRect(tx - 6, ty - 10, tw + 12, 18);
    this.ctx.fillStyle = '#233d4d'; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
    this.ctx.fillText(txt, tx, ty);
    this.ctx.fillStyle = '#619b8a'; this.ctx.beginPath(); this.ctx.arc(hit.x, hit.y, 3, 0, Math.PI * 2); this.ctx.fill();
  }

  drawPhaseCallout(plot) {
    if (this.hoverPhase === null || this.primePhase) return;
    const phaseW = plot.w / PHASES.length;
    const inPhase = this.nodes.filter(n => this.phaseOfNode(n) === this.hoverPhase);
    const n = inPhase.length;
    const avgEmotion = n > 0 ? inPhase.reduce((s, x) => s + (EMOTION[x.type] ?? 0), 0) / n : 0;
    const topicCounts = {};
    for (const nd of inPhase) topicCounts[nd.topic] = (topicCounts[nd.topic] || 0) + 1;
    let dominant = '—', best = 0;
    for (const [t, c] of Object.entries(topicCounts)) if (c > best) { best = c; dominant = t; }
    const sign = avgEmotion >= 0 ? '+' : '';
    const lines = [`${n} thought${n === 1 ? '' : 's'} in ${PHASES[this.hoverPhase].label.toLowerCase()}`, `avg emotion ${sign}${avgEmotion.toFixed(2)}${n > 0 ? ` · mostly ${dominant}` : ''}`];
    const calloutW = 260, padX = 10, padY = 8, lineH = 16, calloutH = lines.length * lineH + padY * 2;
    const anchorX = plot.x + this.hoverPhase * phaseW + phaseW / 2;
    let boxX = anchorX - calloutW / 2;
    if (boxX < plot.x + 4) boxX = plot.x + 4;
    if (boxX + calloutW > plot.x + plot.w - 4) boxX = plot.x + plot.w - 4 - calloutW;
    const boxY = plot.y - 20 + 18;
    this.ctx.fillStyle = 'rgba(35, 61, 77, 0.94)'; this.ctx.strokeStyle = '#233d4d'; this.ctx.lineWidth = 1;
    this.ctx.fillRect(boxX, boxY, calloutW, calloutH); this.ctx.strokeRect(boxX, boxY, calloutW, calloutH);
    this.ctx.fillStyle = '#fdfcdc'; this.ctx.font = "500 11px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
    this.ctx.fillText(lines[0], boxX + padX, boxY + padY);
    this.ctx.fillStyle = 'rgba(253, 252, 220, 0.68)'; this.ctx.font = "400 10px 'JetBrains Mono', monospace";
    this.ctx.fillText(lines[1], boxX + padX, boxY + padY + lineH);
  }

  trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: place one phase marker tick per token along the scan line at a
  // hashed X position so the timeline feels pre-seeded with the prompt's structure.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    const { plot } = this.computeLayout();
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const x = plot.x + (h % Math.max(1, Math.round(plot.w)));
      const baseline = plot.y + plot.h / 2;
      this.scanTrail.push({ x, y: baseline + this.pulseY(x), age: 0 });
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.maybeFireSonata(n);
    playNodeSound(n.type, this.topicInfo(n.topic).note);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.scanTrail = [];
    this.scanRevealAlpha = 1.0;
    this.threadFocus = null;
    this.phaseLock = null;
    this.hoverPhase = null;
    this.cursorPos = null;
    this.cursorInPlot = false;
    this.cursorOverInteractive = false;
    this.lastBatchId = null;
    if (this.primePhase) this.stopPrime();
    this.primePhase = false;
  }

  // Watercolour blotches — four soft warm-tan radials at random session-fixed
  // positions. Reads as a hand-painted map.
  drawBlotches() {
    if (!this._blotches) {
      this._blotches = [];
      const tints = ['200,144,96', '168,120,80', '184,133,85', '212,160,112'];
      for (let i = 0; i < 4; i++) {
        this._blotches.push({
          fx: 0.15 + Math.random() * 0.7,
          fy: 0.15 + Math.random() * 0.7,
          fr: 0.13 + Math.random() * 0.10,
          tint: tints[i],
          alpha: 0.07 + Math.random() * 0.05,
        });
      }
    }
    for (const b of this._blotches) {
      const cx = b.fx * this.W, cy = b.fy * this.H;
      const r = b.fr * Math.max(this.W, this.H);
      const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${b.tint}, ${b.alpha})`);
      g.addColorStop(0.5, `rgba(${b.tint}, ${b.alpha * 0.4})`);
      g.addColorStop(1, `rgba(${b.tint}, 0)`);
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  draw() {
    if (this.app.isPaused()) return;
    const grad = this.ctx.createLinearGradient(0, 0, this.W, 0);
    grad.addColorStop(0, '#ffe9b0'); grad.addColorStop(0.5, '#fdfcdc'); grad.addColorStop(1, '#a9def9');
    this.ctx.fillStyle = grad; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawBlotches();
    this.simulatePrime();
    const { plot, positions } = this.computeLayout();
    const ht = this.app.highlightedTopic;
    this.ctx.globalAlpha = this.scanRevealAlpha;
    const phaseW = plot.w / PHASES.length;
    PHASES.forEach((p, i) => {
      const x = plot.x + i * phaseW;
      const phaseDim = (this.phaseLock !== null && this.phaseLock !== i) ? 0.4 : 1;
      this.ctx.globalAlpha = this.scanRevealAlpha * phaseDim;
      this.ctx.fillStyle = i % 2 === 0 ? 'rgba(35,61,77,0.04)' : 'rgba(35,61,77,0.08)';
      this.ctx.fillRect(x, plot.y, phaseW, plot.h);
      this.ctx.fillStyle = '#233d4d'; this.ctx.font = "700 11px 'JetBrains Mono', monospace";
      this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
      this.ctx.fillText(p.label, x + phaseW / 2, plot.y - 20);
      if (this.phaseLock === i) {
        const w = this.ctx.measureText(p.label).width;
        this.ctx.strokeStyle = '#233d4d'; this.ctx.lineWidth = 1.5;
        this.ctx.beginPath(); this.ctx.moveTo(x + phaseW / 2 - w / 2, plot.y - 12); this.ctx.lineTo(x + phaseW / 2 + w / 2, plot.y - 12); this.ctx.stroke();
      }
    });
    this.ctx.globalAlpha = this.scanRevealAlpha;
    this.ctx.strokeStyle = 'rgba(35,61,77,0.4)'; this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath(); this.ctx.moveTo(plot.x, plot.y + plot.h / 2); this.ctx.lineTo(plot.x + plot.w, plot.y + plot.h / 2); this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.fillStyle = '#619b8a'; this.ctx.font = "500 9px 'JetBrains Mono', monospace";
    this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
    this.ctx.fillText('😊', plot.x - 14, plot.y + 14);
    this.ctx.fillText('😐', plot.x - 14, plot.y + plot.h / 2);
    this.ctx.fillText('☹️', plot.x - 14, plot.y + plot.h - 14);
    this.ctx.strokeStyle = '#233d4d'; this.ctx.lineWidth = 1.2;
    this.ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
    this.ctx.globalAlpha = 1;
    this.drawScanner();
    this.drawAllRefsArcs(positions);
    this.drawEmotionCurve(positions);
    for (const node of this.nodes) {
      const p = positions.get(node); if (!p) continue;
      const info = this.topicInfo(node.topic);
      const legendDim = ht && ht !== node.topic ? 0.25 : 1;
      const interactionDim = this.getNodeDim(node);
      const dim = Math.min(legendDim, interactionDim);
      this.ctx.globalAlpha = dim;
      const baseRad = 9 + (node.confidence || 0.7) * 3;
      const rad = baseRad * (p.pivotScale || 1);
      const stance = node.stance;
      if (p.inbound >= 3) {
        const intensity = Math.min(1, (p.inbound - 2) / 4);
        this.ctx.strokeStyle = info.color; this.ctx.globalAlpha = dim * 0.2 * intensity; this.ctx.lineWidth = 2.5;
        this.ctx.beginPath(); this.ctx.arc(p.x, p.y, rad + 6, 0, Math.PI * 2); this.ctx.stroke();
        this.ctx.globalAlpha = dim;
      }
      if (stance === 'exploring') {
        this.ctx.fillStyle = info.color; this.ctx.globalAlpha = dim * 0.15;
        this.ctx.beginPath(); this.ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.globalAlpha = dim; this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 2;
        this.ctx.beginPath(); this.ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); this.ctx.stroke();
      } else if (stance === 'conceding') {
        this.ctx.fillStyle = info.color;
        this.ctx.beginPath(); this.ctx.arc(p.x, p.y, rad, -Math.PI / 2, Math.PI / 2, false); this.ctx.closePath(); this.ctx.fill();
        this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 1.4;
        this.ctx.beginPath(); this.ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); this.ctx.stroke();
      } else {
        this.ctx.fillStyle = info.color; this.ctx.beginPath(); this.ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.strokeStyle = '#fff'; this.ctx.lineWidth = 1.5;
        this.ctx.beginPath(); this.ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); this.ctx.stroke();
      }
      if (stance === 'questioning') {
        this.ctx.fillStyle = '#fff'; this.ctx.font = "700 12px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText('?', p.x, p.y + 1);
      } else {
        const icon = node.type === 'resolution' ? '★' : node.type === 'dead-end' ? '×' : node.type === 'choice' ? '◆' : '';
        if (icon) { this.ctx.fillStyle = '#fff'; this.ctx.font = "700 11px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText(icon, p.x, p.y + 1); }
      }
      const above = p.i % 2 === 0;
      const ly = above ? p.y - rad - 8 : p.y + rad + 8;
      this.ctx.fillStyle = '#233d4d'; this.ctx.font = "500 9px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = above ? 'bottom' : 'top';
      this.ctx.fillText(this.trunc(node.text, 28), p.x, ly);
      if (node === this.threadFocus) { this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 2.5; this.ctx.beginPath(); this.ctx.arc(p.x, p.y, rad + 6, 0, Math.PI * 2); this.ctx.stroke(); }
    }
    this.ctx.globalAlpha = 1;
    this.drawQuoteBubbles(positions);
    this.drawLiveEmotionReadout(plot, positions);
    this.drawPhaseCallout(plot);
  }
}

export { JourneyMode };

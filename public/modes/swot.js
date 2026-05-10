import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey } from '/synth.js';

const QUADS = [
  { id: 'S', label: 'STRENGTHS',     tint: '#2e7d32', types: ['claim','choice'] },
  { id: 'W', label: 'WEAKNESSES',    tint: '#c62828', types: ['aside'] },
  { id: 'O', label: 'OPPORTUNITIES', tint: '#1565c0', types: ['branch'] },
  { id: 'T', label: 'THREATS',       tint: '#ef6c00', types: ['dead-end'] },
];
const QUADRANT_METAL = {
  0: { freq: 700, release: 0.20, voices: 5, detune: 60, vol: 0.10 },
  1: { freq: 1100, release: 0.15, voices: 5, detune: 70, vol: 0.10 },
  2: { freq: 480, release: 0.45, voices: 6, detune: 50, vol: 0.10 },
  3: { freq: 1800, release: 0.18, voices: 4, detune: 80, vol: 0.09 },
};
const FRAMES_PER_SLOT = 96;
const BOOST_PEAK = 0.28;

class SwotMode extends Mode {
  primePhase = false;
  cycleAlpha = [0, 0, 0, 0];
  cycleIdx = 0;
  cycleTimer = 0;
  synthPulse = 0;
  landing = null;
  isolated = null;

  constructor() {
    super({
      mode: 'swot',
      aesthetic: 'industrial',
      topicFallbackColor: '#888',
      vars: {
        '--e-bg': '#f5f1e8', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(168,112,24,0.08)', '--e-accent': '#5a3818',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const mx = e.clientX, my = e.clientY;
      const { positions } = this.computeLayout();
      let hit = null;
      for (const node of this.nodes) {
        const pos = positions.get(node); if (!pos) continue;
        if (mx > pos.x && mx < pos.x + pos.w && my > pos.y && my < pos.y + pos.h) { hit = node; break; }
      }
      if (hit) { showTooltip(e, hit, this.topicInfo(hit.topic).color); this.app.highlightLegendTopic(hit.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
      const labelHit = hit ? null : this.labelHitTest(mx, my);
      this.canvas.style.cursor = labelHit ? 'pointer' : 'default';
    });
    this.canvas.addEventListener('click', e => {
      const mx = e.clientX, my = e.clientY;
      const target = this.labelHitTest(mx, my);
      if (target) {
        if (this.isolated && this.isolated.kind === target.kind && (this.isolated.kind !== 'quadrant' || this.isolated.qIdx === target.qIdx)) this.isolated = null;
        else this.isolated = target;
        return;
      }
      this.isolated = null;
    });
  }

  quadOf(n) {
    if (n.type === 'resolution') return null;
    const q = QUADS.findIndex(qd => qd.types.includes(n.type));
    return q < 0 ? 0 : q;
  }

  sideBuffer() {
    const el = document.querySelector('.topic-legend');
    if (!el) return 40;
    const rect = el.getBoundingClientRect();
    return Math.max(40, window.innerWidth - rect.left + 12);
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('industrial');
      pickSessionKey(this.app.prompt() || 'swot');
    });
  }

  metalHitForQuadrant(qIdx) {
    const m = QUADRANT_METAL[qIdx]; if (!m) return;
    playSynth({ freq: m.freq, wave: 'sawtooth', voices: m.voices, detune: m.detune, attack: 0.001, decay: 0.04, sustain: 0.0, release: m.release, duration: 0.05, vol: m.vol, filter: { type: 'bandpass', freq: m.freq, Q: 10 }, distortion: { drive: 0.4, tone: 'crunch', mix: 0.4 }, reverbSend: 0.40, delaySend: 0.25 });
  }

  playMetalEnsemble(node) {
    const q = this.quadOf(node);
    if (q == null) [0, 1, 2, 3].forEach(qIdx => this.metalHitForQuadrant(qIdx));
    else this.metalHitForQuadrant(q);
  }

  startPrime() { this.primePhase = true; this.cycleAlpha = [0, 0, 0, 0]; this.cycleIdx = 0; this.cycleTimer = 0; this.synthPulse = 0; this.landing = null; }

  stopPrime() {
    this.primePhase = false;
    if (this.nodes.length > 0) {
      const lastNode = this.nodes[this.nodes.length - 1];
      const qIdx = this.quadOf(lastNode);
      if (qIdx != null) this.landing = { quadIdx: qIdx, age: 0 };
    }
  }

  simulatePrime() {
    if (this.primePhase) {
      this.cycleTimer++;
      if (this.cycleTimer >= FRAMES_PER_SLOT) { this.cycleTimer = 0; this.cycleIdx = (this.cycleIdx + 1) % 4; }
    }
    for (let i = 0; i < 4; i++) {
      let target = 0;
      if (this.primePhase && i === this.cycleIdx) {
        const half = FRAMES_PER_SLOT / 2;
        const t = this.cycleTimer < half ? this.cycleTimer / half : 1 - (this.cycleTimer - half) / half;
        target = t * BOOST_PEAK;
      } else if (!this.primePhase && this.landing && i === this.landing.quadIdx) {
        this.landing.age++;
        if (this.landing.age < 45) target = BOOST_PEAK;
        else if (this.landing.age < 90) target = BOOST_PEAK * (1 - (this.landing.age - 45) / 45);
        else { target = 0; this.landing = null; }
      }
      this.cycleAlpha[i] += (target - this.cycleAlpha[i]) * 0.1;
    }
    const synthTarget = this.primePhase ? 0.06 : 0;
    this.synthPulse += (synthTarget - this.synthPulse) * 0.08;
  }

  computeLayout() {
    const pad = Math.max(56, this.sideBuffer()), headerH = 28, midH = 80;
    const totalW = this.W - pad * 2;
    const totalH = this.H - pad - 40 - headerH;
    const qW = (totalW - 40) / 2;
    const qH = (totalH - 40 - midH) / 2;
    const quadRects = [
      { x: pad, y: pad + headerH, w: qW, h: qH },
      { x: pad + qW + 40, y: pad + headerH, w: qW, h: qH },
      { x: pad, y: pad + headerH + qH + 40 + midH, w: qW, h: qH },
      { x: pad + qW + 40, y: pad + headerH + qH + 40 + midH, w: qW, h: qH },
    ];
    const midRect = { x: pad + 20, y: pad + headerH + qH + 20, w: totalW - 40, h: midH };
    const positions = new Map();
    const perQuad = [[], [], [], []], mid = [];
    for (const n of this.nodes) { const q = this.quadOf(n); if (q == null) mid.push(n); else perQuad[q].push(n); }
    perQuad.forEach((arr, qi) => {
      const rect = quadRects[qi], perRow = 3, rowH = 44;
      arr.forEach((n, i) => {
        const col = i % perRow, row = Math.floor(i / perRow);
        const cellW = (rect.w - 20) / perRow;
        positions.set(n, { x: rect.x + 10 + col * cellW, y: rect.y + 34 + row * rowH, w: cellW - 6, h: rowH - 6 });
      });
    });
    mid.forEach((n, i) => {
      const perRow = Math.max(mid.length, 1), cellW = (midRect.w - 20) / perRow;
      positions.set(n, { x: midRect.x + 10 + i * cellW, y: midRect.y + 26, w: cellW - 6, h: midRect.h - 34 });
    });
    return { quadRects, midRect, positions };
  }

  labelHitTest(mx, my) {
    const { quadRects, midRect } = this.computeLayout();
    this.ctx.font = "700 12px 'JetBrains Mono', monospace";
    for (let i = 0; i < QUADS.length; i++) {
      const r = quadRects[i], q = QUADS[i];
      const text = q.id + ' · ' + q.label;
      const w = this.ctx.measureText(text).width;
      const lx = r.x + 12, ly = r.y + 12;
      const PAD = 8;
      if (mx >= lx - PAD && mx <= lx + w + PAD && my >= ly - 4 && my <= ly + 20) return { kind: 'quadrant', qIdx: i };
    }
    if (mx >= midRect.x && mx <= midRect.x + midRect.w && my >= midRect.y && my <= midRect.y + midRect.h) return { kind: 'synthesis-trace' };
    return null;
  }

  isResolutionSource(node) {
    for (const n of this.nodes) { if (n.type === 'resolution' && n.refs && n.refs.includes(node.id)) return true; }
    return false;
  }

  getCardDim(node) {
    if (this.isolated) {
      if (this.isolated.kind === 'quadrant') { const q = this.quadOf(node); return q === this.isolated.qIdx ? 1 : 0.22; }
      if (this.isolated.kind === 'synthesis-trace') { if (node.type === 'resolution') return 1; return this.isResolutionSource(node) ? 1 : 0.22; }
    }
    const ht = this.app.highlightedTopic;
    return ht && ht !== node.topic ? 0.25 : 1;
  }

  getQuadrantDim(qIdx) {
    if (this.isolated && this.isolated.kind === 'quadrant') return qIdx === this.isolated.qIdx ? 1 : 0.32;
    if (this.isolated && this.isolated.kind === 'synthesis-trace') return 0.55;
    return 1;
  }

  getSynthesisStripDim() {
    if (this.isolated && this.isolated.kind === 'synthesis-trace') return 1.35;
    if (this.isolated && this.isolated.kind === 'quadrant') return 0.35;
    return 1;
  }

  drawSynthesisTrace(positions) {
    if (!this.isolated || this.isolated.kind !== 'synthesis-trace') return;
    const byId = new Map();
    for (const n of this.nodes) if (n.id != null) byId.set(n.id, n);
    this.ctx.setLineDash([5, 4]); this.ctx.lineWidth = 1.4; this.ctx.strokeStyle = 'rgba(42, 157, 143, 0.78)';
    for (const node of this.nodes) {
      if (node.type !== 'resolution') continue;
      const resPos = positions.get(node); if (!resPos) continue;
      const rcx = resPos.x + resPos.w / 2, rcy = resPos.y + resPos.h / 2;
      for (const refId of (node.refs || [])) {
        const src = byId.get(refId); if (!src) continue;
        const srcPos = positions.get(src); if (!srcPos) continue;
        const scx = srcPos.x + srcPos.w / 2, scy = srcPos.y + srcPos.h / 2;
        const midX = (scx + rcx) / 2, midY = (scy + rcy) / 2 + (scy < rcy ? 20 : -20);
        this.ctx.beginPath(); this.ctx.moveTo(scx, scy); this.ctx.quadraticCurveTo(midX, midY, rcx, rcy); this.ctx.stroke();
      }
    }
    this.ctx.setLineDash([]);
  }

  wrapText(text, x, y, maxW, lineH, maxLines) {
    const words = text.split(' '); let line = '', yy = y, lines = 0;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (this.ctx.measureText(test).width > maxW && line) {
        this.ctx.fillText(line, x, yy); line = w; yy += lineH; lines++;
        if (lines >= maxLines) { this.ctx.fillText(line.slice(0, 28) + '…', x, yy); return; }
      } else line = test;
    }
    if (line) this.ctx.fillText(line, x, yy);
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: distribute tokens across the four quadrants as faint placeholder
  // labels, cycling by index so each quadrant gets a roughly equal share.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    this._unpackTokens = tokens;
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.playMetalEnsemble(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.primePhase = false;
    this.cycleAlpha = [0, 0, 0, 0];
    this.cycleTimer = 0;
    this.cycleIdx = 0;
    this.synthPulse = 0;
    this.landing = null;
    this.isolated = null;
    this._unpackTokens = [];
  }

  // Felt tablecloth — fine fabric weave tile (warp/weft thread segments) cached
  // as a Pattern. Strategy session table.
  drawFeltTablecloth() {
    if (!this._feltPattern) {
      const tile = document.createElement('canvas');
      tile.width = 6; tile.height = 6;
      const tc = tile.getContext('2d');
      tc.strokeStyle = 'rgba(120, 100, 80, 0.07)';
      tc.lineWidth = 1;
      tc.beginPath();
      tc.moveTo(0, 1.5); tc.lineTo(3, 1.5);
      tc.moveTo(3, 4.5); tc.lineTo(6, 4.5);
      tc.moveTo(1.5, 1); tc.lineTo(1.5, 4);
      tc.moveTo(4.5, 0); tc.lineTo(4.5, 1);
      tc.moveTo(4.5, 4); tc.lineTo(4.5, 6);
      tc.stroke();
      this._feltPattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._feltPattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.ctx.fillStyle = '#f5f1e8'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawFeltTablecloth();
    this.simulatePrime();
    const { quadRects, midRect, positions } = this.computeLayout();
    QUADS.forEach((q, i) => {
      const r = quadRects[i];
      const [R, G, B] = hexToRgb(q.tint);
      const qDim = this.getQuadrantDim(i);
      const alpha = (0.08 + (this.cycleAlpha[i] || 0)) * qDim;
      this.ctx.fillStyle = `rgba(${R},${G},${B},${alpha})`; this.ctx.fillRect(r.x, r.y, r.w, r.h);
      this.ctx.globalAlpha = qDim;
      this.ctx.strokeStyle = q.tint; this.ctx.lineWidth = 1.5; this.ctx.strokeRect(r.x, r.y, r.w, r.h);
      this.ctx.fillStyle = q.tint; this.ctx.font = "700 12px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
      const labelText = q.id + ' · ' + q.label;
      this.ctx.fillText(labelText, r.x + 12, r.y + 12);
      if (this.isolated && this.isolated.kind === 'quadrant' && this.isolated.qIdx === i) {
        const w = this.ctx.measureText(labelText).width; this.ctx.fillRect(r.x + 12, r.y + 12 + 15, w, 1.5);
      }
      // Draw unpack token placeholders during prime
      if (this.primePhase && this._unpackTokens && this._unpackTokens.length > 0) {
        this.ctx.globalAlpha = qDim * 0.28;
        this.ctx.fillStyle = q.tint; this.ctx.font = "500 9px 'JetBrains Mono', monospace";
        this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
        let ty = r.y + 36;
        for (let ti = 0; ti < this._unpackTokens.length; ti++) {
          if (ti % 4 !== i) continue;
          this.ctx.fillText(this._unpackTokens[ti], r.x + 12, ty);
          ty += 14;
          if (ty > r.y + r.h - 12) break;
        }
      }
      this.ctx.globalAlpha = 1;
    });
    const synthDim = this.getSynthesisStripDim();
    const midTintAlpha = (0.04 + (this.synthPulse || 0)) * synthDim;
    this.ctx.fillStyle = `rgba(10,10,10,${midTintAlpha})`; this.ctx.fillRect(midRect.x, midRect.y, midRect.w, midRect.h);
    this.ctx.globalAlpha = synthDim;
    this.ctx.strokeStyle = '#0a0a0a'; this.ctx.lineWidth = this.isolated && this.isolated.kind === 'synthesis-trace' ? 2 : 1.5;
    this.ctx.setLineDash([6, 4]); this.ctx.strokeRect(midRect.x, midRect.y, midRect.w, midRect.h); this.ctx.setLineDash([]);
    this.ctx.fillStyle = '#0a0a0a'; this.ctx.font = "700 11px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
    this.ctx.fillText('· SYNTHESIS ·', midRect.x + 12, midRect.y + 10);
    if (this.isolated && this.isolated.kind === 'synthesis-trace') {
      const labelW = this.ctx.measureText('· SYNTHESIS ·').width; this.ctx.fillRect(midRect.x + 12, midRect.y + 10 + 14, labelW, 1.5);
    }
    this.ctx.globalAlpha = 1;
    this.drawSynthesisTrace(positions);
    for (const node of this.nodes) {
      const pos = positions.get(node); if (!pos) continue;
      const info = this.topicInfo(node.topic);
      const dim = this.getCardDim(node);
      this.ctx.globalAlpha = dim;
      this.ctx.fillStyle = '#fff'; this.ctx.fillRect(pos.x, pos.y, pos.w, pos.h);
      this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 1; this.ctx.strokeRect(pos.x, pos.y, pos.w, pos.h);
      this.ctx.fillStyle = info.color; this.ctx.fillRect(pos.x, pos.y, 4, pos.h);
      this.ctx.fillStyle = 'rgba(10,10,10,0.85)';
      this.ctx.font = "500 10px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
      this.wrapText(node.text, pos.x + 10, pos.y + 8, pos.w - 14, 12, Math.floor((pos.h - 16) / 12) - 1);
      if (node.type === 'resolution') { this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 2; this.ctx.strokeRect(pos.x, pos.y, pos.w, pos.h); }
    }
    this.ctx.globalAlpha = 1;
  }
}

export { SwotMode };

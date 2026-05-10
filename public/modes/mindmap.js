import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, nodeBy, relGlyph } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

const HILDEGARD_LINES = [[0, 1, 3, 5, 3, 1, 0],[0, 2, 3, 5, 3, 2, 0],[0, 2, 4, 5, 4, 2, 0]];
const LINE_STRIDE_MS = 220;

class MindmapMode extends Mode {
  isolated = null;
  hubHover = false;
  primePhase = false;
  webNodes = [];
  webEdges = [];
  firingPath = null;
  spawnTimer = 0;
  webAlpha = 0;
  webTargetAlpha = 0;
  synapseTimer = null;

  constructor() {
    super({
      mode: 'mindmap',
      aesthetic: 'ambient',
      topicFallbackColor: '#888',
      vars: {
        '--e-bg': '#f5f1e8', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(26,18,8,0.05)', '--e-accent': '#5a3818',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const { positions } = this.computeLayout();
      const mx = e.clientX, my = e.clientY;
      const cx = this.W / 2, cy = this.H / 2;
      const onHub = Math.hypot(cx - mx, cy - my) < 30;
      if (onHub !== this.hubHover) this.hubHover = onHub;
      let hit = null;
      for (const node of this.nodes) {
        const pos = positions.get(node); if (!pos) continue;
        const rad = this.bubbleRadius(node);
        if (Math.hypot(pos.x - mx, pos.y - my) < rad + 4) { hit = node; break; }
      }
      if (hit) { showTooltip(e, hit, this.topicInfo(hit.topic).color); this.app.highlightLegendTopic(hit.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
      const labelHit = !hit && !onHub ? this.labelHitTest(mx, my) : null;
      this.canvas.style.cursor = (hit || onHub || labelHit) ? 'pointer' : 'default';
    });
    this.canvas.addEventListener('mouseleave', () => { this.hubHover = false; });
    this.canvas.addEventListener('click', e => {
      const mx = e.clientX, my = e.clientY;
      const cx = this.W / 2, cy = this.H / 2;
      if (Math.hypot(cx - mx, cy - my) < 30) { this.isolated = null; return; }
      const { positions } = this.computeLayout();
      for (const node of this.nodes) {
        const pos = positions.get(node); if (!pos) continue;
        const rad = this.bubbleRadius(node);
        if (Math.hypot(pos.x - mx, pos.y - my) < rad + 4) {
          if (this.isolated && this.isolated.kind === 'node' && this.isolated.node === node) this.isolated = null;
          else this.isolated = this.computeNodeIsolation(node);
          return;
        }
      }
      const labelHit = this.labelHitTest(mx, my);
      if (labelHit) {
        if (this.isolated && this.isolated.kind === 'topic' && this.isolated.topicId === labelHit.id) this.isolated = null;
        else this.isolated = { kind: 'topic', topicId: labelHit.id };
        return;
      }
      this.isolated = null;
    });
  }

  nodeIncoming(node) { const id = node.id; return id != null ? (this.incomingRefsMap[id] ?? incomingRefsOf(id, this.nodes)) : 0; }
  nodeHasExternalBecause(node) { return Array.isArray(node.because) && node.because.some(b => typeof b === 'string'); }
  nodeIsOrphan(node) { if (Array.isArray(node.refs) && node.refs.length > 0) return false; if (this.nodeIncoming(node) > 0) return false; if (Array.isArray(node.because) && node.because.length > 0) return false; return true; }

  sideBuffer() {
    const el = document.querySelector('.topic-legend');
    if (!el) return 40;
    const rect = el.getBoundingClientRect();
    return Math.max(40, window.innerWidth - rect.left + 12);
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'mindmap');
    });
  }

  topicMidi(topicId) {
    const info = this.topicInfo(topicId);
    const freq = info.note || 440;
    const raw = Math.round(69 + 12 * Math.log2(freq / 440));
    const key = getSessionKey();
    const idx = Math.max(0, this.topics.findIndex(t => t.id === topicId));
    return key.rootMidi + ((idx * 5) % 12);
  }

  playHildegardLine(node) {
    const idx = Math.max(0, this.topics.findIndex(t => t.id === node.topic));
    const line = HILDEGARD_LINES[idx % HILDEGARD_LINES.length];
    const baseMidi = this.topicMidi(node.topic);
    line.forEach((semi, i) => {
      setTimeout(() => playSynth({ midi: baseMidi + semi, wave: 'triangle', attack: 0.10, decay: 0.20, sustain: 0.4, release: 0.30, duration: 0.30, vol: 0.09, reverbSend: 0.7 }), i * LINE_STRIDE_MS);
    });
  }

  startSynapticFiring() {
    if (this.synapseTimer) return;
    const tick = () => {
      if (!this.synapseTimer) return;
      const cutoff = 800 + Math.random() * 400;
      playSynth({ freq: 440, wave: 'sawtooth', voices: 4, detune: 50, attack: 0.001, decay: 0.015, sustain: 0.3, release: 0.01, duration: 0.03, vol: 0.04, filter: { type: 'bandpass', freq: cutoff, Q: 4 } });
      this.synapseTimer = setTimeout(tick, 280 + Math.random() * 420);
    };
    this.synapseTimer = setTimeout(tick, 280);
  }

  stopSynapticFiring() { if (this.synapseTimer) { clearTimeout(this.synapseTimer); this.synapseTimer = null; } }

  computeNodeIsolation(node) {
    const ancestors = new Set(), descendants = new Set();
    for (const refId of (node.refs || [])) { const target = this.nodes.find(n => n.id === refId); if (target) ancestors.add(target); }
    for (const other of this.nodes) { if (other.refs && other.refs.includes(node.id)) descendants.add(other); }
    return { kind: 'node', node, ancestors, descendants };
  }

  getNodeDim(node) {
    if (this.isolated) {
      if (this.isolated.kind === 'node') { if (node === this.isolated.node || this.isolated.ancestors.has(node) || this.isolated.descendants.has(node)) return 1; return 0.14; }
      if (this.isolated.kind === 'topic') return node.topic === this.isolated.topicId ? 1 : 0.14;
    }
    const ht = this.app.highlightedTopic;
    return ht && ht !== node.topic ? 0.18 : 1;
  }

  getBranchDim(topicId) {
    if (this.isolated) {
      if (this.isolated.kind === 'node') return this.isolated.node.topic === topicId ? 1 : 0.22;
      if (this.isolated.kind === 'topic') return topicId === this.isolated.topicId ? 1 : 0.16;
    }
    const ht = this.app.highlightedTopic;
    return ht && ht !== topicId ? 0.18 : 1;
  }

  buildNeuralWeb() {
    const cx = this.W / 2, cy = this.H / 2;
    const buf = this.sideBuffer(), maxR = Math.min(this.W - buf * 2, this.H) * 0.35;
    const innerR = 55; this.webNodes = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const angBase = (i / N) * Math.PI * 2, ang = angBase + (Math.random() - 0.5) * 0.35;
      const r = innerR + Math.random() * (maxR - innerR);
      this.webNodes.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
    }
    this.webEdges = []; const seen = new Set();
    for (let i = 0; i < N; i++) {
      const dists = [];
      for (let j = 0; j < N; j++) { if (i === j) continue; dists.push({ idx: j, d: Math.hypot(this.webNodes[i].x - this.webNodes[j].x, this.webNodes[i].y - this.webNodes[j].y) }); }
      dists.sort((a, b) => a.d - b.d);
      const k = 2 + Math.floor(Math.random() * 2);
      for (let m = 0; m < k; m++) { const a = Math.min(i, dists[m].idx), b = Math.max(i, dists[m].idx); const key = `${a}:${b}`; if (!seen.has(key)) { seen.add(key); this.webEdges.push({ a, b }); } }
    }
  }

  spawnFiringPath() {
    if (this.webNodes.length === 0) return;
    const maxLen = 3 + Math.floor(Math.random() * 3), start = Math.floor(Math.random() * this.webNodes.length);
    const visited = new Set([start]), path = [start];
    for (let i = 0; i < maxLen - 1; i++) {
      const current = path[path.length - 1], neighbours = [];
      for (const e of this.webEdges) { if (e.a === current && !visited.has(e.b)) neighbours.push(e.b); else if (e.b === current && !visited.has(e.a)) neighbours.push(e.a); }
      if (neighbours.length === 0) break;
      const next = neighbours[Math.floor(Math.random() * neighbours.length)]; path.push(next); visited.add(next);
    }
    if (path.length >= 2) this.firingPath = { dots: path, age: 0, maxAge: 54 };
  }

  startPrime() {
    this.primePhase = true; this.buildNeuralWeb(); this.firingPath = null; this.spawnTimer = 18;
    this.webTargetAlpha = 1; this.startSynapticFiring();
  }

  stopPrime() { this.primePhase = false; this.webTargetAlpha = 0; this.stopSynapticFiring(); }

  simulatePrime() {
    this.webAlpha += (this.webTargetAlpha - this.webAlpha) * 0.07;
    if (this.primePhase) { this.spawnTimer--; if (this.spawnTimer <= 0) { this.spawnFiringPath(); this.spawnTimer = 32 + Math.floor(Math.random() * 14); } }
    if (this.firingPath) { this.firingPath.age++; if (this.firingPath.age > this.firingPath.maxAge) this.firingPath = null; }
  }

  drawNeuralWeb() {
    if (this.webAlpha < 0.01 && !this.firingPath) return;
    this.ctx.lineWidth = 0.6; this.ctx.strokeStyle = `rgba(120, 145, 170, ${this.webAlpha * 0.28})`;
    this.ctx.beginPath();
    for (const e of this.webEdges) { this.ctx.moveTo(this.webNodes[e.a].x, this.webNodes[e.a].y); this.ctx.lineTo(this.webNodes[e.b].x, this.webNodes[e.b].y); }
    this.ctx.stroke();
    this.ctx.fillStyle = `rgba(100, 125, 150, ${this.webAlpha * 0.55})`;
    for (const n of this.webNodes) { this.ctx.beginPath(); this.ctx.arc(n.x, n.y, 1.8, 0, Math.PI * 2); this.ctx.fill(); }
    if (this.firingPath) {
      const t = this.firingPath.age / this.firingPath.maxAge, dotsN = this.firingPath.dots.length;
      const envelope = t < 0.15 ? t / 0.15 : t > 0.75 ? (1 - t) / 0.25 : 1;
      for (let i = 0; i < dotsN; i++) {
        const dotStart = (i / dotsN) * 0.45, dotOn = Math.max(0, Math.min(1, (t - dotStart) / 0.1)), alpha = dotOn * envelope;
        if (alpha < 0.02) continue;
        const n = this.webNodes[this.firingPath.dots[i]];
        this.ctx.fillStyle = `rgba(180, 210, 255, ${alpha * 0.35})`; this.ctx.beginPath(); this.ctx.arc(n.x, n.y, 8, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.fillStyle = `rgba(230, 240, 255, ${alpha * 0.95})`; this.ctx.beginPath(); this.ctx.arc(n.x, n.y, 3.2, 0, Math.PI * 2); this.ctx.fill();
      }
      this.ctx.lineWidth = 1.3;
      for (let i = 0; i < dotsN - 1; i++) {
        const segStart = (i / dotsN) * 0.45 + 0.05; if (t < segStart) continue;
        const a = this.webNodes[this.firingPath.dots[i]], b = this.webNodes[this.firingPath.dots[i + 1]];
        this.ctx.strokeStyle = `rgba(200, 225, 255, ${envelope * 0.55})`; this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
      }
    }
  }

  computeLayout() {
    const buf = this.sideBuffer(), effW = this.W - buf * 2;
    const cx = this.W / 2, cy = this.H / 2;
    const n = Math.max(this.topics.length, 1), branchLen = Math.min(effW, this.H) * 0.38;
    const positions = new Map(), branches = new Map();
    this.topics.forEach((t, i) => {
      const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
      branches.set(t.id, { ang, ex: cx + Math.cos(ang) * branchLen, ey: cy + Math.sin(ang) * branchLen });
    });
    const byTopic = new Map();
    for (const nd of this.nodes) { if (!byTopic.has(nd.topic)) byTopic.set(nd.topic, []); byTopic.get(nd.topic).push(nd); }
    for (const [tid, thoughts] of byTopic) {
      const b = branches.get(tid); if (!b) continue;
      thoughts.forEach((thought, idx) => {
        const frac = 0.28 + (idx / Math.max(thoughts.length, 1)) * 0.88;
        const bx = cx + Math.cos(b.ang) * branchLen * frac, by = cy + Math.sin(b.ang) * branchLen * frac;
        const perp = b.ang + Math.PI / 2, off = (idx % 2 === 0 ? 1 : -1) * 18 * (idx > 0 ? Math.min(idx, 4) / 4 : 0);
        positions.set(thought, { x: bx + Math.cos(perp) * off, y: by + Math.sin(perp) * off });
      });
    }
    return { positions, branches, cx, cy };
  }

  bubbleRadius(node) { const conf = node.confidence || 0.7, incoming = this.nodeIncoming(node); return 10 + conf * 6 + Math.min(8, incoming * 1.2); }

  arcControl(sp, tp, cx, cy) {
    const mx = (sp.x + tp.x) / 2, my = (sp.y + tp.y) / 2;
    const dx = mx - cx, dy = my - cy, len = Math.hypot(dx, dy);
    if (len < 1) { const pdx = -(tp.y - sp.y), pdy = (tp.x - sp.x); const plen = Math.hypot(pdx, pdy) || 1; return { x: mx + (pdx / plen) * 40, y: my + (pdy / plen) * 40 }; }
    return { x: mx + (dx / len) * len * 0.5, y: my + (dy / len) * len * 0.5 };
  }

  getArcDim(src, tgt) {
    if (this.isolated) {
      if (this.isolated.kind === 'node') { const related = new Set([this.isolated.node, ...this.isolated.ancestors, ...this.isolated.descendants]); return (related.has(src) && related.has(tgt)) ? 1 : 0.12; }
      if (this.isolated.kind === 'topic') return (src.topic === this.isolated.topicId || tgt.topic === this.isolated.topicId) ? 1 : 0.12;
    }
    return 1;
  }

  drawRefsArcs(positions, cx, cy) {
    this.ctx.lineCap = 'round';
    for (const src of this.nodes) {
      if (!Array.isArray(src.refs) || src.refs.length === 0) continue;
      const sp = positions.get(src); if (!sp) continue;
      for (const refId of src.refs) {
        const tgt = nodeBy(refId, this.nodes); if (!tgt) continue;
        const tp = positions.get(tgt); if (!tp) continue;
        const cp = this.arcControl(sp, tp, cx, cy), dim = this.getArcDim(src, tgt);
        const info = this.topicInfo(src.topic);
        const [r, g, b] = hexToRgb(info.color);
        const heatMult = src.heat != null ? 0.55 + src.heat * 0.6 : 1;
        this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.4 * dim * heatMult})`; this.ctx.lineWidth = 1.1; this.ctx.setLineDash([]);
        this.ctx.beginPath(); this.ctx.moveTo(sp.x, sp.y); this.ctx.quadraticCurveTo(cp.x, cp.y, tp.x, tp.y); this.ctx.stroke();
        const arcLen = Math.hypot(tp.x - sp.x, tp.y - sp.y);
        if (arcLen >= 40 && dim > 0.3) {
          const qmx = (sp.x + 2 * cp.x + tp.x) / 4, qmy = (sp.y + 2 * cp.y + tp.y) / 4;
          const glyph = relGlyph(src.rel);
          if (glyph) { this.ctx.font = "700 10px 'JetBrains Mono', monospace"; this.ctx.fillStyle = `rgba(${r},${g},${b},${dim * 0.95})`; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText(glyph, qmx, qmy + 0.5); }
        }
      }
    }
    this.ctx.lineCap = 'butt';
  }

  drawBecauseArcs(positions, cx, cy) {
    for (const src of this.nodes) {
      if (!Array.isArray(src.because)) continue;
      const sp = positions.get(src); if (!sp) continue;
      for (const b of src.because) {
        if (typeof b !== 'number') continue;
        const tgt = nodeBy(b, this.nodes); if (!tgt || tgt === src) continue;
        const tp = positions.get(tgt); if (!tp) continue;
        const cp = this.arcControl(sp, tp, cx, cy), dim = this.getArcDim(src, tgt);
        const info = this.topicInfo(src.topic);
        const [r, g, bl] = hexToRgb(info.color);
        this.ctx.strokeStyle = `rgba(${r},${g},${bl},${0.22 * dim})`; this.ctx.lineWidth = 0.8; this.ctx.setLineDash([1, 3]);
        this.ctx.beginPath(); this.ctx.moveTo(sp.x, sp.y); this.ctx.quadraticCurveTo(cp.x, cp.y, tp.x, tp.y); this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }
  }

  labelHitTest(mx, my) {
    const { branches } = this.computeLayout();
    this.ctx.font = "500 11px 'JetBrains Mono', monospace";
    for (const t of this.topics) {
      const b = branches.get(t.id); if (!b) continue;
      const lx = b.ex + Math.cos(b.ang) * 18, ly = b.ey + Math.sin(b.ang) * 18;
      const labelText = t.label.toUpperCase(), m = this.ctx.measureText(labelText);
      const halfW = m.width / 2 + 4, halfH = 10;
      if (mx >= lx - halfW && mx <= lx + halfW && my >= ly - halfH && my <= ly + halfH) return t;
    }
    return null;
  }

  drawPromptPopup(cx, cy) {
    const prompt = this.app.prompt(); if (!prompt) return;
    const MAX = 90, text = prompt.length > MAX ? prompt.slice(0, MAX - 1) + '…' : prompt;
    this.ctx.font = "500 12px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
    const m = this.ctx.measureText(text), padX = 14, padY = 10, w = m.width + padX * 2, h = 26 + padY;
    const x = cx - w / 2, y = cy + 52;
    this.ctx.fillStyle = '#0a0a0a'; this.ctx.globalAlpha = 0.95;
    this.ctx.beginPath(); this.ctx.moveTo(cx, y - 1); this.ctx.lineTo(cx - 6, y + 6); this.ctx.lineTo(cx + 6, y + 6); this.ctx.closePath(); this.ctx.fill();
    this.ctx.fillRect(x, y, w, h); this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#f5f1e8'; this.ctx.fillText(text, cx, y + h / 2);
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: pre-seed the neural web with token-based firing paths so the
  // web pulses in a pattern shaped by the prompt before real branches arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    // Ensure the neural web is built (startPrime calls buildNeuralWeb)
    if (this.webNodes.length === 0) return;
    const N = this.webNodes.length;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const start = h % N;
      const end = (h >> 8) % N;
      if (start === end) continue;
      this.firingPath = { dots: [start, end], age: 0, maxAge: 54 };
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.playHildegardLine(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.webNodes = []; this.webEdges = []; this.firingPath = null; this.webAlpha = 0;
    this.isolated = null; this.hubHover = false;
    if (this.primePhase) this.stopPrime();
    this.primePhase = false;
  }

  // Notebook ruled paper — faint horizontal rules every 24px in pale blue.
  // The mind-map is hand-drawn. Cached.
  drawRuledPaper() {
    if (!this._ruledOff || this._ruledW !== this.W || this._ruledH !== this.H) {
      if (!this._ruledOff) this._ruledOff = document.createElement('canvas');
      this._ruledOff.width = Math.max(1, Math.ceil(this.W));
      this._ruledOff.height = Math.max(1, Math.ceil(this.H));
      this._ruledW = this.W; this._ruledH = this.H;
      const oc = this._ruledOff.getContext('2d');
      oc.clearRect(0, 0, this.W, this.H);
      oc.strokeStyle = 'rgba(70, 110, 160, 0.10)';
      oc.lineWidth = 0.6;
      const step = 24;
      for (let y = step + 0.5; y < this.H; y += step) {
        oc.beginPath();
        oc.moveTo(0, y); oc.lineTo(this.W, y);
        oc.stroke();
      }
    }
    this.ctx.drawImage(this._ruledOff, 0, 0);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.ctx.fillStyle = '#f5f1e8'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawRuledPaper();
    this.simulatePrime(); this.drawNeuralWeb();
    const { positions, branches, cx, cy } = this.computeLayout();
    for (const t of this.topics) {
      const b = branches.get(t.id); if (!b) continue;
      const dim = this.getBranchDim(t.id);
      this.ctx.strokeStyle = t.color; this.ctx.globalAlpha = 0.55 * dim; this.ctx.lineWidth = 3;
      this.ctx.beginPath(); this.ctx.moveTo(cx, cy);
      const mx = (cx + b.ex) / 2 + Math.cos(b.ang + Math.PI / 2) * 28, my = (cy + b.ey) / 2 + Math.sin(b.ang + Math.PI / 2) * 28;
      this.ctx.quadraticCurveTo(mx, my, b.ex, b.ey); this.ctx.stroke();
    }
    this.ctx.globalAlpha = 1;
    this.drawBecauseArcs(positions, cx, cy); this.drawRefsArcs(positions, cx, cy);
    for (const node of this.nodes) {
      const pos = positions.get(node); if (!pos) continue;
      const info = this.topicInfo(node.topic), dim = this.getNodeDim(node);
      const [r, g, bl] = hexToRgb(info.color), rad = this.bubbleRadius(node);
      const orphanMult = this.nodeIsOrphan(node) ? 0.55 : 1;
      const heat = node.heat;
      if (heat != null && heat > 0.1 && dim > 0.3) {
        const haloR = rad + 3 + heat * 7;
        const grad = this.ctx.createRadialGradient(pos.x, pos.y, rad, pos.x, pos.y, haloR);
        grad.addColorStop(0, `rgba(${r},${g},${bl},${0.28 * dim * heat})`); grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
        this.ctx.fillStyle = grad; this.ctx.beginPath(); this.ctx.arc(pos.x, pos.y, haloR, 0, Math.PI * 2); this.ctx.fill();
      }
      const stance = node.stance;
      if (stance === 'questioning') {
        this.ctx.strokeStyle = `rgba(${r},${g},${bl},${dim * orphanMult})`; this.ctx.lineWidth = 1.8;
        this.ctx.beginPath(); this.ctx.arc(pos.x, pos.y, rad, 0, Math.PI * 2); this.ctx.stroke();
      } else {
        const fillAlpha = 0.72 * dim * orphanMult * (stance === 'conceding' ? 0.45 : stance === 'exploring' ? 0.85 : 1);
        this.ctx.fillStyle = `rgba(${r},${g},${bl},${fillAlpha})`; this.ctx.beginPath(); this.ctx.arc(pos.x, pos.y, rad, 0, Math.PI * 2); this.ctx.fill();
        if (stance === 'exploring') {
          this.ctx.strokeStyle = `rgba(${r},${g},${bl},${dim * orphanMult * 0.9})`; this.ctx.lineWidth = 1.2; this.ctx.setLineDash([3, 3]);
          this.ctx.beginPath(); this.ctx.arc(pos.x, pos.y, rad, 0, Math.PI * 2); this.ctx.stroke(); this.ctx.setLineDash([]);
        }
      }
      if (node.type === 'resolution') { this.ctx.strokeStyle = `rgba(${r},${g},${bl},${dim})`; this.ctx.lineWidth = 2; this.ctx.beginPath(); this.ctx.arc(pos.x, pos.y, rad + 4, 0, Math.PI * 2); this.ctx.stroke(); }
      if (node.type === 'dead-end') { this.ctx.strokeStyle = `rgba(${r},${g},${bl},${0.6 * dim})`; this.ctx.lineWidth = 1.5; this.ctx.beginPath(); this.ctx.moveTo(pos.x - rad, pos.y - rad); this.ctx.lineTo(pos.x + rad, pos.y + rad); this.ctx.stroke(); }
      if (this.nodeHasExternalBecause(node) && dim > 0.3) { this.ctx.fillStyle = `rgba(${r},${g},${bl},${0.75 * dim})`; this.ctx.font = "600 11px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle'; this.ctx.fillText('↗', pos.x + rad + 2, pos.y - rad + 2); }
      if (this.isolated && this.isolated.kind === 'node' && this.isolated.node === node) { this.ctx.strokeStyle = '#0a0a0a'; this.ctx.globalAlpha = 0.9; this.ctx.lineWidth = 2; this.ctx.beginPath(); this.ctx.arc(pos.x, pos.y, rad + 7, 0, Math.PI * 2); this.ctx.stroke(); this.ctx.globalAlpha = 1; }
    }
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#0a0a0a'; this.ctx.beginPath(); this.ctx.arc(cx, cy, 30, 0, Math.PI * 2); this.ctx.fill();
    this.ctx.fillStyle = '#f5f1e8'; this.ctx.font = "700 18px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText('?', cx, cy);
    this.ctx.font = "500 11px 'JetBrains Mono', monospace";
    for (const t of this.topics) {
      const b = branches.get(t.id); if (!b) continue;
      const labelDim = this.getBranchDim(t.id);
      const isLocked = this.isolated && this.isolated.kind === 'topic' && this.isolated.topicId === t.id;
      this.ctx.fillStyle = t.color; this.ctx.globalAlpha = labelDim;
      this.ctx.font = isLocked ? "700 11px 'JetBrains Mono', monospace" : "500 11px 'JetBrains Mono', monospace";
      const lx = b.ex + Math.cos(b.ang) * 18, ly = b.ey + Math.sin(b.ang) * 18;
      this.ctx.fillText(t.label.toUpperCase(), lx, ly);
    }
    if (this.hubHover) this.drawPromptPopup(cx, cy);
    this.ctx.globalAlpha = 1; this.ctx.textAlign = 'start';
  }
}

export { MindmapMode };

import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, nodeBy } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey } from '/synth.js';

const PAD_Y = 80;
const GHOST_TYPES = ['claim', 'branch', 'choice', 'dead-end', 'aside', 'resolution'];

class WaveformMode extends Mode {
  primePhase = false;
  ghostBursts = [];
  ghostSpawnTimer = 0;
  isolatedTopic = null;
  cursors = [];
  laneDrones = new Map();

  constructor() {
    super({
      mode: 'waveform',
      aesthetic: 'industrial',
      topicFallbackColor: '#5aff9e',
      vars: {
        '--e-bg': '#060a0d', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#f0d8f0', '--e-pivot-tint': 'rgba(168,112,24,0.06)', '--e-accent': '#a87018',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const nHit = this.nodeAtPoint(mx, my);
      if (nHit) { showTooltip(e, nHit, this.topicInfo(nHit.topic).color); this.app.highlightLegendTopic(nHit.topic); this.canvas.style.cursor = 'pointer'; return; }
      hideTooltip(); this.app.highlightLegendTopic(null);
      if (this.laneLabelAtPoint(mx, my)) { this.canvas.style.cursor = 'pointer'; return; }
      this.canvas.style.cursor = 'crosshair';
    });
    this.canvas.addEventListener('mouseleave', () => { this.canvas.style.cursor = 'crosshair'; });
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.primePhase) {
        if (!this.inPlotArea(mx, my)) return;
        this.spawnGhostBurst(mx);
        this.ghostBursts[this.ghostBursts.length - 1].userPlaced = true;
        this.ghostBursts[this.ghostBursts.length - 1].maxAge = 140;
        return;
      }
      const labelTopic = this.laneLabelAtPoint(mx, my);
      if (labelTopic) { this.isolatedTopic = (this.isolatedTopic === labelTopic.id) ? null : labelTopic.id; return; }
      const nHit = this.nodeAtPoint(mx, my);
      if (nHit) { nHit.pingT = 0; this.playVCOGate(nHit); return; }
      if (this.inPlotArea(mx, my)) { if (this.cursors.length >= 2) this.cursors = []; this.cursors.push({ x: mx }); return; }
      this.isolatedTopic = null;
    });
  }

  nodeIncoming(n) { return n.id != null ? (this.incomingRefsMap[n.id] ?? incomingRefsOf(n.id, this.nodes)) : 0; }
  padX() {
    const el = document.querySelector('.topic-legend');
    if (!el) return 80;
    const rect = el.getBoundingClientRect();
    return Math.max(80, window.innerWidth - rect.left + 12);
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('industrial');
      pickSessionKey(this.app.prompt() || 'waveform');
    });
  }

  startLaneDrone(topicId, hz) {
    const prev = this.laneDrones.get(topicId);
    if (prev) { try { prev.stop(); } catch {} }
    const handle = playSynth({ freq: hz, wave: 'sine', voices: 2, detune: 6, attack: 1.4, decay: 0.6, sustain: 0.7, release: 2.8, duration: 6.0, vol: 0.038, reverbSend: 0.30, delaySend: 0.10 });
    this.laneDrones.set(topicId, handle);
  }

  stopAllDrones() { this.laneDrones.forEach(h => { try { h.stop(); } catch {} }); this.laneDrones.clear(); }

  gateSwell(hz, opts = {}) {
    const { attack = 0.02, decay = 0.10, sustain = 0.5, release = 0.30, duration = 0.20, vol = 0.13, voices = 1, detune = 0 } = opts;
    playSynth({ freq: hz, wave: 'sine', voices, detune, attack, decay, sustain, release, duration, vol, reverbSend: 0.35, delaySend: 0.20 });
  }

  amPatch(targetHz, sourceHz, depth = 0.6, dur = 0.7) {
    const rate = Math.max(4, Math.min(18, sourceHz / 32));
    playSynth({ freq: targetHz, wave: 'sine', voices: 1, attack: 0.05, decay: 0.18, sustain: 0.7, release: 0.5, duration: dur, vol: 0.09, tremolo: { rate, depth, shape: 'sine' }, reverbSend: 0.30, delaySend: 0.15 });
  }

  playVCOGate(node) {
    this.initAural();
    const hz = this.topicInfo(node.topic).note || 440;
    this.startLaneDrone(node.topic, hz);
    const t = node.type;
    if (t === 'claim') this.gateSwell(hz, { attack: 0.02, decay: 0.10, duration: 0.25, vol: 0.13 });
    else if (t === 'branch') { this.gateSwell(hz, { attack: 0.015, decay: 0.08, duration: 0.15, vol: 0.11 }); setTimeout(() => this.gateSwell(hz, { attack: 0.015, decay: 0.08, duration: 0.15, vol: 0.10 }), 110); }
    else if (t === 'choice') { this.gateSwell(hz, { attack: 0.01, decay: 0.06, duration: 0.10, vol: 0.10 }); setTimeout(() => this.gateSwell(hz * 1.06, { attack: 0.01, decay: 0.06, duration: 0.10, vol: 0.09 }), 60); setTimeout(() => this.gateSwell(hz * 1.12, { attack: 0.01, decay: 0.06, duration: 0.10, vol: 0.09 }), 120); }
    else if (t === 'dead-end') this.gateSwell(hz, { voices: 2, detune: 22, attack: 0.04, decay: 0.18, sustain: 0.4, release: 0.50, duration: 0.45, vol: 0.10 });
    else if (t === 'aside') this.gateSwell(hz * 2, { attack: 0.01, decay: 0.05, duration: 0.08, vol: 0.07 });
    else if (t === 'resolution') this.gateSwell(hz, { attack: 0.10, decay: 0.30, sustain: 0.6, release: 1.2, duration: 0.9, vol: 0.10 });
    else this.gateSwell(hz, { duration: 0.2, vol: 0.10 });
    if (Array.isArray(node.refs) && node.refs.length > 0) {
      node.refs.forEach((refId, i) => {
        const tgt = nodeBy(refId, this.nodes); if (!tgt || tgt.topic === node.topic) return;
        const tgtHz = this.topicInfo(tgt.topic).note || 440;
        const depth = node.rel === 'contradicts' ? 0.85 : 0.55;
        setTimeout(() => this.amPatch(tgtHz, hz, depth, 0.75), 200 + i * 90);
      });
    }
  }

  burstDisplacement(type, confidence, d, heatMult, widthMult) {
    const hm = heatMult != null ? heatMult : 1, wm = widthMult != null ? widthMult : 1;
    const amp = (14 + confidence * 22) * hm, dd = d / wm;
    switch (type) {
      case 'claim': return amp * Math.exp(-dd * dd / 90);
      case 'branch': return amp * 0.75 * (Math.exp(-((dd - 9) ** 2) / 35) + Math.exp(-((dd + 9) ** 2) / 35));
      case 'choice': return amp * Math.sin(dd * 0.42) * Math.exp(-dd * dd / 650);
      case 'dead-end': if (dd < -2) return 0; return amp * Math.exp(-Math.max(0, dd) * 0.10) * Math.cos(Math.max(0, dd) * 0.38);
      case 'aside': return amp * 0.35 * Math.exp(-dd * dd / 140);
      case 'resolution': if (Math.abs(dd) > 48) return 0; return amp * 0.55 * (((dd % 14) / 14 - 0.5) * 2) * Math.cos((dd / 48) * Math.PI / 2);
    }
    return 0;
  }

  updatePositions() {
    const px = this.padX(), plotW = this.W - px * 2, n = this.nodes.length;
    for (let i = 0; i < n; i++) this.nodes[i].x = n === 1 ? this.W / 2 : px + (i + 0.5) / n * plotW;
  }

  laneLayout() {
    const T = this.topics.length, plotH = this.H - PAD_Y * 2;
    const lane = T > 0 ? Math.min(120, plotH / T) : 0;
    return { lane, firstY: PAD_Y + lane * 0.5 };
  }

  spawnGhostBurst(x) {
    const type = GHOST_TYPES[Math.floor(Math.random() * GHOST_TYPES.length)];
    this.ghostBursts.push({ x, type, confidence: 0.45 + Math.random() * 0.3, age: 0, maxAge: 100 + Math.random() * 60, userPlaced: false });
  }

  startPrime() { this.primePhase = true; this.ghostBursts = []; this.ghostSpawnTimer = 15; }
  stopPrime() { this.primePhase = false; }

  simulatePrime() {
    if (this.primePhase) {
      this.ghostSpawnTimer--;
      if (this.ghostSpawnTimer <= 0 && this.ghostBursts.length < 4) {
        const margin = 100, rx = margin + Math.random() * (this.W - margin * 2);
        this.spawnGhostBurst(rx); this.ghostSpawnTimer = 45 + Math.random() * 40;
      }
    }
    for (let i = this.ghostBursts.length - 1; i >= 0; i--) { this.ghostBursts[i].age++; if (this.ghostBursts[i].age > this.ghostBursts[i].maxAge) this.ghostBursts.splice(i, 1); }
  }

  simulatePings() {
    for (const n of this.nodes) {
      if (n.pingT != null) {
        n.pingT++;
        const dur = 30;
        if (n.pingT >= dur) { n.pingT = null; n.pingBoost = 1; continue; }
        n.pingBoost = 1 + Math.sin(n.pingT / dur * Math.PI) * 1.0;
      }
    }
  }

  nodeAtPoint(mx, my) {
    const L = this.laneLayout(); let closest = null, cd = 32;
    for (const n of this.nodes) {
      const topicIdx = this.topics.findIndex(tp => tp.id === n.topic); if (topicIdx < 0) continue;
      const laneY = L.firstY + topicIdx * L.lane, d = Math.hypot(n.x - mx, laneY - my);
      if (d < cd) { cd = d; closest = n; }
    }
    return closest;
  }

  laneLabelAtPoint(mx, my) {
    const L = this.laneLayout(), px = this.padX();
    if (mx > px || mx < px - 120) return null;
    for (let i = 0; i < this.topics.length; i++) { const laneY = L.firstY + i * L.lane; if (Math.abs(laneY - my) < L.lane * 0.5) return this.topics[i]; }
    return null;
  }

  inPlotArea(mx, my) {
    const px = this.padX();
    return mx >= px && mx <= this.W - px && my >= PAD_Y * 0.6 && my <= this.H - PAD_Y * 0.6;
  }

  drawGhostBursts() {
    if (this.ghostBursts.length === 0) return;
    const baselineY = this.H / 2, step = 2, px = this.padX();
    for (const gb of this.ghostBursts) {
      const t = gb.age / gb.maxAge, env = t < 0.2 ? t / 0.2 : t > 0.8 ? (1 - t) / 0.2 : 1, alpha = env * 0.55;
      if (alpha < 0.01) continue;
      const pts = [];
      for (let x = Math.max(px, gb.x - 80); x <= Math.min(this.W - px, gb.x + 80); x += step) { pts.push([x, baselineY - this.burstDisplacement(gb.type, gb.confidence, x - gb.x)]); }
      if (pts.length < 2) continue;
      this.ctx.strokeStyle = `rgba(140, 175, 160, ${alpha * 0.4})`; this.ctx.lineWidth = 4; this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
      this.ctx.beginPath(); this.ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i][0], pts[i][1]);
      this.ctx.stroke();
      this.ctx.strokeStyle = `rgba(180, 210, 190, ${alpha})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i][0], pts[i][1]);
      this.ctx.stroke();
    }
  }

  drawCursors() {
    if (this.cursors.length === 0) return;
    for (const c of this.cursors) {
      this.ctx.strokeStyle = 'rgba(255, 235, 150, 0.7)'; this.ctx.lineWidth = 0.9; this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath(); this.ctx.moveTo(c.x, PAD_Y * 0.5); this.ctx.lineTo(c.x, this.H - PAD_Y * 0.5); this.ctx.stroke(); this.ctx.setLineDash([]);
    }
    if (this.cursors.length === 2) {
      const dx = Math.abs(this.cursors[1].x - this.cursors[0].x), midX = (this.cursors[0].x + this.cursors[1].x) / 2, y = PAD_Y * 0.4;
      this.ctx.strokeStyle = 'rgba(255, 235, 150, 0.85)'; this.ctx.lineWidth = 0.8;
      this.ctx.beginPath(); this.ctx.moveTo(this.cursors[0].x, y); this.ctx.lineTo(this.cursors[1].x, y); this.ctx.stroke();
      this.ctx.fillStyle = 'rgba(255, 235, 150, 0.9)'; this.ctx.font = '10px "JetBrains Mono", monospace'; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'bottom';
      this.ctx.fillText(`Δ ${Math.round(dx)}px`, midX, y - 4);
    }
  }

  drawGrid() {
    this.ctx.strokeStyle = 'rgba(90, 220, 160, 0.06)'; this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    for (let x = 0; x <= this.W; x += 50) { this.ctx.moveTo(x, 0); this.ctx.lineTo(x, this.H); }
    for (let y = 0; y <= this.H; y += 30) { this.ctx.moveTo(0, y); this.ctx.lineTo(this.W, y); }
    this.ctx.stroke();
  }

  drawBatchRules() {
    if (this.nodes.length < 2) return;
    this.ctx.strokeStyle = 'rgba(90, 220, 160, 0.14)'; this.ctx.lineWidth = 1; this.ctx.setLineDash([2, 4]);
    for (let i = 1; i < this.nodes.length; i++) {
      if (this.nodes[i].batch_id == null || this.nodes[i].batch_id === this.nodes[i - 1].batch_id) continue;
      const x = (this.nodes[i - 1].x + this.nodes[i].x) / 2;
      this.ctx.beginPath(); this.ctx.moveTo(x, PAD_Y * 0.5); this.ctx.lineTo(x, this.H - PAD_Y * 0.5); this.ctx.stroke();
    }
    this.ctx.setLineDash([]);
  }

  drawCrossChannelGhosts(L) {
    if (!this.sessionHasRefs()) return;
    const px = this.padX();
    for (const src of this.nodes) {
      if (!Array.isArray(src.refs) || src.refs.length === 0) continue;
      const srcLaneIdx = this.topics.findIndex(tp => tp.id === src.topic); if (srcLaneIdx < 0) continue;
      for (const refId of src.refs) {
        const tgt = nodeBy(refId, this.nodes); if (!tgt || tgt.topic === src.topic) continue;
        const tgtLaneIdx = this.topics.findIndex(tp => tp.id === tgt.topic); if (tgtLaneIdx < 0) continue;
        const tgtLaneY = L.firstY + tgtLaneIdx * L.lane;
        const polarity = src.rel === 'contradicts' ? -1 : 1;
        let dash = [], alphaMult = 0.35;
        switch (src.rel) { case 'refines': dash = [1, 3]; alphaMult = 0.28; break; case 'synthesizes': alphaMult = 0.5; break; case 'contradicts': dash = [3, 3]; alphaMult = 0.40; break; case 'questions': dash = [2, 2]; alphaMult = 0.30; break; case 'supersedes': dash = [4, 4]; alphaMult = 0.25; break; }
        const [r, g, b] = hexToRgb(this.topicInfo(src.topic).color);
        const pts = [];
        for (let x = Math.max(px, src.x - 70); x <= Math.min(this.W - px, src.x + 70); x += 2) { pts.push([x, tgtLaneY - polarity * this.burstDisplacement(src.type, src.confidence * 0.6, x - src.x, 1, 1)]); }
        if (pts.length < 2) continue;
        this.ctx.strokeStyle = `rgba(${r},${g},${b},${alphaMult})`; this.ctx.lineWidth = 0.9;
        if (dash.length) this.ctx.setLineDash(dash);
        this.ctx.beginPath(); this.ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i][0], pts[i][1]);
        this.ctx.stroke(); if (dash.length) this.ctx.setLineDash([]);
      }
    }
  }

  drawExternalSpikes(L) {
    for (const n of this.nodes) {
      if (!this.nodeHasExternalBecause(n)) continue;
      const laneIdx = this.topics.findIndex(tp => tp.id === n.topic); if (laneIdx < 0) continue;
      const laneY = L.firstY + laneIdx * L.lane;
      this.ctx.strokeStyle = 'rgba(245, 230, 170, 0.55)'; this.ctx.lineWidth = 0.8;
      this.ctx.beginPath(); this.ctx.moveTo(n.x - 2, laneY - 10); this.ctx.lineTo(n.x - 2, laneY + 10); this.ctx.moveTo(n.x + 2, laneY - 7); this.ctx.lineTo(n.x + 2, laneY + 7); this.ctx.stroke();
    }
  }

  drawLane(topic, laneIdx, lane, firstY) {
    const laneY = firstY + laneIdx * lane;
    const bursts = this.nodes.filter(n => n.topic === topic.id);
    const [r, g, b] = hexToRgb(topic.color);
    const px = this.padX();
    const isolated = this.isolatedTopic && this.isolatedTopic !== topic.id;
    this.ctx.strokeStyle = `rgba(${r},${g},${b},${isolated ? 0.08 : 0.22})`; this.ctx.lineWidth = 0.8;
    this.ctx.beginPath(); this.ctx.moveTo(px, laneY); this.ctx.lineTo(this.W - px, laneY); this.ctx.stroke();
    const labelAlpha = isolated ? 0.25 : (this.isolatedTopic === topic.id ? 1 : 0.7);
    this.ctx.fillStyle = `rgba(${r},${g},${b},${labelAlpha})`;
    this.ctx.font = `${this.isolatedTopic === topic.id ? '700 ' : ''}9px "JetBrains Mono", monospace`;
    this.ctx.textAlign = 'right'; this.ctx.textBaseline = 'middle';
    this.ctx.fillText(topic.label.toUpperCase(), px - 10, laneY);
    if (bursts.length === 0) return;
    const step = 2, pts = [];
    for (let x = px; x <= this.W - px; x += step) {
      let y = laneY;
      for (const bu of bursts) {
        const heatMult = bu.heat != null ? 1 + bu.heat * 0.9 : 1, widthMult = 1 + Math.min(1.2, this.nodeIncoming(bu) * 0.25);
        y -= this.burstDisplacement(bu.type, bu.confidence, x - bu.x, heatMult, widthMult) * (bu.pingBoost || 1);
      }
      pts.push([x, y]);
    }
    const glowA = isolated ? 0.08 : 0.25, innerA = isolated ? 0.3 : 0.95;
    this.ctx.strokeStyle = `rgba(${r},${g},${b},${glowA})`; this.ctx.lineWidth = 5; this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    this.ctx.beginPath(); this.ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i][0], pts[i][1]);
    this.ctx.stroke();
    this.ctx.strokeStyle = `rgba(${Math.min(255,r+40)},${Math.min(255,g+40)},${Math.min(255,b+40)},${innerA})`; this.ctx.lineWidth = 1.3;
    this.ctx.beginPath(); this.ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i][0], pts[i][1]);
    this.ctx.stroke();
  }

  onTopics(t) {
    this.initAural();
    t.forEach(nt => this.startLaneDrone(nt.id, nt.note || 440));
    this.updatePositions();
  }

  onStart() {
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: place one ghost burst (timeline marker) per token at a
  // hashed X position along the timeline. Uses existing ghost burst system.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    const px = this.padX();
    const plotW = this.W - px * 2;
    const types = ['claim', 'branch', 'choice', 'aside', 'dead-end', 'resolution'];
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const x = px + (h % Math.max(1, Math.round(plotW)));
      const type = types[(h >> 4) % types.length];
      const confidence = 0.3 + ((h >> 8) % 40) / 100;
      this.ghostBursts.push({
        x, type, confidence,
        age: 0,
        maxAge: 160 + ((h >> 12) % 80),
        userPlaced: false,
      });
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    n.x = 0; n.pingT = null; n.pingBoost = 1;
    this.updatePositions();
    this.playVCOGate(n);
    this._afterglow = Math.min(1, (this._afterglow || 0) + 0.18);
  }

  onDone() { this.stopPrime(); this.stopAllDrones(); }
  onError() { this.stopPrime(); this.stopAllDrones(); }
  onStop() { this.stopPrime(); this.stopAllDrones(); }

  onClear() {
    this.stopAllDrones();
    this.ghostBursts = []; this.primePhase = false;
    this.isolatedTopic = null; this.cursors = [];
    this.canvas.style.cursor = 'crosshair';
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime(); this.simulatePings();
    const g = this.ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#060a0d'); g.addColorStop(1, '#030506');
    this.ctx.fillStyle = g; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawGhostBursts();
    const L = this.laneLayout();
    this.drawBatchRules(); this.drawCrossChannelGhosts(L);
    const ht = this.app.highlightedTopic;
    for (let i = 0; i < this.topics.length; i++) {
      const dim = ht && this.topics[i].id !== ht ? 0.12 : 1;
      this.ctx.globalAlpha = dim;
      this.drawLane(this.topics[i], i, L.lane, L.firstY);
    }
    this.ctx.globalAlpha = 1;
    this.drawExternalSpikes(L); this.drawCursors();
    // Phosphor afterglow — bumped on each new burst (in onNode), decays each
    // frame. Drawn as a green wash over the screen.
    this._afterglow = (this._afterglow || 0) * 0.992;
    if (this._afterglow > 0.01) {
      this.ctx.fillStyle = `rgba(90, 255, 158, ${this._afterglow * 0.05})`;
      this.ctx.fillRect(0, 0, this.W, this.H);
    }
    // CRT curvature — radial vignette over the whole image, dimming corners
    // as a real oscilloscope tube does.
    const cx = this.W / 2, cy = this.H / 2;
    const innerR = Math.min(this.W, this.H) * 0.35;
    const outerR = Math.max(this.W, this.H) * 0.70;
    const vg = this.ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vg.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    this.ctx.fillStyle = vg;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }
}

export { WaveformMode };

import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete, nodeBy } from '/clinky.js';
import { playSynth, midiToFreq, setAesthetic, pickSessionKey, quantizeToKey, configureReverb } from '/synth.js';

const BASE_BOND = 0.28;
const BOND_STYLE = {
  supports: { width: 1.2, alpha: 0.40, dash: [] }, refines: { width: 0.8, alpha: 0.28, dash: [1, 3] },
  synthesizes: { width: 1.8, alpha: 0.55, dash: [] }, contradicts: { width: 1.0, alpha: 0.45, dash: [4, 4] },
  questions: { width: 0.9, alpha: 0.35, dash: [2, 3] }, supersedes: { width: 0.7, alpha: 0.28, dash: [5, 5] },
};

class GravityMode extends Mode {
  bodies = [];
  pairs = [];
  shockwaves = [];
  primePhase = false;
  pairSpawnTimer = 0;
  simT = 0;
  mouseX = -1;
  mouseY = -1;
  draggedBody = null;
  dragHasMoved = false;
  hoverBody = null;
  hoverStartTime = 0;
  hoveredTopic = null;

  constructor() {
    super({
      mode: 'gravity',
      aesthetic: 'classical',
      topicFallbackColor: '#888',
      vars: {
        '--e-bg': '#f5f1e8', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a4018', '--e-pivot-tint': 'rgba(168,112,24,0.08)', '--e-accent': '#5a4018',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mouseleave', () => { this.hoverBody = null; this.draggedBody = null; });
    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left; this.mouseY = e.clientY - rect.top;
      if (this.draggedBody) this.dragHasMoved = true;
      const hit = this.bodyAtPoint(this.mouseX, this.mouseY, 10);
      if (hit !== this.hoverBody) { this.hoverBody = hit; this.hoverStartTime = performance.now(); }
      if (hit) { showTooltip(e, hit, hit.color); this.app.highlightLegendTopic(hit.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('mousedown', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const hit = this.bodyAtPoint(mx, my, 6);
      if (hit) { this.draggedBody = hit; this.dragHasMoved = false; }
    });
    this.canvas.addEventListener('mouseup', e => {
      const wasDrag = this.draggedBody && this.dragHasMoved;
      this.draggedBody = null;
      if (wasDrag) return;
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (this.bodyAtPoint(mx, my, 6)) return;
      if (this.primePhase) this.spawnPair(mx, my);
      else this.spawnShockwave(mx, my);
    });
  }

  count() { return this.bodies.length; }
  legendItems() { return this.bodies; }

  nodeIncoming(body) { return body.id != null ? (this.incomingRefsMap[body.id] ?? incomingRefsOf(body.id, this.bodies)) : 0; }
  sessionHasRefs() { for (const b of this.bodies) if (Array.isArray(b.refs) && b.refs.length > 0) return true; return false; }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('classical');
      pickSessionKey(this.app.prompt() || 'gravity');
      configureReverb({ duration: 3.5, decay: 2.4, wet: 0.55 });
    });
  }

  topicMidi(topicId) {
    const info = this.topicInfo(topicId);
    const rawFreq = info.note || 440;
    const rawMidi = Math.round(69 + 12 * Math.log2(rawFreq / 440));
    return quantizeToKey(rawMidi);
  }

  playSpringBond(source, target) {
    if (!source || !target) return;
    const rel = source.rel || 'supports';
    const srcMidi = this.topicMidi(source.topic);
    const heat = typeof source.heat === 'number' ? source.heat : 0;
    const conf = typeof source.confidence === 'number' ? source.confidence : 0.7;
    const stance = source.stance;
    const forceMag = Math.abs({ supports: 1.0, refines: 0.7, synthesizes: 1.7, contradicts: 1.3, questions: 0.9, supersedes: 0.35 }[rel] || 1.0);
    let baseVol = 0.032 * (0.7 + conf * 0.4) * forceMag;
    let attack = 0.5;
    if (stance === 'claiming') { attack = 0.3; baseVol *= 1.1; }
    else if (stance === 'questioning') { attack = 0.8; baseVol *= 0.85; }
    else if (stance === 'conceding') { attack = 0.9; baseVol *= 0.6; }
    const base = { wave: 'sine', attack, decay: 0.3, sustain: 0.85, release: 2.8, duration: 3.2, reverbSend: 0.55 + heat * 0.2, delaySend: 0.12 };
    let v1Midi = srcMidi, v1Detune = 0, v1Tremolo = null, v2Midi, v2Detune = 0, v2Tremolo = null;
    if (rel === 'supports') v2Midi = srcMidi + 7;
    else if (rel === 'synthesizes') v2Midi = srcMidi + 4;
    else if (rel === 'refines') v2Midi = srcMidi + 2;
    else if (rel === 'supersedes') v2Midi = srcMidi + 12;
    else if (rel === 'contradicts') { v2Midi = srcMidi; v1Detune = -15; v2Detune = 15; }
    else if (rel === 'questions') { v2Midi = srcMidi; v1Detune = -8; v2Detune = 8; v1Tremolo = v2Tremolo = { rate: 2.5, depth: 0.55, shape: 'sine' }; }
    else v2Midi = srcMidi + 7;
    playSynth({ midi: v1Midi, ...base, detune: v1Detune, vol: baseVol, tremolo: v1Tremolo });
    playSynth({ midi: v2Midi, ...base, detune: v2Detune, vol: baseVol * 0.88, tremolo: v2Tremolo });
  }

  playArrivalBonds(node) {
    if (!node || !Array.isArray(node.refs) || node.refs.length === 0) return;
    node.refs.forEach((refId, i) => {
      const target = nodeBy(refId, this.bodies); if (!target) return;
      setTimeout(() => this.playSpringBond(node, target), i * 350);
    });
  }

  bondForce(rel) {
    switch (rel) {
      case 'supports': return BASE_BOND; case 'refines': return BASE_BOND * 0.7;
      case 'synthesizes': return BASE_BOND * 1.7; case 'contradicts': return -BASE_BOND * 1.3;
      case 'questions': return BASE_BOND * Math.sin(this.simT * 0.04);
      case 'supersedes': return BASE_BOND * 0.35; default: return BASE_BOND;
    }
  }

  spawnPair(atX, atY) {
    let cx, cy;
    if (atX !== undefined && atY !== undefined) { cx = atX; cy = atY; }
    else {
      const edge = Math.floor(Math.random() * 4), margin = 80;
      if (edge === 0) { cx = margin; cy = margin + Math.random() * (this.H - margin * 2); }
      else if (edge === 1) { cx = this.W - margin; cy = margin + Math.random() * (this.H - margin * 2); }
      else if (edge === 2) { cx = margin + Math.random() * (this.W - margin * 2); cy = margin; }
      else { cx = margin + Math.random() * (this.W - margin * 2); cy = this.H - margin; }
    }
    const sep = 45 + Math.random() * 15, ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang) * sep / 2, dy = Math.sin(ang) * sep / 2;
    const a = { x: cx - dx, y: cy - dy, vx: dx * 0.05, vy: dy * 0.05, radius: 3 + Math.random() * 1.5 };
    const b = { x: cx + dx, y: cy + dy, vx: -dx * 0.05, vy: -dy * 0.05, radius: 3 + Math.random() * 1.5 };
    this.pairs.push({ particles: [a, b], alpha: 0, targetAlpha: 0.55, age: 0, lifetime: 150 + Math.random() * 60, mergingInto: null });
  }

  startPrime() { this.primePhase = true; this.pairs = []; this.pairSpawnTimer = 10; this.spawnPair(); }
  stopPrime() { this.primePhase = false; for (const p of this.pairs) if (!p.mergingInto) p.targetAlpha = 0; }

  pairMidpoint(p) { const [a, b] = p.particles; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  mergeNearestPair(body) {
    let best = null, bestD = Infinity;
    for (const p of this.pairs) {
      if (p.mergingInto || p.targetAlpha === 0) continue;
      const m = this.pairMidpoint(p), d = Math.hypot(m.x - body.x, m.y - body.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) best.mergingInto = body;
  }

  simulatePrime() {
    if (this.primePhase) {
      this.pairSpawnTimer--;
      const live = this.pairs.filter(p => !p.mergingInto && p.targetAlpha > 0).length;
      if (this.pairSpawnTimer <= 0 && live < 3) { this.spawnPair(); this.pairSpawnTimer = 60 + Math.random() * 60; }
    }
    for (let i = this.pairs.length - 1; i >= 0; i--) {
      const p = this.pairs[i];
      p.alpha += (p.targetAlpha - p.alpha) * 0.07; p.age++;
      if (p.mergingInto) {
        const body = p.mergingInto; let consumed = 0;
        for (const q of p.particles) {
          const dx = body.x - q.x, dy = body.y - q.y, dist = Math.hypot(dx, dy) || 1;
          q.vx += (dx / dist) * 0.55; q.vy += (dy / dist) * 0.55; q.vx *= 0.9; q.vy *= 0.9;
          q.x += q.vx; q.y += q.vy;
          if (dist < body.radius + 4) consumed++;
        }
        if (consumed >= p.particles.length) { this.pairs.splice(i, 1); continue; }
      } else {
        if (this.primePhase && !p.mergingInto && p.targetAlpha === 0.55 && p.age > p.lifetime) p.targetAlpha = 0;
        const [a, b] = p.particles;
        const dx = b.x - a.x, dy = b.y - a.y, dist = Math.max(1, Math.hypot(dx, dy));
        const nx = dx / dist, ny = dy / dist, attractF = 0.08, repF = 180 / (dist * dist);
        a.vx += nx * attractF - nx * repF; a.vy += ny * attractF - ny * repF;
        b.vx -= nx * attractF - nx * repF; b.vy -= ny * attractF - ny * repF;
        for (const q of p.particles) { q.vx *= 0.95; q.vy *= 0.95; q.x += q.vx; q.y += q.vy; }
        if (p.targetAlpha === 0 && p.alpha < 0.01) { this.pairs.splice(i, 1); continue; }
      }
    }
  }

  spawnShockwave(x, y) { this.shockwaves.push({ x, y, age: 0, maxAge: 45, maxR: 200 }); }

  simulateShockwaves() {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i]; s.age++;
      if (s.age > s.maxAge) { this.shockwaves.splice(i, 1); continue; }
      const t = s.age / s.maxAge, r = s.maxR * t;
      for (const b of this.bodies) {
        if (b === this.draggedBody) continue;
        const dx = b.x - s.x, dy = b.y - s.y, dist = Math.hypot(dx, dy) || 1;
        if (Math.abs(dist - r) < 24) { const force = 3.2 * (1 - t); b.vx += (dx / dist) * force; b.vy += (dy / dist) * force; }
      }
    }
  }

  drawPairs() {
    for (const p of this.pairs) {
      if (p.alpha < 0.01) continue;
      const [a, b] = p.particles;
      this.ctx.strokeStyle = `rgba(140,130,115,${p.alpha * 0.3})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
      for (const q of p.particles) {
        this.ctx.fillStyle = `rgba(140,130,115,${p.alpha})`; this.ctx.beginPath(); this.ctx.arc(q.x, q.y, q.radius, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.strokeStyle = `rgba(100,92,82,${p.alpha * 0.6})`; this.ctx.lineWidth = 0.8; this.ctx.stroke();
      }
    }
  }

  drawShockwaves() {
    for (const s of this.shockwaves) {
      const t = s.age / s.maxAge, r = s.maxR * t, alpha = (1 - t) * 0.5;
      this.ctx.strokeStyle = `rgba(110,100,85,${alpha})`; this.ctx.lineWidth = 1.5;
      this.ctx.beginPath(); this.ctx.arc(s.x, s.y, r, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  drawBonds() {
    if (!this.sessionHasRefs()) return;
    for (const a of this.bodies) {
      if (!Array.isArray(a.refs)) continue;
      const style = BOND_STYLE[a.rel] || BOND_STYLE.supports;
      for (const refId of a.refs) {
        const b = nodeBy(refId, this.bodies); if (!b) continue;
        this.ctx.strokeStyle = a.color; this.ctx.globalAlpha = style.alpha * Math.min(a.opacity, b.opacity); this.ctx.lineWidth = style.width;
        if (style.dash.length) this.ctx.setLineDash(style.dash);
        this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke(); this.ctx.setLineDash([]);
      }
      if (Array.isArray(a.because)) {
        for (const bcId of a.because) {
          if (typeof bcId !== 'number') continue;
          const tgt = nodeBy(bcId, this.bodies); if (!tgt || tgt === a) continue;
          this.ctx.strokeStyle = a.color; this.ctx.globalAlpha = 0.18 * Math.min(a.opacity, tgt.opacity); this.ctx.lineWidth = 0.6; this.ctx.setLineDash([1, 4]);
          this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(tgt.x, tgt.y); this.ctx.stroke(); this.ctx.setLineDash([]);
        }
      }
    }
    this.ctx.globalAlpha = 1;
  }

  drawClusterReveal() {
    if (!this.hoveredTopic) return;
    const cluster = this.bodies.filter(b => b.topic === this.hoveredTopic);
    if (cluster.length === 0) return;
    if (cluster.length > 1) {
      this.ctx.strokeStyle = cluster[0].color; this.ctx.globalAlpha = 0.25; this.ctx.lineWidth = 1.2;
      for (let i = 0; i < cluster.length; i++) { for (let j = i + 1; j < cluster.length; j++) { this.ctx.beginPath(); this.ctx.moveTo(cluster[i].x, cluster[i].y); this.ctx.lineTo(cluster[j].x, cluster[j].y); this.ctx.stroke(); } }
    }
    for (const b of cluster) {
      this.ctx.strokeStyle = b.color; this.ctx.globalAlpha = 0.4; this.ctx.lineWidth = 2;
      this.ctx.beginPath(); this.ctx.arc(b.x, b.y, b.radius + 5, 0, Math.PI * 2); this.ctx.stroke();
    }
    this.ctx.globalAlpha = 1;
  }

  addBody(node) {
    const info = this.topicInfo(node.topic);
    const radius = 8 + (node.confidence || 0.7) * 25;
    const mass = node.type === 'resolution' ? 3 : node.type === 'claim' ? 1.5 : node.type === 'branch' ? 1 : node.type === 'aside' ? 0.5 : node.type === 'dead-end' ? 0.3 : 1;
    const angle = Math.random() * Math.PI * 2, dist = 50 + Math.random() * 100;
    const heatKick = node.heat != null ? node.heat * 5 : 0;
    const kickAng = Math.random() * Math.PI * 2;
    this.bodies.push({
      ...node,
      x: this.W / 2 + Math.cos(angle) * dist,
      y: this.H / 2 + Math.sin(angle) * dist,
      vx: (Math.random() - 0.5) * 2 + Math.cos(kickAng) * heatKick,
      vy: (Math.random() - 0.5) * 2 + Math.sin(kickAng) * heatKick,
      radius, baseRadius: radius, color: info.color, mass, opacity: 0,
    });
  }

  simulate() {
    this.simT++;
    const damping = 0.92, attract = 0.15, repel = 800, centerPull = 0.005;
    const v2 = this.sessionHasRefs();
    this.bodies.forEach(a => {
      if (a === this.draggedBody) {
        a.vx = (this.mouseX - a.x) * 0.4; a.vy = (this.mouseY - a.y) * 0.4;
        a.x += a.vx; a.y += a.vy;
        if (a.opacity < 1) a.opacity = Math.min(1, a.opacity + 0.03); return;
      }
      const cx = this.W / 2, cy = this.H / 2;
      a.vx += (cx - a.x) * centerPull; a.vy += (cy - a.y) * centerPull;
      this.bodies.forEach(b => {
        if (a === b) return;
        const dx = b.x - a.x, dy = b.y - a.y, dist = Math.max(1, Math.hypot(dx, dy));
        const nx = dx / dist, ny = dy / dist, repF = repel / (dist * dist);
        a.vx -= nx * repF; a.vy -= ny * repF;
        if (!v2 && a.topic === b.topic && dist > a.radius + b.radius + 20) { a.vx += nx * attract; a.vy += ny * attract; }
      });
      if (v2 && Array.isArray(a.refs)) {
        const aMass = a.mass + this.nodeIncoming(a) * 0.4;
        for (const refId of a.refs) {
          const b = nodeBy(refId, this.bodies); if (!b) continue;
          const dx = b.x - a.x, dy = b.y - a.y, dist = Math.max(1, Math.hypot(dx, dy));
          const nx = dx / dist, ny = dy / dist, f = this.bondForce(a.rel) / aMass;
          a.vx += nx * f; a.vy += ny * f;
        }
      }
      if (v2 && Array.isArray(a.because)) {
        for (const b of a.because) {
          if (typeof b !== 'number') continue;
          const tgt = nodeBy(b, this.bodies); if (!tgt || tgt === a) continue;
          const dx = tgt.x - a.x, dy = tgt.y - a.y, dist = Math.max(1, Math.hypot(dx, dy));
          const nx = dx / dist, ny = dy / dist;
          a.vx += nx * 0.08; a.vy += ny * 0.08;
        }
      }
      a.vx *= damping; a.vy *= damping; a.x += a.vx; a.y += a.vy;
      if (a.opacity < 1) a.opacity = Math.min(1, a.opacity + 0.03);
      a.x = Math.max(a.radius, Math.min(this.W - a.radius, a.x));
      a.y = Math.max(a.radius, Math.min(this.H - a.radius, a.y));
    });
  }

  bodyAtPoint(x, y, pad = 6) {
    let hit = null, hd = Infinity;
    this.bodies.forEach(b => { const d = Math.hypot(b.x - x, b.y - y); if (d < b.radius + pad && d < hd) { hd = d; hit = b; } });
    return hit;
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one ghost particle-pair per token at a hashed edge position.
  // Re-uses spawnPair so the pairs orbit and drift naturally while the model thinks.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const edge = h % 4;
      const margin = 80;
      let cx, cy;
      if (edge === 0) { cx = margin; cy = margin + ((h >> 4) % (this.H - margin * 2)); }
      else if (edge === 1) { cx = this.W - margin; cy = margin + ((h >> 4) % (this.H - margin * 2)); }
      else if (edge === 2) { cx = margin + ((h >> 4) % (this.W - margin * 2)); cy = margin; }
      else { cx = margin + ((h >> 4) % (this.W - margin * 2)); cy = this.H - margin; }
      this.spawnPair(cx, cy);
    }
  }

  onNode(n) {
    this.addBody(n);
    if (this.primePhase) { this.mergeNearestPair(this.bodies[this.bodies.length - 1]); this.stopPrime(); }
    this.playArrivalBonds(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.bodies = [];
    this.pairs = [];
    this.shockwaves = [];
    this.draggedBody = null;
    this.hoverBody = null;
    this.hoveredTopic = null;
    this.primePhase = false;
    this.simT = 0;
  }

  // Vellum — sparse warm/cool speckle tile cached as a Pattern, repeated across
  // the cream bg. Reads as the subtle mottling of animal-skin paper.
  drawVellum() {
    if (!this._vellumPattern) {
      const tile = document.createElement('canvas');
      tile.width = 96; tile.height = 96;
      const tc = tile.getContext('2d');
      const id = tc.createImageData(96, 96);
      for (let i = 0; i < 96 * 96; i++) {
        const warm = Math.random() < 0.5;
        id.data[i * 4 + 0] = warm ? 70 : 30;
        id.data[i * 4 + 1] = warm ? 55 : 28;
        id.data[i * 4 + 2] = warm ? 35 : 22;
        id.data[i * 4 + 3] = Math.random() * 24;
      }
      tc.putImageData(id, 0, 0);
      this._vellumPattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._vellumPattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulate();
    this.simulatePrime();
    this.simulateShockwaves();
    this.hoveredTopic = (this.hoverBody && performance.now() - this.hoverStartTime > 400) ? this.hoverBody.topic : null;
    this.ctx.fillStyle = '#f5f1e8'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawVellum();
    this.drawPairs(); this.drawShockwaves(); this.drawBonds(); this.drawClusterReveal();
    const byTopic = {};
    this.bodies.forEach(b => { if (!byTopic[b.topic]) byTopic[b.topic] = []; byTopic[b.topic].push(b); });
    if (!this.sessionHasRefs()) {
      Object.values(byTopic).forEach(group => {
        if (group.length < 2) return;
        this.ctx.strokeStyle = group[0].color; this.ctx.globalAlpha = 0.1; this.ctx.lineWidth = 1;
        for (let i = 1; i < group.length; i++) { this.ctx.beginPath(); this.ctx.moveTo(group[i-1].x, group[i-1].y); this.ctx.lineTo(group[i].x, group[i].y); this.ctx.stroke(); }
      });
    }
    const ht = this.app.highlightedTopic;
    this.bodies.forEach(b => {
      const orphan = (!Array.isArray(b.refs) || b.refs.length === 0) && this.nodeIncoming(b) === 0 && (!Array.isArray(b.because) || b.because.length === 0);
      const orphanMult = orphan ? 0.55 : 1;
      const stanceMult = b.stance === 'conceding' ? 0.5 : b.stance === 'exploring' ? 0.85 : 1;
      const legendDim = ht && b.topic !== ht ? 0.25 : 1;
      const totalOpacity = b.opacity * orphanMult * stanceMult * legendDim;
      this.ctx.globalAlpha = totalOpacity;
      if (b.type === 'resolution') {
        this.ctx.fillStyle = b.color; this.ctx.beginPath();
        for (let i = 0; i < 6; i++) { const a = (Math.PI/3)*i - Math.PI/2; this.ctx[i===0?'moveTo':'lineTo'](b.x+Math.cos(a)*b.radius, b.y+Math.sin(a)*b.radius); }
        this.ctx.closePath(); this.ctx.fill();
      } else if (b.type === 'dead-end') {
        this.ctx.strokeStyle = '#999'; this.ctx.lineWidth = 2;
        this.ctx.beginPath(); this.ctx.arc(b.x, b.y, b.radius*0.6, 0, Math.PI*2); this.ctx.stroke();
        const r = b.radius * 0.4;
        this.ctx.beginPath(); this.ctx.moveTo(b.x-r,b.y-r); this.ctx.lineTo(b.x+r,b.y+r); this.ctx.moveTo(b.x+r,b.y-r); this.ctx.lineTo(b.x-r,b.y+r); this.ctx.stroke();
      } else if (b.type === 'aside') {
        this.ctx.strokeStyle = b.color; this.ctx.lineWidth = 1.5; this.ctx.setLineDash([4,4]);
        this.ctx.beginPath(); this.ctx.arc(b.x, b.y, b.radius*0.7, 0, Math.PI*2); this.ctx.stroke(); this.ctx.setLineDash([]);
      } else if (b.type === 'branch') {
        this.ctx.fillStyle = b.color; this.ctx.globalAlpha = totalOpacity * 0.4;
        this.ctx.beginPath(); this.ctx.arc(b.x-b.radius*0.25, b.y, b.radius*0.6, 0, Math.PI*2); this.ctx.fill();
        this.ctx.beginPath(); this.ctx.arc(b.x+b.radius*0.25, b.y, b.radius*0.6, 0, Math.PI*2); this.ctx.fill();
      } else if (b.type === 'choice') {
        this.ctx.fillStyle = b.color; this.ctx.globalAlpha = totalOpacity * 0.7;
        const s = b.radius * 0.8; this.ctx.fillRect(b.x-s, b.y-s, s*2, s*2);
      } else {
        this.ctx.fillStyle = b.color; this.ctx.globalAlpha = totalOpacity * (0.3 + (b.confidence || 0.7) * 0.5);
        this.ctx.beginPath(); this.ctx.arc(b.x, b.y, b.radius, 0, Math.PI*2); this.ctx.fill();
      }
      if (b.stance === 'questioning') {
        this.ctx.globalAlpha = totalOpacity * 0.8; this.ctx.fillStyle = b.color;
        this.ctx.font = "700 12px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
        this.ctx.fillText('?', b.x + b.radius + 4, b.y);
      }
      if (b.heat != null && b.heat > 0.1) {
        this.ctx.globalAlpha = totalOpacity * b.heat * 0.4; this.ctx.strokeStyle = b.color; this.ctx.lineWidth = 1;
        this.ctx.beginPath(); this.ctx.arc(b.x, b.y, b.radius + 3 + b.heat * 4, 0, Math.PI * 2); this.ctx.stroke();
      }
    });
    this.ctx.globalAlpha = 1;
  }
}

export { GravityMode };

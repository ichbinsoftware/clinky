import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete, nodeBy } from '/clinky.js';
import { playSynth, midiToFreq, setAesthetic, pickSessionKey, quantizeToKey, configureReverb } from '/synth.js';

const MYCELIUM_ROOT_MIDI = 60;
const SUBHARMONIC_PALETTE = [2, 3, 4, 5, 6, 7, 8];
const MYCELIUM_DRONE_DURATION = 14;
const MYCELIUM_DRONE_RELEASE = 4;
const HYPHA_STYLE = {
  supports:    { color: '#4a9a86', width: 0.9, dash: [],      alpha: 0.55 },
  contradicts: { color: '#8b3a2e', width: 0.9, dash: [3, 3],  alpha: 0.50 },
  synthesizes: { color: '#d4a332', width: 1.5, dash: [],      alpha: 0.75 },
  refines:     { color: '#bcce9c', width: 0.7, dash: [],      alpha: 0.50 },
  questions:   { color: '#8a6aa0', width: 0.7, dash: [1, 3],  alpha: 0.42 },
  supersedes:  { color: '#706863', width: 0.7, dash: [5, 4],  alpha: 0.38 },
};
const MAX_TENDRILS = 5;

class MyceliumMode extends Mode {
  hyphae = [];
  tendrilPhase = false;
  tendrils = [];
  tendrilSpawnTimer = 0;
  tendrilBranchTimer = 0;
  nutrients = [];
  pulses = [];
  flashes = [];
  t = 0;

  constructor() {
    super({
      mode: 'mycelium',
      aesthetic: 'ambient',
      topicFallbackColor: '#eee',
      vars: {
        '--e-bg': '#1a1410', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#c8bfa8', '--e-pivot-tint': 'rgba(168,144,96,0.08)', '--e-accent': '#a89060',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.tendrilPhase) { this.nutrients.push({ x: mx, y: my, life: 420, maxLife: 420 }); this.flashes.push({ x: mx, y: my, age: 0, maxAge: 14, r: 10 }); return; }
      const hitNode = this.nodeAtPoint(mx, my);
      if (hitNode) { this.triggerPulse(hitNode); this.playMyceliumBloom(hitNode); return; }
      const hitHypha = this.hyphaAtPoint(mx, my);
      if (hitHypha) { this.severHypha(hitHypha.h, { x: hitHypha.x, y: hitHypha.y }); return; }
    });
    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let closest = null, cd = 20;
      for (const n of this.nodes) { const d = Math.hypot(n.x - mx, n.y - my); if (d < cd) { cd = d; closest = n; } }
      if (closest) { showTooltip(e, closest, closest.color); this.app.highlightLegendTopic(closest.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
  }

  nodeIncoming(n) { return n.id != null ? (this.incomingRefsMap[n.id] ?? incomingRefsOf(n.id, this.nodes)) : 0; }
  hyphaStyle(rel) { return HYPHA_STYLE[rel] || HYPHA_STYLE.supports; }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'mycelium');
      configureReverb({ duration: 5.0, decay: 3.0, wet: 0.7 });
    });
  }

  subharmonicForNode(node) {
    const id = node.id ?? 0;
    return SUBHARMONIC_PALETTE[Math.abs((id * 2654435761) | 0) % SUBHARMONIC_PALETTE.length];
  }

  myceliumRootFreq() { return midiToFreq(quantizeToKey(MYCELIUM_ROOT_MIDI)); }

  playMyceliumDrone(node) {
    const k = this.subharmonicForNode(node);
    const freq = this.myceliumRootFreq() / k;
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const conf = typeof node.confidence === 'number' ? node.confidence : 0.7;
    const stance = node.stance;
    let attack = 2.0, release = MYCELIUM_DRONE_RELEASE, volMult = 1;
    if (stance === 'claiming') { attack = 1.0; volMult = 1.1; }
    else if (stance === 'questioning') { attack = 2.5; volMult = 0.75; }
    else if (stance === 'conceding') { attack = 3.0; release = 5.5; volMult = 0.6; }
    const vol = 0.035 * (0.65 + conf * 0.4) * volMult;
    playSynth({ freq, wave: 'sine', voices: 2, detune: 3, attack, decay: 0.3, sustain: 0.92, release, duration: MYCELIUM_DRONE_DURATION, vol, reverbSend: 0.7 + heat * 0.2, delaySend: 0.12 });
  }

  playMyceliumBloom(node) {
    const k = this.subharmonicForNode(node);
    const freq = this.myceliumRootFreq() / k;
    playSynth({ freq, wave: 'sine', voices: 2, detune: 4, attack: 0.15, decay: 0.4, sustain: 0.7, release: 1.8, duration: 1.8, vol: 0.06, reverbSend: 0.6, delaySend: 0.15 });
  }

  angleDiff(a, b) { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }

  hexToRGB(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0,2), 16), parseInt(h.slice(2,4), 16), parseInt(h.slice(4,6), 16)]; }

  spawnTendril(fromPoint) {
    let x, y, heading;
    if (fromPoint) { x = fromPoint.x; y = fromPoint.y; heading = Math.random() * Math.PI * 2; }
    else {
      const edge = Math.floor(Math.random() * 4), inset = 50;
      switch (edge) {
        case 0: x = inset + Math.random() * (this.W - inset * 2); y = inset; heading = Math.PI / 2 + (Math.random() - 0.5) * 0.8; break;
        case 1: x = this.W - inset; y = inset + Math.random() * (this.H - inset * 2); heading = Math.PI + (Math.random() - 0.5) * 0.8; break;
        case 2: x = inset + Math.random() * (this.W - inset * 2); y = this.H - inset; heading = -Math.PI / 2 + (Math.random() - 0.5) * 0.8; break;
        case 3: x = inset; y = inset + Math.random() * (this.H - inset * 2); heading = 0 + (Math.random() - 0.5) * 0.8; break;
      }
    }
    this.tendrils.push({ points: [{ x, y }], heading, speed: 0.9 + Math.random() * 0.5, alpha: 0, targetAlpha: 0.55, growing: true });
  }

  startGrowing() { this.tendrilPhase = true; this.tendrils = []; this.tendrilSpawnTimer = 10; this.tendrilBranchTimer = 200; }

  stopGrowing() {
    this.tendrilPhase = false;
    this.tendrils.forEach(tr => { tr.targetAlpha = 0; tr.growing = false; });
  }

  consumeTendrilForSpawn() {
    if (this.tendrils.length === 0) return null;
    const cx = this.W / 2, cy = this.H / 2;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.tendrils.length; i++) {
      const tip = this.tendrils[i].points[this.tendrils[i].points.length - 1];
      const d = Math.hypot(tip.x - cx, tip.y - cy);
      if (d < bestD) { bestD = d; best = i; }
    }
    const tip = this.tendrils[best].points[this.tendrils[best].points.length - 1];
    return { x: tip.x, y: tip.y };
  }

  simulateTendrils() {
    if (this.tendrilPhase) {
      this.tendrilSpawnTimer--;
      if (this.tendrilSpawnTimer <= 0 && this.tendrils.length < MAX_TENDRILS) { this.spawnTendril(); this.tendrilSpawnTimer = 140 + Math.random() * 120; }
      this.tendrilBranchTimer--;
      if (this.tendrilBranchTimer <= 0 && this.tendrils.length > 0) {
        const src = this.tendrils[Math.floor(Math.random() * this.tendrils.length)];
        if (src.points.length > 15) { const idx = Math.max(1, src.points.length - 5 - Math.floor(Math.random() * 12)); this.spawnTendril(src.points[idx]); }
        this.tendrilBranchTimer = 150 + Math.random() * 180;
      }
    }
    for (let i = this.tendrils.length - 1; i >= 0; i--) {
      const tr = this.tendrils[i];
      tr.alpha += (tr.targetAlpha - tr.alpha) * 0.04;
      if (tr.lifespan != null) { tr.lifespan--; if (tr.lifespan <= 0) { tr.growing = false; tr.targetAlpha = 0; } }
      if (tr.growing) {
        tr.heading += (Math.random() - 0.5) * 0.2;
        const last = tr.points[tr.points.length - 1];
        for (const nut of this.nutrients) {
          const dx = nut.x - last.x, dy = nut.y - last.y, dist = Math.hypot(dx, dy);
          if (dist < 220 && dist > 0.1) {
            const desired = Math.atan2(dy, dx), diff = this.angleDiff(desired, tr.heading), strength = 0.12 * (1 - dist / 220);
            tr.heading += diff * strength;
            if (dist < 14) { nut.life = 0; this.flashes.push({ x: nut.x, y: nut.y, age: 0, maxAge: 36, r: 28 }); }
          }
        }
        const nx = last.x + Math.cos(tr.heading) * tr.speed, ny = last.y + Math.sin(tr.heading) * tr.speed;
        tr.points.push({ x: nx, y: ny }); if (tr.points.length > 500) tr.points.shift();
        if (nx < 30 || nx > this.W - 30 || ny < 30 || ny > this.H - 30) tr.heading += Math.PI + (Math.random() - 0.5) * 0.6;
      }
      if (!this.tendrilPhase && tr.alpha < 0.01) this.tendrils.splice(i, 1);
    }
  }

  drawTendrils() {
    for (const tr of this.tendrils) {
      if (tr.alpha < 0.005 || tr.points.length < 2) continue;
      if (tr.color) { const [r, g, b] = this.hexToRGB(tr.color); this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${tr.alpha})`; }
      else this.ctx.strokeStyle = `rgba(180, 230, 190, ${tr.alpha})`;
      this.ctx.lineWidth = 0.9; this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
      this.ctx.beginPath(); this.ctx.moveTo(tr.points[0].x, tr.points[0].y);
      for (let i = 1; i < tr.points.length; i++) this.ctx.lineTo(tr.points[i].x, tr.points[i].y);
      this.ctx.stroke();
      if (tr.growing) {
        const tip = tr.points[tr.points.length - 1];
        this.ctx.fillStyle = `rgba(220, 255, 220, ${Math.min(1, tr.alpha * 1.6)})`; this.ctx.beginPath(); this.ctx.arc(tip.x, tip.y, 1.6, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.fillStyle = `rgba(200, 255, 210, ${tr.alpha * 0.25})`; this.ctx.beginPath(); this.ctx.arc(tip.x, tip.y, 5, 0, Math.PI * 2); this.ctx.fill();
      }
    }
  }

  simulateNutrients() { for (let i = this.nutrients.length - 1; i >= 0; i--) { this.nutrients[i].life--; if (this.nutrients[i].life <= 0) this.nutrients.splice(i, 1); } }

  drawNutrients() {
    for (const n of this.nutrients) {
      const a = n.life / n.maxLife;
      this.ctx.fillStyle = `rgba(230, 220, 120, ${a * 0.12})`; this.ctx.beginPath(); this.ctx.arc(n.x, n.y, 14, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = `rgba(255, 240, 150, ${a * 0.8})`; this.ctx.beginPath(); this.ctx.arc(n.x, n.y, 2.5, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  triggerPulse(fromNode, hop = 0, maxHops = 3) {
    const outgoing = this.hyphae.filter(h => h.a === fromNode || h.b === fromNode);
    for (const h of outgoing) {
      const target = h.a === fromNode ? h.b : h.a;
      this.pulses.push({ fromX: fromNode.x, fromY: fromNode.y, toX: target.x, toY: target.y, to: target, age: 0, duration: 22, hop: hop + 1, maxHops });
    }
    this.flashes.push({ x: fromNode.x, y: fromNode.y, age: 0, maxAge: 22, r: 18 });
  }

  simulatePulses() {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i]; p.age++;
      if (p.age >= p.duration) {
        this.flashes.push({ x: p.toX, y: p.toY, age: 0, maxAge: 22, r: 18 });
        if (p.hop < p.maxHops) this.triggerPulse(p.to, p.hop, p.maxHops);
        this.pulses.splice(i, 1);
      }
    }
  }

  drawPulses() {
    for (const p of this.pulses) {
      const t = p.age / p.duration, x = p.fromX + (p.toX - p.fromX) * t, y = p.fromY + (p.toY - p.fromY) * t;
      this.ctx.fillStyle = 'rgba(255, 250, 210, 0.95)'; this.ctx.beginPath(); this.ctx.arc(x, y, 3.5, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = 'rgba(255, 250, 200, 0.25)'; this.ctx.beginPath(); this.ctx.arc(x, y, 9, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  simulateFlashes() { for (let i = this.flashes.length - 1; i >= 0; i--) { this.flashes[i].age++; if (this.flashes[i].age >= this.flashes[i].maxAge) this.flashes.splice(i, 1); } }

  drawFlashes() {
    for (const f of this.flashes) {
      const t = f.age / f.maxAge, alpha = (1 - t) * 0.7;
      this.ctx.strokeStyle = `rgba(255, 250, 200, ${alpha})`; this.ctx.lineWidth = 2 * (1 - t);
      this.ctx.beginPath(); this.ctx.arc(f.x, f.y, f.r * t + 4, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  nodeAtPoint(mx, my) {
    for (let i = this.nodes.length - 1; i >= 0; i--) { const n = this.nodes[i]; if (Math.hypot(n.x - mx, n.y - my) < n.r + 8) return n; }
    return null;
  }

  hyphaAtPoint(mx, my, threshold = 8) {
    for (let i = this.hyphae.length - 1; i >= 0; i--) {
      const h = this.hyphae[i]; if (h.growth < 0.5) continue;
      const dx = h.b.x - h.a.x, dy = h.b.y - h.a.y, lenSq = dx * dx + dy * dy;
      if (lenSq < 0.1) continue;
      let s = ((mx - h.a.x) * dx + (my - h.a.y) * dy) / lenSq;
      s = Math.max(0, Math.min(1, s));
      const px = h.a.x + s * dx, py = h.a.y + s * dy;
      if (Math.hypot(mx - px, my - py) < threshold) return { h, x: px, y: py };
    }
    return null;
  }

  severHypha(h, at) {
    const idx = this.hyphae.indexOf(h); if (idx >= 0) this.hyphae.splice(idx, 1);
    this.flashes.push({ x: at.x, y: at.y, age: 0, maxAge: 24, r: 22 });
    this.flashes.push({ x: h.a.x, y: h.a.y, age: 0, maxAge: 18, r: 14 });
    this.flashes.push({ x: h.b.x, y: h.b.y, age: 0, maxAge: 18, r: 14 });
    for (const endpoint of [h.a, h.b]) {
      const angle = Math.atan2(at.y - endpoint.y, at.x - endpoint.x) + Math.PI + (Math.random() - 0.5) * 1.2;
      this.tendrils.push({ points: [{ x: endpoint.x, y: endpoint.y }], heading: angle, speed: 1.1, alpha: 0, targetAlpha: 0.45, growing: true, lifespan: 90 + Math.random() * 40, color: endpoint.color });
    }
  }

  addNode(node, spawnPos) {
    const info = this.topicInfo(node.topic);
    // Filter out the node itself (Mode base class already pushed it to this.nodes
    // as a raw entry without x/y). We'll mutate that raw entry in place below
    // so distance-based heuristics work on a single, fully-populated copy.
    const sameTopic = this.nodes.filter(o => o.topic === node.topic && o !== node);
    let x, y;
    if (spawnPos) { x = spawnPos.x; y = spawnPos.y; }
    else if (sameTopic.length > 0 && Math.random() < 0.7) {
      const parent = sameTopic[Math.floor(Math.random() * sameTopic.length)];
      const angle = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 80;
      x = parent.x + Math.cos(angle) * dist; y = parent.y + Math.sin(angle) * dist;
    } else { x = 100 + Math.random() * (this.W - 200); y = 100 + Math.random() * (this.H - 200); }
    x = Math.max(40, Math.min(this.W - 40, x)); y = Math.max(40, Math.min(this.H - 40, y));
    // Mutate the existing node object in place — the base class push is the canonical entry.
    node.x = x;
    node.y = y;
    node.r = 3 + (node.confidence || 0.7) * 5;
    node.color = info.color;
    node.phase = Math.random() * Math.PI * 2;
    const n = node;
    const nodeHasRefs = Array.isArray(node.refs) && node.refs.length > 0;
    const sessionUsesV2 = nodeHasRefs || this.sessionHasRefs();
    if (sessionUsesV2) {
      if (nodeHasRefs) {
        for (const refId of node.refs) { const target = nodeBy(refId, this.nodes); if (!target) continue; this.hyphae.push({ a: n, b: target, growth: 0, kind: 'refs', rel: node.rel, stance: node.stance, heat: node.heat }); }
      }
      if (Array.isArray(node.because)) {
        for (const b of node.because) { if (typeof b !== 'number') continue; const target = nodeBy(b, this.nodes); if (!target || target === n) continue; this.hyphae.push({ a: n, b: target, growth: 0, kind: 'because' }); }
      }
      if (this.nodeHasExternalBecause(n)) {
        const edge = Math.floor(Math.random() * 4), inset = -30;
        let nx, ny;
        switch (edge) {
          case 0: nx = n.x + (Math.random() - 0.5) * 160; ny = inset; break;
          case 1: nx = this.W - inset; ny = n.y + (Math.random() - 0.5) * 160; break;
          case 2: nx = n.x + (Math.random() - 0.5) * 160; ny = this.H - inset; break;
          case 3: nx = inset; ny = n.y + (Math.random() - 0.5) * 160; break;
        }
        this.nutrients.push({ x: nx, y: ny, life: 360, maxLife: 360 });
      }
    } else {
      const candidates = sameTopic.map(o => ({ o, d: Math.hypot(o.x - x, o.y - y) })).sort((a, b) => a.d - b.d).slice(0, 3);
      for (const c of candidates) this.hyphae.push({ a: n, b: c.o, growth: 0, kind: 'heuristic' });
    }
  }

  onStart() {
    this.initAural();
    this.startGrowing();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: place one glowing nutrient seed per token at a hashed position.
  // Tendrils probe toward these nutrients, so the prompt seeds where the
  // exploratory network reaches during the wait.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const x = 60 + (h % (this.W - 120));
      const y = 60 + ((h >> 8) % (this.H - 120));
      this.nutrients.push({ x, y, life: 600, maxLife: 600 });
      this.flashes.push({ x, y, age: 0, maxAge: 18, r: 8 });
    }
  }

  onNode(n) {
    let spawnPos = null;
    if (this.tendrilPhase) { spawnPos = this.consumeTendrilForSpawn(); this.stopGrowing(); }
    this.addNode(n, spawnPos);
    this.playMyceliumDrone(n);
  }

  onDone() { this.stopGrowing(); }
  onError() { this.stopGrowing(); }
  onStop() { this.stopGrowing(); }

  onClear() {
    this.hyphae = [];
    this.tendrils = [];
    this.nutrients = [];
    this.pulses = [];
    this.flashes = [];
    this.tendrilPhase = false;
  }

  // Soil grain — sparse warm-brown speckle tile, slightly warmer than the bg.
  // Reads as the loam substrate the hyphae grow through. Cached as a Pattern.
  drawSoilGrain() {
    if (!this._soilPattern) {
      const tile = document.createElement('canvas');
      tile.width = 96; tile.height = 96;
      const tc = tile.getContext('2d');
      const id = tc.createImageData(96, 96);
      for (let i = 0; i < 96 * 96; i++) {
        if (Math.random() < 0.045) {
          id.data[i * 4 + 0] = 80 + Math.random() * 40;
          id.data[i * 4 + 1] = 60 + Math.random() * 30;
          id.data[i * 4 + 2] = 40 + Math.random() * 20;
          id.data[i * 4 + 3] = 4 + Math.random() * 8;
        } else {
          id.data[i * 4 + 3] = 0;
        }
      }
      tc.putImageData(id, 0, 0);
      this._soilPattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._soilPattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.t += 0.016;
    this.simulateTendrils();
    this.simulateNutrients();
    this.simulatePulses();
    this.simulateFlashes();
    const ht = this.app.highlightedTopic;
    this.ctx.fillStyle = 'rgba(26, 20, 16, 0.08)'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawSoilGrain();
    this.drawNutrients(); this.drawTendrils();
    const connected = new Set();
    for (const h of this.hyphae) { connected.add(h.a); connected.add(h.b); }
    this.ctx.lineCap = 'round';
    for (const h of this.hyphae) {
      h.growth = Math.min(1, h.growth + 0.015);
      const midX = (h.a.x + h.b.x) / 2 + Math.sin(this.t + h.a.x * 0.01) * 6;
      const midY = (h.a.y + h.b.y) / 2 + Math.cos(this.t + h.a.y * 0.01) * 6;
      const hyphaeDim = ht && h.a.topic !== ht && h.b.topic !== ht ? 0.25 : 1;
      if (h.kind === 'because') {
        this.ctx.strokeStyle = h.a.color; this.ctx.lineWidth = 0.6; this.ctx.globalAlpha = 0.32 * h.growth * hyphaeDim; this.ctx.setLineDash([2, 4]);
        this.ctx.beginPath(); this.ctx.moveTo(h.a.x, h.a.y); this.ctx.quadraticCurveTo(midX, midY, h.a.x + (h.b.x - h.a.x) * h.growth, h.a.y + (h.b.y - h.a.y) * h.growth); this.ctx.stroke(); this.ctx.setLineDash([]);
      } else if (h.kind === 'refs') {
        const s = this.hyphaStyle(h.rel); const heatMult = h.heat != null ? 0.6 + h.heat * 0.6 : 1;
        const reach = h.rel === 'questions' ? Math.min(h.growth, 0.88) : h.growth;
        this.ctx.strokeStyle = s.color; this.ctx.lineWidth = s.width; this.ctx.globalAlpha = s.alpha * h.growth * heatMult * hyphaeDim;
        if (s.dash.length) this.ctx.setLineDash(s.dash);
        this.ctx.beginPath(); this.ctx.moveTo(h.a.x, h.a.y); this.ctx.quadraticCurveTo(midX, midY, h.a.x + (h.b.x - h.a.x) * reach, h.a.y + (h.b.y - h.a.y) * reach); this.ctx.stroke();
        if (s.dash.length) this.ctx.setLineDash([]);
        if (h.rel === 'refines' && h.growth > 0.55) {
          const dx = h.b.x - h.a.x, dy = h.b.y - h.a.y, perpX = -dy * 0.09, perpY = dx * 0.09;
          this.ctx.globalAlpha = s.alpha * h.growth * heatMult * 0.55; this.ctx.lineWidth = s.width * 0.8;
          this.ctx.beginPath(); this.ctx.moveTo(midX, midY); this.ctx.lineTo(midX + perpX, midY + perpY); this.ctx.stroke();
        }
        if (h.rel === 'supersedes' && h.growth > 0.9) {
          this.ctx.globalAlpha = s.alpha * 1.3; this.ctx.lineWidth = 1;
          this.ctx.beginPath(); this.ctx.moveTo(h.b.x - 5, h.b.y - 5); this.ctx.lineTo(h.b.x + 5, h.b.y + 5); this.ctx.moveTo(h.b.x - 5, h.b.y + 5); this.ctx.lineTo(h.b.x + 5, h.b.y - 5); this.ctx.stroke();
        }
      } else {
        this.ctx.strokeStyle = h.a.color; this.ctx.lineWidth = 0.8; this.ctx.globalAlpha = 0.55 * h.growth * hyphaeDim;
        this.ctx.beginPath(); this.ctx.moveTo(h.a.x, h.a.y); this.ctx.quadraticCurveTo(midX, midY, h.a.x + (h.b.x - h.a.x) * h.growth, h.a.y + (h.b.y - h.a.y) * h.growth); this.ctx.stroke();
      }
    }
    this.ctx.globalAlpha = 1;
    for (const n of this.nodes) {
      const pulse = Math.sin(this.t * 1.5 + n.phase) * 0.2 + 1;
      const orphanMult = connected.has(n) ? 1 : 0.45;
      const heat = n.heat;
      const heatPulse = (heat != null && heat > 0.05) ? (Math.sin(this.t * 2.8 + n.phase) * 0.5 + 0.5) * heat : 0;
      const stance = n.stance;
      const nodeDim = ht && n.topic !== ht ? 0.25 : 1;
      this.ctx.globalAlpha = (0.15 + heatPulse * 0.35) * orphanMult * nodeDim; this.ctx.fillStyle = n.color;
      this.ctx.beginPath(); this.ctx.arc(n.x, n.y, n.r * pulse * (3 + heatPulse * 1.6), 0, Math.PI * 2); this.ctx.fill();
      if (stance === 'questioning') {
        this.ctx.globalAlpha = 0.85 * orphanMult * nodeDim; this.ctx.strokeStyle = n.color; this.ctx.lineWidth = 1.2;
        this.ctx.beginPath(); this.ctx.arc(n.x, n.y, n.r * pulse, 0, Math.PI * 2); this.ctx.stroke();
      } else {
        const coreAlpha = stance === 'conceding' ? 0.4 : stance === 'exploring' ? 0.65 : 0.9;
        this.ctx.globalAlpha = coreAlpha * orphanMult * nodeDim; this.ctx.fillStyle = n.color;
        this.ctx.beginPath(); this.ctx.arc(n.x, n.y, n.r * pulse, 0, Math.PI * 2); this.ctx.fill();
      }
      const incoming = this.nodeIncoming(n);
      if (incoming >= 3) {
        this.ctx.globalAlpha = 0.82 * orphanMult * nodeDim; this.ctx.fillStyle = n.color;
        const capY = n.y - n.r * pulse - 5, capR = n.r * 1.4;
        this.ctx.beginPath(); this.ctx.ellipse(n.x, capY, capR, capR * 0.6, 0, Math.PI, 2 * Math.PI); this.ctx.fill();
        this.ctx.fillRect(n.x - 1, n.y - n.r * pulse - 2, 2, 3);
      }
    }
    this.ctx.globalAlpha = 1;
    this.drawPulses(); this.drawFlashes();
  }
}

export { MyceliumMode };

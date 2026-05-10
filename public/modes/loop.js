import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, playNodeSound, playTone } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey, quantizeToKey, configureReverb } from '/synth.js';

class LoopMode extends Mode {
  rings = [];
  ghostRings = [];
  pulses = [];
  dragPoint = null;
  mouseX = -1;
  mouseY = -1;
  primePhase = false;
  ghostSpawnTimer = 0;
  ringDrones = new Map();

  constructor() {
    super({
      mode: 'loop',
      aesthetic: 'ambient',
      topicFallbackColor: '#8338ec',
      vars: {
        '--e-bg': '#04040e', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#9dbd3d', '--e-pivot-tint': 'rgba(222,48,48,0.06)', '--e-accent': '#de3030',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left; this.mouseY = e.clientY - rect.top;
      if (this.dragPoint) {
        const cx = this.W / 2, cy = this.H / 2;
        const angle = Math.atan2(this.mouseY - cy, this.mouseX - cx);
        this.dragPoint.point._overrideAngle = angle; return;
      }
      let closest = null, cd = 25;
      this.rings.forEach(r => r.points.forEach(p => {
        if (p._x) { const d = Math.hypot(p._x - this.mouseX, p._y - this.mouseY); if (d < cd) { cd = d; closest = { ...p, color: r.color }; } }
      }));
      if (closest) { showTooltip(e, closest.node, closest.color); this.app.highlightLegendTopic(closest.node.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('mouseleave', () => { if (this.dragPoint) { this.dragPoint.point._snapBack = true; this.dragPoint = null; } });
    this.canvas.addEventListener('mousedown', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const hit = this.pointAt(mx, my);
      if (hit) {
        this.dragPoint = hit;
        const cx = this.W / 2, cy = this.H / 2;
        hit.point._overrideAngle = Math.atan2(my - cy, mx - cx);
        delete hit.point._snapBack;
      }
    });
    this.canvas.addEventListener('mouseup', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (this.dragPoint) { this.dragPoint.point._snapBack = true; this.dragPoint = null; return; }
      if (this.primePhase) { this.spawnPulse(); return; }
      const ring = this.ringLineAt(mx, my);
      if (ring) { ring.speed = -ring.speed; playTone(180, 0.2, 'triangle', 0.05); }
    });
  }

  count() { return this.rings.reduce((s, r) => s + r.points.length, 0); }
  legendItems() { return this.nodes; }

  topicMidi(topicId) {
    const info = this.topicInfo(topicId);
    const rawFreq = info.note || 440;
    return quantizeToKey(Math.round(69 + 12 * Math.log2(rawFreq / 440)));
  }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    const arr = [];
    for (const ring of this.rings) for (const p of ring.points) if (p.node) arr.push(p.node);
    return incomingRefsOf(id, arr);
  }

  hasExternalBecause(n) {
    const b = n && n.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  startRingDrone(topicId, topicIdx) {
    if (this.ringDrones.has(topicId)) return;
    const midi = this.topicMidi(topicId) - 12;
    const voice = playSynth({ midi, wave: 'sine', voices: 2, detune: 4, attack: 2.0, decay: 0.4, sustain: 0.85, release: 4.0, duration: 600, vol: 0.04, reverbSend: 0.6, delaySend: 0.15 });
    this.ringDrones.set(topicId, voice);
  }

  stopAllRingDrones() {
    for (const v of this.ringDrones.values()) { try { v.stop(); } catch {} }
    this.ringDrones.clear();
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'loop');
      configureReverb({ duration: 5.0, decay: 3.2, wet: 0.7 });
    });
  }

  addPoint(node) {
    const info = this.topicInfo(node.topic);
    const topicIdx = this.topics.findIndex(t => t.id === node.topic);
    let ring = this.rings.find(r => r.topic === node.topic);
    if (!ring) {
      const computedRadius = 40 + topicIdx * 45;
      let radius = computedRadius;
      if (this.ghostRings.length > 0) {
        let best = null, bestDist = Infinity;
        for (const g of this.ghostRings) {
          if (g.consumed) continue;
          const d = Math.abs(g.baseRadius - computedRadius);
          if (d < bestDist) { bestDist = d; best = g; }
        }
        if (best) { radius = best.baseRadius; best.consumed = true; best.targetAlpha = 0; }
      }
      ring = { topic: node.topic, color: info.color, radius, speed: 0.005 + topicIdx * 0.003, points: [], angle: 0 };
      this.rings.push(ring);
      this.startRingDrone(node.topic, topicIdx);
    }
    const angleOffset = ring.points.length * (Math.PI * 2 / 12);
    ring.points.push({ angleOffset, size: 3 + node.confidence * 6, brightness: 0.3 + node.confidence * 0.7, node });
  }

  spawnGhostRing() {
    const cx = this.W / 2, cy = this.H / 2;
    const maxR = Math.min(cx, cy) - 40, minR = 60;
    let baseRadius, tries = 0;
    do { baseRadius = minR + Math.random() * (maxR - minR); tries++; }
    while (tries < 12 && this.ghostRings.some(g => Math.abs(g.baseRadius - baseRadius) < 35));
    this.ghostRings.push({ baseRadius, alpha: 0, targetAlpha: 1, breathPhase: Math.random() * Math.PI * 2, breathSpeed: 0.012 + Math.random() * 0.012, alphaPhase: Math.random() * Math.PI * 2, alphaSpeed: 0.009 + Math.random() * 0.009, consumed: false });
  }

  startPrime() { this.primePhase = true; this.ghostRings = []; this.ghostSpawnTimer = 10; }
  stopPrime() { this.primePhase = false; for (const g of this.ghostRings) g.targetAlpha = 0; }

  simulatePrime() {
    if (this.primePhase) {
      this.ghostSpawnTimer--;
      const liveCount = this.ghostRings.filter(g => !g.consumed && g.targetAlpha > 0).length;
      if (this.ghostSpawnTimer <= 0 && liveCount < 4) { this.spawnGhostRing(); this.ghostSpawnTimer = 90 + Math.random() * 90; }
    }
    for (let i = this.ghostRings.length - 1; i >= 0; i--) {
      const g = this.ghostRings[i];
      g.alpha += (g.targetAlpha - g.alpha) * 0.045;
      g.breathPhase += g.breathSpeed; g.alphaPhase += g.alphaSpeed;
      if (!this.primePhase && !g.consumed) g.alpha *= 0.95;
      if (g.targetAlpha === 0 && g.alpha < 0.01) this.ghostRings.splice(i, 1);
    }
  }

  drawGhostRings() {
    if (this.ghostRings.length === 0) return;
    const cx = this.W / 2, cy = this.H / 2;
    for (const g of this.ghostRings) {
      const breathScale = 1 + Math.sin(g.breathPhase) * 0.04;
      const alphaPulse = 0.6 + (Math.sin(g.alphaPhase) + 1) * 0.2;
      const r = g.baseRadius * breathScale;
      const boost = g.flashBoost || 0;
      const alpha = g.alpha * alphaPulse * (1 + boost * 2);
      if (alpha <= 0.005) continue;
      this.ctx.strokeStyle = `rgba(180,170,220,${alpha * 0.18})`; this.ctx.lineWidth = 0.8 + boost * 1.5;
      this.ctx.beginPath(); this.ctx.arc(cx, cy, r, 0, Math.PI * 2); this.ctx.stroke();
      this.ctx.strokeStyle = `rgba(180,170,220,${alpha * 0.06})`; this.ctx.lineWidth = 2.5 + boost * 3;
      this.ctx.beginPath(); this.ctx.arc(cx, cy, r, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  spawnPulse() {
    const cx = this.W / 2, cy = this.H / 2;
    const maxR = Math.hypot(cx, cy);
    this.pulses.push({ age: 0, maxAge: 90, maxR });
    playTone(220, 0.25, 'sine', 0.04);
  }

  simulatePulses() {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i]; p.age++;
      if (p.age > p.maxAge) { this.pulses.splice(i, 1); continue; }
      const t = p.age / p.maxAge, r = p.maxR * t;
      for (const g of this.ghostRings) {
        if (g.consumed) continue;
        if (!g.flashBoost) g.flashBoost = 0;
        const breathScale = 1 + Math.sin(g.breathPhase) * 0.04;
        const gr = g.baseRadius * breathScale;
        if (Math.abs(r - gr) < 18 && !g._pulsedBy?.has(p)) {
          g.flashBoost = Math.max(g.flashBoost, 1);
          g._pulsedBy ??= new Set(); g._pulsedBy.add(p);
        }
      }
    }
    for (const g of this.ghostRings) {
      if (g.flashBoost) g.flashBoost *= 0.92;
      if (g.flashBoost && g.flashBoost < 0.01) g.flashBoost = 0;
    }
  }

  drawPulses() {
    if (this.pulses.length === 0) return;
    const cx = this.W / 2, cy = this.H / 2;
    for (const p of this.pulses) {
      const t = p.age / p.maxAge, r = p.maxR * t, alpha = (1 - t) * 0.45;
      this.ctx.strokeStyle = `rgba(180,170,220,${alpha})`; this.ctx.lineWidth = 1.2;
      this.ctx.beginPath(); this.ctx.arc(cx, cy, r, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  pointAt(mx, my, hitR = 16) {
    let hit = null, best = hitR;
    for (const ring of this.rings) {
      for (const p of ring.points) {
        if (!p._x) continue;
        const d = Math.hypot(p._x - mx, p._y - my);
        if (d < best) { best = d; hit = { point: p, ring }; }
      }
    }
    return hit;
  }

  ringLineAt(mx, my, tol = 6) {
    const cx = this.W / 2, cy = this.H / 2;
    const d = Math.hypot(mx - cx, my - cy);
    let hit = null, best = tol;
    for (const ring of this.rings) {
      const delta = Math.abs(d - ring.radius);
      if (delta < best) { best = delta; hit = ring; }
    }
    return hit;
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one ghost orbiter per token at a hash-determined radius,
  // pre-populating the mandala silhouette before real rings arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    const cx = this.W / 2, cy = this.H / 2;
    const maxR = Math.min(cx, cy) - 40;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const baseRadius = 60 + (h % Math.max(1, Math.round(maxR - 60)));
      // Only add if no existing ghost ring is very close
      const tooClose = this.ghostRings.some(g => Math.abs(g.baseRadius - baseRadius) < 30);
      if (!tooClose) {
        this.ghostRings.push({
          baseRadius,
          alpha: 0,
          targetAlpha: 1,
          breathPhase: ((h >> 8) % 628) / 100,
          breathSpeed: 0.01 + ((h >> 12) % 12) / 1000,
          alphaPhase: ((h >> 16) % 628) / 100,
          alphaSpeed: 0.008 + ((h >> 20) % 8) / 1000,
          consumed: false,
        });
      }
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.addPoint(n);
    playNodeSound(n.type, this.topicInfo(n.topic).note);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.rings = [];
    this.ghostRings = [];
    this.pulses = [];
    this.dragPoint = null;
    this.primePhase = false;
    this.stopAllRingDrones();
    this.ctx.fillStyle = '#04040e';
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime();
    this.simulatePulses();
    this.ctx.fillStyle = 'rgba(4,4,14,0.03)';
    this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawGhostRings();
    this.drawPulses();
    const ht = this.app.highlightedTopic;
    const cx = this.W / 2, cy = this.H / 2;
    this.rings.forEach(ring => {
      ring.angle += ring.speed;
      const dim = ht && ring.topic !== ht ? 0.25 : 1;
      const [r, g, b] = hexToRgb(ring.color);
      this.ctx.strokeStyle = `rgba(${r},${g},${b},0.05)`; this.ctx.lineWidth = 0.5;
      this.ctx.beginPath(); this.ctx.arc(cx, cy, ring.radius, 0, Math.PI * 2); this.ctx.stroke();
      ring.points.forEach(p => {
        if (p._snapBack !== undefined) {
          const natural = ring.angle + p.angleOffset;
          let diff = natural - p._overrideAngle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          p._overrideAngle += diff * 0.15;
          if (Math.abs(diff) < 0.02) { delete p._overrideAngle; delete p._snapBack; }
        }
        const stance = p.node && p.node.stance;
        let baseAngle = (p._overrideAngle !== undefined) ? p._overrideAngle : (ring.angle + p.angleOffset);
        if (stance === 'questioning' && p._overrideAngle === undefined) {
          if (p._wobblePhase === undefined) p._wobblePhase = Math.random() * Math.PI * 2;
          p._wobblePhase += 0.04;
          baseAngle += Math.sin(p._wobblePhase) * 0.035;
        }
        const a = baseAngle;
        const x = cx + Math.cos(a) * ring.radius, y = cy + Math.sin(a) * ring.radius;
        p._x = x; p._y = y;
        const heat = (p.node && typeof p.node.heat === 'number') ? p.node.heat : 0;
        const heatMul = 0.7 + heat * 0.6;
        const sizeMul = (stance === 'conceding') ? 0.7 : 1;
        const brightMul = (stance === 'conceding') ? 0.55 : 1;
        const drawSize = p.size * sizeMul;
        const glow = this.ctx.createRadialGradient(x, y, 0, x, y, drawSize * 4);
        glow.addColorStop(0, `rgba(${r},${g},${b},${p.brightness * 0.15 * heatMul * brightMul * dim})`);
        glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
        this.ctx.fillStyle = glow;
        this.ctx.fillRect(x - drawSize * 4, y - drawSize * 4, drawSize * 8, drawSize * 8);
        this.ctx.fillStyle = ring.color; this.ctx.globalAlpha = p.brightness * 0.8 * brightMul * dim;
        this.ctx.beginPath(); this.ctx.arc(x, y, drawSize, 0, Math.PI * 2); this.ctx.fill();
        if (stance === 'exploring') {
          this.ctx.globalAlpha = 1; this.ctx.strokeStyle = `rgba(${r},${g},${b},0.35)`; this.ctx.lineWidth = 0.8; this.ctx.setLineDash([2, 2]);
          this.ctx.beginPath(); this.ctx.arc(x, y, drawSize * 2.2, 0, Math.PI * 2); this.ctx.stroke(); this.ctx.setLineDash([]);
        }
        const inbound = p.node ? this.nodeIncoming(p.node.id) : 0;
        if (inbound >= 3) {
          const intensity = Math.min(1, (inbound - 2) / 4);
          this.ctx.globalAlpha = 1;
          this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.28 * intensity})`; this.ctx.lineWidth = 1.1;
          this.ctx.beginPath(); this.ctx.arc(x, y, drawSize * 3.2, 0, Math.PI * 2); this.ctx.stroke();
          this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.12 * intensity})`; this.ctx.lineWidth = 2.5;
          this.ctx.beginPath(); this.ctx.arc(x, y, drawSize * 3.2, 0, Math.PI * 2); this.ctx.stroke();
        }
        if (p.node && this.hasExternalBecause(p.node)) {
          const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
          const ux = dx / d, uy = dy / d;
          const edgeR = Math.min(ux > 0 ? (this.W - x) / ux : (ux < 0 ? -x / ux : Infinity), uy > 0 ? (this.H - y) / uy : (uy < 0 ? -y / uy : Infinity));
          const ex = x + ux * edgeR, ey = y + uy * edgeR;
          const grad = this.ctx.createLinearGradient(x, y, ex, ey);
          grad.addColorStop(0, `rgba(${r},${g},${b},0.28)`); grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
          this.ctx.strokeStyle = grad; this.ctx.lineWidth = 0.8;
          this.ctx.beginPath(); this.ctx.moveTo(x, y); this.ctx.lineTo(ex, ey); this.ctx.stroke();
        }
        this.ctx.globalAlpha = 1;
        const nextIdx = (ring.points.indexOf(p) + 1) % ring.points.length;
        if (ring.points.length > 1) {
          const np = ring.points[nextIdx];
          const na = ring.angle + np.angleOffset;
          const nx = cx + Math.cos(na) * ring.radius, ny = cy + Math.sin(na) * ring.radius;
          this.ctx.strokeStyle = `rgba(${r},${g},${b},0.1)`; this.ctx.lineWidth = 0.8;
          this.ctx.beginPath(); this.ctx.moveTo(x, y); this.ctx.lineTo(nx, ny); this.ctx.stroke();
        }
      });
    });
    this.ctx.globalAlpha = 1;
  }
}

export { LoopMode };

import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete } from '/clinky.js';
import {
  playSynth, setAesthetic, pickSessionKey, quantizeToKey,
  configureReverb, configureDelay,
} from '/synth.js';

const FIBONACCI_TAPS_MS = [0, 89, 144, 233, 377, 610, 987];
const TAP_DECAY = 0.72;

const RIDGES = [
  { y: 0.15, alpha: 0.09, octaves: [{ f: 0.0028, a: 32, p: 0.4 }, { f: 0.0080, a: 11, p: 1.7 }, { f: 0.0190, a: 5, p: 2.9 }, { f: 0.0420, a: 2, p: 0.6 }] },
  { y: 0.34, alpha: 0.10, octaves: [{ f: 0.0036, a: 22, p: 2.1 }, { f: 0.0094, a: 13, p: 0.8 }, { f: 0.0220, a: 4, p: 3.4 }, { f: 0.0510, a: 1.8, p: 1.5 }] },
  { y: 0.55, alpha: 0.11, octaves: [{ f: 0.0024, a: 28, p: 4.2 }, { f: 0.0072, a: 10, p: 2.7 }, { f: 0.0170, a: 6, p: 1.1 }, { f: 0.0380, a: 2.4, p: 4.9 }] },
  { y: 0.75, alpha: 0.10, octaves: [{ f: 0.0032, a: 24, p: 0.9 }, { f: 0.0086, a: 9, p: 3.6 }, { f: 0.0210, a: 5, p: 0.3 }, { f: 0.0470, a: 2, p: 2.4 }] },
  { y: 0.92, alpha: 0.08, octaves: [{ f: 0.0026, a: 18, p: 3.3 }, { f: 0.0078, a: 8, p: 1.4 }, { f: 0.0180, a: 4, p: 4.7 }, { f: 0.0410, a: 1.6, p: 0.2 }] },
];

function ridgeYAt(ridge, x, H) {
  let dy = 0;
  for (const o of ridge.octaves) dy += o.a * Math.sin(x * o.f + o.p);
  return ridge.y * H + dy;
}

class AntminMode extends Mode {
  creatures = [];
  thinkingPhase = false;
  foragers = [];
  trails = [];
  foragerSpawnTimer = 0;

  constructor() {
    super({
      mode: 'antmin',
      aesthetic: 'ambient',
      topicFallbackColor: '#888',
      vars: {
        '--e-bg': '#1a2e1a', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#e0d375', '--e-pivot-tint': 'rgba(192,233,170,0.08)', '--e-accent': '#ff6361',
      },
      essayGetSession: () => ({
        prompt: this.app.prompt(),
        nodes: this.nodes, topics: this.topics,
      }),
    });

    this.canvas.addEventListener('click', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      this.creatures.forEach(c => {
        const d = Math.hypot(c.x - mx, c.y - my);
        if (d < 80) { c.vx += (c.x - mx) * 0.3; c.vy += (c.y - my) * 0.3; }
      });
    });
    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let closest = null, cd = 30;
      this.creatures.forEach(c => { const d = Math.hypot(c.x - mx, c.y - my); if (d < cd) { cd = d; closest = c; } });
      if (closest) { showTooltip(e, closest.node, closest.color); this.app.highlightLegendTopic(closest.node.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
  }

  count() { return this.creatures.length; }
  legendItems() { return this.creatures; }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'antmin');
      configureReverb({ duration: 3.0, decay: 2.0, wet: 0.55 });
      configureDelay({ time: 0.28, feedback: 0.45, wet: 0.35 });
    });
  }

  antminTopicMidi(topicId) {
    const info = this.topicInfo(topicId);
    const rawFreq = info.note || 440;
    const rawMidi = Math.round(69 + 12 * Math.log2(rawFreq / 440));
    return quantizeToKey(rawMidi);
  }

  playAntminCascade(node) {
    if (!node) return;
    const midi = this.antminTopicMidi(node.topic);
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const conf = typeof node.confidence === 'number' ? node.confidence : 0.7;
    const stance = node.stance;
    let baseVol = 0.065 * (0.7 + conf * 0.4);
    let wave = 'triangle';
    if (stance === 'claiming')    { wave = 'triangle'; baseVol *= 1.1; }
    else if (stance === 'exploring')  { wave = 'sine'; }
    else if (stance === 'questioning') { wave = 'triangle'; baseVol *= 0.85; }
    else if (stance === 'conceding')  { wave = 'sine'; baseVol *= 0.6; }
    FIBONACCI_TAPS_MS.forEach((delayMs, i) => {
      const vol = baseVol * Math.pow(TAP_DECAY, i);
      setTimeout(() => playSynth({
        midi, wave,
        attack: 0.003, decay: 0.06, sustain: 0.25, release: 0.35,
        duration: 0.15, vol,
        reverbSend: 0.5 + heat * 0.2,
        delaySend: 0.12,
      }), delayMs);
    });
  }

  scoutPanFor(x) {
    const half = this.W / 2;
    if (half <= 0) return 0;
    return Math.max(-1, Math.min(1, (x - half) / half));
  }

  playScoutPing(creature, arrivedPhase) {
    if (!creature || !creature.node) return;
    const midi = this.antminTopicMidi(creature.node.topic);
    const isEdge = arrivedPhase === 'edge';
    const pitch = isEdge ? midi + 12 : midi;
    const pan = isEdge ? this.scoutPanFor(creature.x) : 0;
    playSynth({
      midi: pitch, wave: 'sine', voices: 1,
      attack: 0.01, decay: 0.15, sustain: 0.25, release: 0.5,
      duration: 0.25, vol: 0.04, pan,
      reverbSend: 0.45, delaySend: 0.55,
    });
  }

  pseudoRand(seed) {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.creatures.map(c => c.node).filter(Boolean));
  }

  hasExternalBecause(n) {
    const b = n && n.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  centroidOf(nodeId) {
    let sx = 0, sy = 0, n = 0;
    for (const c of this.creatures) {
      if (c.node && c.node.id === nodeId) { sx += c.x; sy += c.y; n++; }
    }
    return n === 0 ? null : { x: sx / n, y: sy / n };
  }

  countCreaturesOfNode(nodeId) {
    let n = 0;
    for (const c of this.creatures) if (c.node && c.node.id === nodeId) n++;
    return n;
  }

  pivotTargetCount(node, inbound) {
    const base = 3 + Math.floor(node.confidence * 8);
    return base + Math.min(inbound - 2, 6) * 2;
  }

  applyPivotGrowth() {
    const seen = new Set();
    for (const c of this.creatures) {
      if (!c.node || seen.has(c.node.id)) continue;
      seen.add(c.node.id);
      const inbound = this.nodeIncoming(c.node.id);
      if (inbound < 3) continue;
      const target = this.pivotTargetCount(c.node, inbound);
      const current = this.countCreaturesOfNode(c.node.id);
      if (current < target) this.growCluster(c.node, target - current);
    }
  }

  growCluster(node, extra) {
    const center = this.centroidOf(node.id);
    if (!center) return;
    const info = this.topicInfo(node.topic);
    for (let i = 0; i < extra; i++) {
      this.creatures.push(this.buildCreature(node, info, {
        x: center.x + (Math.random() - 0.5) * 60,
        y: center.y + (Math.random() - 0.5) * 60,
      }, 1, 1, false, center));
    }
  }

  spawnForager() {
    const speed = 1.6 + Math.random() * 0.6;
    let x, y, vx, vy, ridgeIdx = null;
    if (Math.random() < 0.8) {
      // 80% follow a random ridge: enter from the left or right edge at the
      // ridge's y, moving horizontally along it.
      ridgeIdx = Math.floor(Math.random() * RIDGES.length);
      const fromLeft = Math.random() < 0.5;
      x = fromLeft ? -8 : this.W + 8;
      y = ridgeYAt(RIDGES[ridgeIdx], x, this.H);
      vx = fromLeft ? speed : -speed;
      vy = (Math.random() - 0.5) * 0.3;
    } else {
      // 20% wander free from any edge — keeps the canvas from feeling rigid.
      const edge = Math.floor(Math.random() * 4);
      switch (edge) {
        case 0: x = Math.random() * this.W; y = 0; vx = (Math.random() - 0.5) * speed; vy = speed * (0.5 + Math.random() * 0.5); break;
        case 1: x = this.W; y = Math.random() * this.H; vx = -speed * (0.5 + Math.random() * 0.5); vy = (Math.random() - 0.5) * speed; break;
        case 2: x = Math.random() * this.W; y = this.H; vx = (Math.random() - 0.5) * speed; vy = -speed * (0.5 + Math.random() * 0.5); break;
        case 3: x = 0; y = Math.random() * this.H; vx = speed * (0.5 + Math.random() * 0.5); vy = (Math.random() - 0.5) * speed; break;
      }
    }
    const trail = { points: [{ x, y }], alpha: 0.42 };
    this.trails.push(trail);
    this.foragers.push({ x, y, vx, vy, trail, peekTimer: 80 + Math.random() * 180, peeking: false, peekDuration: 0, ridgeIdx });
  }

  startForaging() {
    this.thinkingPhase = true;
    this.foragers = [];
    this.trails = [];
    this.foragerSpawnTimer = 0;
  }

  stopForaging() { this.thinkingPhase = false; }

  consumeForagerForSpawn() {
    if (this.foragers.length === 0) return null;
    const cx = this.W / 2, cy = this.H / 2;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.foragers.length; i++) {
      const d = Math.hypot(this.foragers[i].x - cx, this.foragers[i].y - cy);
      if (d < bestD) { bestD = d; best = i; }
    }
    const f = this.foragers[best];
    const pos = { x: f.x, y: f.y };
    this.foragers.splice(best, 1);
    return pos;
  }

  simulateForagers() {
    if (this.thinkingPhase) {
      this.foragerSpawnTimer--;
      if (this.foragerSpawnTimer <= 0 && this.foragers.length < 3) {
        this.spawnForager();
        this.foragerSpawnTimer = 50 + Math.random() * 80;
      }
    }
    for (let i = this.foragers.length - 1; i >= 0; i--) {
      const f = this.foragers[i];
      if (!f.peeking) {
        f.peekTimer--;
        if (f.peekTimer <= 0) { f.peeking = true; f.peekDuration = 30 + Math.random() * 30; }
      } else {
        f.peekDuration--;
        if (f.peekDuration <= 0) { f.peeking = false; f.peekTimer = 120 + Math.random() * 180; }
      }
      f.vx += (Math.random() - 0.5) * 0.18;
      f.vy += (Math.random() - 0.5) * 0.18;
      // Ridge-following: gentle vy nudge toward the ridge's y at this x.
      // Velocity is normalised below, so this rotates the heading toward the
      // ridge rather than overriding speed.
      if (f.ridgeIdx != null) {
        const ridgeY = ridgeYAt(RIDGES[f.ridgeIdx], f.x, this.H);
        f.vy += (ridgeY - f.y) * 0.018;
      }
      const s = Math.hypot(f.vx, f.vy);
      const target = f.peeking ? 0.08 : 1.8;
      if (s > 0) { f.vx = f.vx / s * target; f.vy = f.vy / s * target; }
      f.x += f.vx; f.y += f.vy;
      f.trail.points.push({ x: f.x, y: f.y });
      if (f.trail.points.length > 400) f.trail.points.shift();
      if (f.x < -30 || f.x > this.W + 30 || f.y < -30 || f.y > this.H + 30) {
        this.foragers.splice(i, 1);
      }
    }
    if (!this.thinkingPhase) {
      for (let i = this.trails.length - 1; i >= 0; i--) {
        this.trails[i].alpha -= 0.004;
        if (this.trails[i].alpha <= 0) this.trails.splice(i, 1);
      }
    }
  }

  drawForagers() {
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    for (const t of this.trails) {
      if (t.points.length < 2) continue;
      this.ctx.strokeStyle = `rgba(120, 200, 130, ${t.alpha})`;
      this.ctx.lineWidth = 0.7;
      this.ctx.beginPath();
      this.ctx.moveTo(t.points[0].x, t.points[0].y);
      for (let i = 1; i < t.points.length; i++) this.ctx.lineTo(t.points[i].x, t.points[i].y);
      this.ctx.stroke();
    }
    for (const f of this.foragers) {
      if (f.peeking) {
        const bob = Math.sin((60 - f.peekDuration) * 0.2) * 1.2;
        this.ctx.strokeStyle = '#4a7a4a'; this.ctx.lineWidth = 1;
        this.ctx.beginPath(); this.ctx.moveTo(f.x, f.y); this.ctx.lineTo(f.x, f.y - 5 + bob); this.ctx.stroke();
        this.ctx.fillStyle = '#3a6a3a';
        this.ctx.beginPath(); this.ctx.arc(f.x, f.y - 7.4 + bob, 2.4, 0, Math.PI * 2); this.ctx.fill();
      } else {
        this.ctx.fillStyle = 'rgba(220, 255, 220, 0.12)';
        this.ctx.beginPath(); this.ctx.arc(f.x, f.y, 3.5, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.fillStyle = 'rgba(245, 255, 240, 0.95)';
        this.ctx.beginPath(); this.ctx.arc(f.x, f.y, 1.5, 0, Math.PI * 2); this.ctx.fill();
      }
    }
  }

  generateClusterPositions(cx, cy, count, rel, spreadR) {
    const out = [];
    if (rel === 'synthesizes' && count >= 4) {
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + Math.random() * 0.25;
        const r = spreadR * (0.85 + Math.random() * 0.2);
        out.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
      }
    } else if (rel === 'refines' && count >= 4) {
      const half = Math.floor(count / 2);
      for (let i = 0; i < count; i++) {
        const leftSide = i < half;
        const subCx = leftSide ? cx - spreadR * 0.55 : cx + spreadR * 0.55;
        out.push({ x: subCx + (Math.random() - 0.5) * spreadR * 0.7, y: cy + (Math.random() - 0.5) * spreadR * 0.7 });
      }
    } else if (rel === 'contradicts') {
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const r = spreadR * (0.65 + Math.random() * 0.45);
        out.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r, vx: Math.cos(ang) * 0.35, vy: Math.sin(ang) * 0.35 });
      }
    } else if (rel === 'questions') {
      for (let i = 0; i < count; i++) {
        out.push({ x: cx + (Math.random() - 0.5) * spreadR * 2.3, y: cy + (Math.random() - 0.5) * spreadR * 2.3 });
      }
    } else {
      for (let i = 0; i < count; i++) {
        out.push({ x: cx + (Math.random() - 0.5) * spreadR * 2, y: cy + (Math.random() - 0.5) * spreadR * 2 });
      }
    }
    return out;
  }

  buildCreature(node, info, pos, sizeMult, alphaMult, isScout, cluster) {
    return {
      x: pos.x, y: pos.y,
      vx: pos.vx != null ? pos.vx : (Math.random() - 0.5) * 2,
      vy: pos.vy != null ? pos.vy : (Math.random() - 0.5) * 2,
      size: (3 + Math.random() * 3) * sizeMult,
      color: info.color, topic: node.topic, node,
      alive: node.type !== 'dead-end',
      stemH: (4 + Math.random() * 6) * sizeMult,
      bobPhase: Math.random() * Math.PI * 2,
      alphaMult, stance: node.stance || null,
      clusterCx: cluster.x, clusterCy: cluster.y,
      spotSeed: Math.floor(Math.random() * 100000),
      scout: !!isScout, scoutPhase: 'out', scoutTarget: null,
    };
  }

  drawCapDots(rel, cx, cy, size, seed) {
    if (!rel || rel === 'supports') return;
    const r = size * 0.55;
    const dotSize = Math.max(1.3, size * 0.28);
    const ink = 'rgba(30, 18, 12, 0.95)';
    const inkFaint = 'rgba(30, 18, 12, 0.72)';
    if (rel === 'contradicts') {
      this.ctx.fillStyle = ink;
      for (let i = 0; i < 4; i++) {
        const ang = this.pseudoRand(seed + i * 7) * Math.PI * 2;
        const rr = this.pseudoRand(seed + i * 13) * r;
        this.ctx.beginPath(); this.ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, dotSize, 0, Math.PI * 2); this.ctx.fill();
      }
    } else if (rel === 'synthesizes') {
      this.ctx.fillStyle = ink;
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2 - Math.PI / 2;
        this.ctx.beginPath(); this.ctx.arc(cx + Math.cos(ang) * r * 0.62, cy + Math.sin(ang) * r * 0.62, dotSize, 0, Math.PI * 2); this.ctx.fill();
      }
    } else if (rel === 'refines') {
      this.ctx.fillStyle = inkFaint;
      this.ctx.beginPath(); this.ctx.arc(cx - r * 0.42, cy, dotSize * 0.95, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.beginPath(); this.ctx.arc(cx + r * 0.42, cy, dotSize * 0.95, 0, Math.PI * 2); this.ctx.fill();
    } else if (rel === 'questions') {
      this.ctx.fillStyle = ink;
      this.ctx.beginPath(); this.ctx.arc(cx + r * 0.38, cy - r * 0.22, dotSize * 1.15, 0, Math.PI * 2); this.ctx.fill();
    } else if (rel === 'supersedes') {
      this.ctx.fillStyle = inkFaint;
      for (let i = 0; i < 6; i++) {
        const ang = this.pseudoRand(seed + i * 11) * Math.PI * 2;
        const rr = this.pseudoRand(seed + i * 17) * r * 0.9;
        this.ctx.beginPath(); this.ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, dotSize * 0.72, 0, Math.PI * 2); this.ctx.fill();
      }
    }
  }

  spawnCreatures(node, spawnPos) {
    const info = this.topicInfo(node.topic);
    const cx = spawnPos ? spawnPos.x : this.W * (0.15 + Math.random() * 0.7);
    const cy = spawnPos ? spawnPos.y : this.H * (0.15 + Math.random() * 0.7);
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const stance = node.stance;
    const rel = node.rel;
    let sizeMult = 1, alphaMult = 1, spreadMult = 1, countMult = 1;
    if (stance === 'exploring')        { sizeMult = 0.88; spreadMult = 1.35; }
    else if (stance === 'questioning') { sizeMult = 0.9;  spreadMult = 1.25; }
    else if (stance === 'conceding')   { sizeMult = 0.88; alphaMult = 0.6; countMult = 0.65; }
    if (rel === 'supersedes') alphaMult *= 0.55;
    const heatCountMult = 1 + heat * 0.5;
    const heatSpreadMult = 1 - heat * 0.3;
    const inbound = this.nodeIncoming(node.id);
    const pivotBonus = inbound >= 3 ? Math.min(inbound - 2, 6) * 2 : 0;
    const base = 3 + Math.floor(node.confidence * 8);
    const count = Math.max(2, Math.round(base * heatCountMult * countMult) + pivotBonus);
    const spreadR = 30 * spreadMult * heatSpreadMult;
    const positions = this.generateClusterPositions(cx, cy, count, rel, spreadR);
    const cluster = { x: cx, y: cy };
    const isExternal = this.hasExternalBecause(node);
    for (let i = 0; i < count; i++) {
      const isScout = isExternal && i === 0;
      this.creatures.push(this.buildCreature(node, info, positions[i], sizeMult, alphaMult, isScout, cluster));
    }
    this.applyPivotGrowth();
  }

  computeTilts() {
    const nodeMap = new Map();
    for (const c of this.creatures) {
      if (!c.node) continue;
      const e = nodeMap.get(c.node.id);
      if (e) { e.sx += c.x; e.sy += c.y; e.n++; }
      else nodeMap.set(c.node.id, { node: c.node, sx: c.x, sy: c.y, n: 1 });
    }
    for (const e of nodeMap.values()) { e.cx = e.sx / e.n; e.cy = e.sy / e.n; }
    const tilts = new Map();
    const maxTilt = 0.24;
    for (const [id, e] of nodeMap) {
      const refs = e.node.refs;
      if (!Array.isArray(refs) || !refs.length) continue;
      let bestD = Infinity, tx = 0, ty = 0;
      for (const tid of refs) {
        const t = nodeMap.get(tid);
        if (!t) continue;
        const d = Math.hypot(t.cx - e.cx, t.cy - e.cy);
        if (d < bestD) { bestD = d; tx = t.cx; ty = t.cy; }
      }
      if (bestD === Infinity) continue;
      const dx = tx - e.cx, dy = ty - e.cy;
      const d = Math.hypot(dx, dy);
      if (d < 1) continue;
      tilts.set(id, (dx / d) * maxTilt);
    }
    return tilts;
  }

  simulate() {
    const tilts = this.computeTilts();
    this.creatures.forEach(c => {
      if (c.node) c.tiltAngle = tilts.get(c.node.id) || 0;
      if (!c.alive) { c.vy += 0.02; c.size *= 0.999; return; }
      if (c.scout) {
        if (!c.scoutTarget) {
          const edge = Math.floor(Math.random() * 4);
          const m = 55;
          if (edge === 0)      c.scoutTarget = { x: Math.random() * this.W, y: m };
          else if (edge === 1) c.scoutTarget = { x: this.W - m, y: Math.random() * this.H };
          else if (edge === 2) c.scoutTarget = { x: Math.random() * this.W, y: this.H - m };
          else                 c.scoutTarget = { x: m, y: Math.random() * this.H };
          c.scoutPhase = 'out';
        }
        const tx = c.scoutPhase === 'out' ? c.scoutTarget.x : c.clusterCx;
        const ty = c.scoutPhase === 'out' ? c.scoutTarget.y : c.clusterCy;
        const dx = tx - c.x, dy = ty - c.y;
        const d = Math.hypot(dx, dy);
        if (d < 30) {
          if (c.scoutPhase === 'out') { this.playScoutPing(c, 'edge'); c.scoutPhase = 'return'; }
          else { this.playScoutPing(c, 'home'); c.scoutPhase = 'out'; c.scoutTarget = null; }
        } else {
          c.vx += (dx / d) * 0.02; c.vy += (dy / d) * 0.02;
        }
        c.vx *= 0.95; c.vy *= 0.95;
        const spd = Math.hypot(c.vx, c.vy);
        if (spd > 0.7) { c.vx = c.vx / spd * 0.7; c.vy = c.vy / spd * 0.7; }
        c.x += c.vx; c.y += c.vy;
        if (c.x < 10) { c.x = 10; if (c.vx < 0) c.vx = 0; }
        else if (c.x > this.W - 10) { c.x = this.W - 10; if (c.vx > 0) c.vx = 0; }
        if (c.y < 10) { c.y = 10; if (c.vy < 0) c.vy = 0; }
        else if (c.y > this.H - 10) { c.y = this.H - 10; if (c.vy > 0) c.vy = 0; }
        c.bobPhase += 0.06;
        return;
      }
      let fx = 0, fy = 0;
      const cohesionMult = c.node && c.node.rel === 'supports' ? 1.5 : 1;
      this.creatures.forEach(o => {
        if (o === c || o.topic !== c.topic || !o.alive) return;
        const d = Math.hypot(o.x - c.x, o.y - c.y);
        if (d < 120 && d > 1) {
          fx += (o.x - c.x) / d * 0.04 * cohesionMult;
          fy += (o.y - c.y) / d * 0.04 * cohesionMult;
          if (d < 20) { fx -= (o.x - c.x) / d * 0.1; fy -= (o.y - c.y) / d * 0.1; }
        }
      });
      let oscX = 0, oscY = 0;
      if (c.stance === 'questioning') {
        oscX = Math.sin(c.bobPhase * 0.45) * 0.06;
        oscY = Math.cos(c.bobPhase * 0.45) * 0.06;
      }
      c.vx += fx + oscX + (Math.random() - 0.5) * 0.15;
      c.vy += fy + oscY + (Math.random() - 0.5) * 0.15;
      c.vx *= 0.96; c.vy *= 0.96;
      const spd = Math.hypot(c.vx, c.vy);
      if (spd > 2.4) { c.vx = c.vx / spd * 2.4; c.vy = c.vy / spd * 2.4; }
      c.x += c.vx; c.y += c.vy;
      if (c.x < 10) { c.x = 10; if (c.vx < 0) c.vx = 0; }
      else if (c.x > this.W - 10) { c.x = this.W - 10; if (c.vx > 0) c.vx = 0; }
      if (c.y < 10) { c.y = 10; if (c.vy < 0) c.vy = 0; }
      else if (c.y > this.H - 10) { c.y = this.H - 10; if (c.vy > 0) c.vy = 0; }
      c.bobPhase += 0.08;
    });
  }

  drawPivotGroundPatches() {
    const seen = new Set();
    for (const c of this.creatures) {
      if (!c.node || seen.has(c.node.id)) continue;
      seen.add(c.node.id);
      const inbound = this.nodeIncoming(c.node.id);
      if (inbound < 3) continue;
      const center = this.centroidOf(c.node.id);
      if (!center) continue;
      const radius = 32 + Math.min(inbound - 2, 5) * 11;
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      this.ctx.beginPath();
      this.ctx.ellipse(center.x, center.y + 4, radius, radius * 0.38, 0, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.035)';
      this.ctx.beginPath();
      this.ctx.ellipse(center.x, center.y + 3, radius * 0.55, radius * 0.2, 0, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  onStart() {
    this.initAural();
    this.startForaging();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one extra forager per prompt token, each starting from
  // an interior position (not just edges). Pre-seeds the exploratory network
  // so density during the wait reflects prompt complexity.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;

    for (const tok of tokens) {
      // hash token to a stable position so the same prompt seeds the same
      // pattern of foragers (subtle determinism — a session "looks" like its prompt)
      const h = this.hashToken(tok);
      const px = h % 1000 / 1000;
      const py = (h >> 10) % 1000 / 1000;

      const x = this.W  * (0.15 + px * 0.7);
      const y = this.H * (0.15 + py * 0.7);
      const ang = Math.random() * Math.PI * 2;
      const speed = 1.6 + Math.random() * 0.6;
      const vx = Math.cos(ang) * speed;
      const vy = Math.sin(ang) * speed;
      const trail = { points: [{ x, y }], alpha: 0.42 };
      this.trails.push(trail);
      this.foragers.push({ x, y, vx, vy, trail, peekTimer: 80 + Math.random() * 180, peeking: false, peekDuration: 0 });
    }
  }

  onNode(n) {
    let spawnPos = null;
    if (this.thinkingPhase) {
      spawnPos = this.consumeForagerForSpawn();
      this.stopForaging();
    }
    this.spawnCreatures(n, spawnPos);
    this.playAntminCascade(n);
  }

  onDone() { this.stopForaging(); }
  onError() { this.stopForaging(); }
  onStop() { this.stopForaging(); }

  onClear() {
    this.creatures = [];
    this.foragers = [];
    this.trails = [];
    this.thinkingPhase = false;
  }

  // Topographic ridges — five faint horizontal contours, each built from four
  // octaves of sine (low-freq backbone + progressively higher-freq detail) so the
  // curves feel weathered and natural instead of mathematical. Y positions are
  // non-uniform to avoid a banded look. Static — rendered once.
  drawTopoRidges() {
    if (!this._ridgeOff || this._ridgeW !== this.W || this._ridgeH !== this.H) {
      if (!this._ridgeOff) this._ridgeOff = document.createElement('canvas');
      this._ridgeOff.width = Math.max(1, Math.ceil(this.W));
      this._ridgeOff.height = Math.max(1, Math.ceil(this.H));
      this._ridgeW = this.W; this._ridgeH = this.H;
      const oc = this._ridgeOff.getContext('2d');
      oc.clearRect(0, 0, this.W, this.H);
      oc.lineWidth = 1.2;
      oc.lineCap = 'round';
      for (const r of RIDGES) {
        oc.strokeStyle = `rgba(60, 92, 60, ${r.alpha})`;
        oc.beginPath();
        for (let x = 0; x <= this.W; x += 2) {
          const y = ridgeYAt(r, x, this.H);
          if (x === 0) oc.moveTo(x, y); else oc.lineTo(x, y);
        }
        oc.stroke();
      }
    }
    this.ctx.drawImage(this._ridgeOff, 0, 0);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulate();
    this.simulateForagers();
    const ht = this.app.highlightedTopic;
    this.ctx.fillStyle = '#1a2e1a';
    this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawTopoRidges();
    this.drawForagers();
    this.drawPivotGroundPatches();
    this.creatures.forEach(c => {
      this.ctx.fillStyle = 'rgba(0,0,0,0.15)';
      this.ctx.beginPath();
      this.ctx.ellipse(c.x, c.y + 2, c.size * 0.8, c.size * 0.3, 0, 0, Math.PI * 2);
      this.ctx.fill();
    });
    this.creatures.forEach(c => {
      const bob = c.alive ? Math.sin(c.bobPhase) * 2 : 0;
      const am = c.alphaMult || 1;
      const tilt = c.tiltAngle || 0;
      const dim = ht && c.node && c.node.topic !== ht ? 0.25 : 1;
      this.ctx.save();
      this.ctx.translate(c.x, c.y);
      this.ctx.rotate(tilt);
      this.ctx.strokeStyle = c.alive ? '#4a7a4a' : '#3a3a2a';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.moveTo(0, 0); this.ctx.lineTo(0, -c.stemH + bob); this.ctx.stroke();
      this.ctx.fillStyle = c.alive ? c.color : '#3a3a2a';
      this.ctx.globalAlpha = (c.alive ? 0.9 * am : 0.3 * am) * dim;
      this.ctx.beginPath(); this.ctx.arc(0, -c.stemH - c.size + bob, c.size, 0, Math.PI * 2); this.ctx.fill();
      if (c.alive) this.drawCapDots(c.node && c.node.rel, 0, -c.stemH - c.size + bob, c.size, c.spotSeed);
      if (c.alive && c.size > 3) {
        this.ctx.fillStyle = '#fff';
        this.ctx.beginPath();
        this.ctx.arc(-1.5, -c.stemH - c.size - 0.5 + bob, 1, 0, Math.PI * 2);
        this.ctx.arc( 1.5, -c.stemH - c.size - 0.5 + bob, 1, 0, Math.PI * 2);
        this.ctx.fill();
      }
      this.ctx.globalAlpha = 1;
      this.ctx.restore();
    });
  }
}

export { AntminMode };

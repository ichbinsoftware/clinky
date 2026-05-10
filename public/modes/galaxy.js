import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, pickSessionKey, quantizeToKey, configureReverb } from '/synth.js';

const REL_INTERVAL = { supports: 7, contradicts: 6, synthesizes: 4, refines: 1, questions: 6, supersedes: 12 };
const ARMS = 4;

class GalaxyMode extends Mode {
  stars = [];
  stellarT = 0;
  BG_STARS = [];
  driftPhase = false;
  driftCollapsing = false;
  drifters = [];
  driftSpawnTimer = 0;
  coreFlash = 0;
  shootingStars = [];
  mouseX = null;
  mouseY = null;
  mouseIsDown = false;

  constructor() {
    super({
      mode: 'galaxy',
      aesthetic: 'ambient',
      topicFallbackColor: '#fffacd',
      vars: {
        '--e-bg': '#050510', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#ebb0d8', '--e-pivot-tint': 'rgba(235,176,216,0.06)', '--e-accent': '#c2008b',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left; this.mouseY = e.clientY - r.top;
      let closest = null, cd = 18;
      for (const s of this.stars) {
        if (s._x == null) continue;
        const d = Math.hypot(s._x - this.mouseX, s._y - this.mouseY);
        if (d < cd) { cd = d; closest = s; }
      }
      if (closest) { showTooltip(e, closest.node, closest.color); this.app.highlightLegendTopic(closest.node.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('mouseleave', () => { this.mouseX = null; this.mouseY = null; this.mouseIsDown = false; });
    this.canvas.addEventListener('mousedown', () => { this.mouseIsDown = true; });
    this.canvas.addEventListener('mouseup', () => { this.mouseIsDown = false; });
    this.canvas.addEventListener('dblclick', e => {
      if (this.driftPhase) return;
      const r = this.canvas.getBoundingClientRect();
      this.spawnShootingStar(e.clientX - r.left, e.clientY - r.top);
    });
  }

  count() { return this.stars.length; }
  legendItems() { return this.stars; }

  starIncoming(s) {
    const id = s.node && s.node.id;
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.stars.map(x => x.node).filter(Boolean));
  }

  hasExternalBecause(s) {
    const b = s.node && s.node.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  sessionHasRefs() {
    for (const s of this.stars) { const r = s.node && s.node.refs; if (Array.isArray(r) && r.length > 0) return true; }
    return false;
  }

  starById(id) { for (const s of this.stars) if (s.node && s.node.id === id) return s; return null; }

  pseudoRand(seed) { const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = innerWidth;
    this.H = innerHeight;
    this.canvas.width  = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width  = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.BG_STARS.length = 0;
    for (let i = 0; i < 300; i++) this.BG_STARS.push({ x: Math.random() * this.W, y: Math.random() * this.H, r: Math.random() * 1.2, alpha: 0.2 + Math.random() * 0.5 });
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'galaxy');
      configureReverb({ duration: 6.0, decay: 3.5, wet: 0.75 });
    });
  }

  topicMidi(topicId) {
    const info = this.topicInfo(topicId);
    const rawFreq = info.note || 440;
    const rawMidi = Math.round(69 + 12 * Math.log2(rawFreq / 440));
    return quantizeToKey(rawMidi);
  }

  galaxyBell(midi, dur, vol) { playSynth({ midi, ...PRESETS.bell, duration: dur, vol, reverbSend: 0.55 }); }

  playBridgeIntervals(node) {
    if (!node || !Array.isArray(node.refs) || node.refs.length === 0) return;
    const interval = REL_INTERVAL[node.rel] ?? REL_INTERVAL.supports;
    const src = this.topicMidi(node.topic) + 12;
    node.refs.forEach((_, i) => {
      const base = i * 700;
      setTimeout(() => this.galaxyBell(src, 1.5, 0.10), base);
      setTimeout(() => this.galaxyBell(src + interval, 1.5, 0.09), base + 300);
    });
  }

  spawnDrifter(fromEdge) {
    let x, y;
    if (fromEdge) {
      const edge = Math.floor(Math.random() * 4);
      switch (edge) {
        case 0: x = Math.random() * this.W; y = -10; break;
        case 1: x = this.W + 10; y = Math.random() * this.H; break;
        case 2: x = Math.random() * this.W; y = this.H + 10; break;
        case 3: x = -10; y = Math.random() * this.H; break;
      }
    } else { x = this.W * (0.15 + Math.random() * 0.7); y = this.H * (0.15 + Math.random() * 0.7); }
    const dir = Math.random() * Math.PI * 2, speed = 0.25 + Math.random() * 0.35;
    this.drifters.push({ x, y, vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed, brightness: 0.5 + Math.random() * 0.5, twinkle: Math.random() * Math.PI * 2, trail: [], alpha: 0, targetAlpha: 0.9, life: 600 + Math.random() * 600, partner: null, orbitTimer: 0 });
  }

  startDrift() {
    this.driftPhase = true; this.driftCollapsing = false; this.coreFlash = 0; this.drifters = [];
    for (let i = 0; i < 7; i++) this.spawnDrifter(false);
    this.driftSpawnTimer = 180;
  }

  stopDrift() {
    this.driftPhase = false; this.driftCollapsing = true; this.coreFlash = 1;
    const cx = this.W / 2, cy = this.H / 2;
    for (const d of this.drifters) {
      const dx = cx - d.x, dy = cy - d.y, dist = Math.hypot(dx, dy);
      if (dist > 0.1) { d.vx = (dx / dist) * 3; d.vy = (dy / dist) * 3; }
    }
  }

  consumeDrifterForSpawn() {
    if (this.drifters.length === 0) return null;
    const cx = this.W / 2, cy = this.H / 2;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.drifters.length; i++) { const dd = Math.hypot(this.drifters[i].x - cx, this.drifters[i].y - cy); if (dd < bestD) { bestD = dd; best = i; } }
    const d = this.drifters[best];
    const dx = d.x - cx, dy = d.y - cy, r = Math.max(60, Math.hypot(dx, dy)), a = Math.atan2(dy, dx) - this.stellarT;
    this.drifters.splice(best, 1);
    return { r, a };
  }

  simulateDrift() {
    const cx = this.W / 2, cy = this.H / 2;
    if (this.driftPhase) {
      this.driftSpawnTimer--;
      if (this.driftSpawnTimer <= 0 && this.drifters.length < 10) { this.spawnDrifter(true); this.driftSpawnTimer = 200 + Math.random() * 300; }
      for (let i = 0; i < this.drifters.length; i++) {
        if (this.drifters[i].partner) continue;
        for (let j = i + 1; j < this.drifters.length; j++) {
          if (this.drifters[j].partner) continue;
          if (Math.hypot(this.drifters[j].x - this.drifters[i].x, this.drifters[j].y - this.drifters[i].y) < 80 && Math.random() < 0.01) {
            this.drifters[i].partner = this.drifters[j]; this.drifters[j].partner = this.drifters[i];
            this.drifters[i].orbitTimer = this.drifters[j].orbitTimer = 100 + Math.random() * 80; break;
          }
        }
      }
    }
    for (let i = this.drifters.length - 1; i >= 0; i--) {
      const d = this.drifters[i];
      d.alpha += (d.targetAlpha - d.alpha) * 0.05;
      if (d.partner && d.orbitTimer > 0 && !this.driftCollapsing) {
        const dx = d.partner.x - d.x, dy = d.partner.y - d.y, dist = Math.hypot(dx, dy);
        if (dist > 0.1) { d.vx += (dx / dist) * 0.02; d.vy += (dy / dist) * 0.02; }
        d.vx *= 0.99; d.vy *= 0.99;
        d.orbitTimer--;
        if (d.orbitTimer <= 0) { d.partner.partner = null; d.partner = null; }
      }
      if (!this.driftCollapsing && !d.partner) {
        d.vx += (Math.random() - 0.5) * 0.01; d.vy += (Math.random() - 0.5) * 0.01;
        const s = Math.hypot(d.vx, d.vy); if (s > 0.6) { d.vx = d.vx / s * 0.6; d.vy = d.vy / s * 0.6; }
      }
      if (this.driftPhase && this.mouseIsDown && this.mouseX != null && !this.driftCollapsing) {
        const gx = this.mouseX - d.x, gy = this.mouseY - d.y, gDist = Math.hypot(gx, gy);
        if (gDist < 250 && gDist > 0.1) { const pull = 0.08 * (1 - gDist / 250); d.vx += (gx / gDist) * pull; d.vy += (gy / gDist) * pull; }
      }
      d.x += d.vx; d.y += d.vy;
      d.trail.push({ x: d.x, y: d.y, age: 0 });
      if (d.trail.length > 60) d.trail.shift();
      for (const t of d.trail) t.age++;
      if (this.driftPhase && !d.partner) { d.life--; if (d.life <= 0) d.targetAlpha = 0; }
      const distToCenter = Math.hypot(d.x - cx, d.y - cy);
      if (this.driftCollapsing && distToCenter < 8) { this.drifters.splice(i, 1); continue; }
      if (d.x < -30 || d.x > this.W + 30 || d.y < -30 || d.y > this.H + 30) { this.drifters.splice(i, 1); continue; }
      if (d.alpha < 0.01 && d.targetAlpha === 0) { if (d.partner) d.partner.partner = null; this.drifters.splice(i, 1); }
    }
    if (this.driftCollapsing && this.drifters.length === 0) this.driftCollapsing = false;
    if (this.coreFlash > 0) { this.coreFlash *= 0.93; if (this.coreFlash < 0.01) this.coreFlash = 0; }
  }

  drawDrift() {
    if (this.drifters.length === 0 && this.coreFlash < 0.02) return;
    for (const d of this.drifters) {
      if (d.trail.length < 2) continue;
      this.ctx.lineCap = 'round';
      for (let i = 1; i < d.trail.length; i++) {
        const t = d.trail[i]; const fade = (1 - t.age / 60) * d.alpha * 0.4;
        if (fade <= 0) continue;
        this.ctx.strokeStyle = `rgba(255, 240, 210, ${fade})`; this.ctx.lineWidth = 0.8;
        this.ctx.beginPath(); this.ctx.moveTo(d.trail[i - 1].x, d.trail[i - 1].y); this.ctx.lineTo(d.trail[i].x, d.trail[i].y); this.ctx.stroke();
      }
    }
    for (const d of this.drifters) {
      const tw = 0.75 + Math.sin(this.stellarT * 60 + d.twinkle) * 0.25;
      const size = 2 * d.brightness * tw;
      this.ctx.fillStyle = `rgba(255, 250, 220, ${d.alpha * 0.18})`; this.ctx.beginPath(); this.ctx.arc(d.x, d.y, size * 3.5, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = `rgba(255, 250, 220, ${d.alpha})`; this.ctx.beginPath(); this.ctx.arc(d.x, d.y, size, 0, Math.PI * 2); this.ctx.fill();
    }
    if (this.coreFlash > 0) {
      const cx = this.W / 2, cy = this.H / 2;
      const flashR = Math.max(this.W, this.H);
      const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, flashR);
      grad.addColorStop(0, `rgba(255, 250, 230, ${this.coreFlash * 0.7})`); grad.addColorStop(0.3, `rgba(255, 230, 200, ${this.coreFlash * 0.25})`); grad.addColorStop(1, 'rgba(0, 0, 30, 0)');
      this.ctx.fillStyle = grad; this.ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  spawnShootingStar(x, y) {
    const angle = Math.random() * Math.PI * 2, speed = 16 + Math.random() * 6;
    this.shootingStars.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, trail: [], life: 90 + Math.random() * 30 });
  }

  simulateShootingStars() {
    for (let i = this.shootingStars.length - 1; i >= 0; i--) {
      const s = this.shootingStars[i]; s.x += s.vx; s.y += s.vy;
      s.trail.push({ x: s.x, y: s.y, age: 0 }); for (const p of s.trail) p.age++;
      if (s.trail.length > 40) s.trail.shift(); s.life--;
      if (s.life <= 0 || s.x < -100 || s.x > this.W + 100 || s.y < -100 || s.y > this.H + 100) this.shootingStars.splice(i, 1);
    }
  }

  drawShootingStars() {
    for (const s of this.shootingStars) {
      this.ctx.lineCap = 'round';
      for (let i = 1; i < s.trail.length; i++) {
        const t = s.trail[i]; const lifeFrac = Math.max(0, s.life / 90); const fade = (1 - t.age / 40) * lifeFrac;
        if (fade <= 0) continue;
        this.ctx.strokeStyle = `rgba(255, 250, 220, ${fade})`; this.ctx.lineWidth = 1.5 * fade + 0.3;
        this.ctx.beginPath(); this.ctx.moveTo(s.trail[i - 1].x, s.trail[i - 1].y); this.ctx.lineTo(s.trail[i].x, s.trail[i].y); this.ctx.stroke();
      }
      const lifeFrac = Math.max(0, s.life / 90);
      this.ctx.fillStyle = `rgba(255, 250, 220, ${lifeFrac})`; this.ctx.beginPath(); this.ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = `rgba(255, 240, 200, ${lifeFrac * 0.3})`; this.ctx.beginPath(); this.ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  addStar(node, spawnPolar) {
    const info = this.topicInfo(node.topic);
    const topicIdx = this.topics.findIndex(t => t.id === node.topic);
    let radius, angle;
    if (spawnPolar) { radius = spawnPolar.r; angle = spawnPolar.a; }
    else {
      const arm = topicIdx % ARMS;
      radius = 60 + Math.random() * (Math.min(this.W, this.H) * 0.35);
      const armAngle = (arm / ARMS) * Math.PI * 2;
      const spiralK = 0.006;
      angle = armAngle + radius * spiralK + (Math.random() - 0.5) * 0.3;
    }
    this.stars.push({ r: radius, a: angle, size: 1 + node.confidence * 3.5, color: info.color, node, born: performance.now(), twinkle: Math.random() * Math.PI * 2 });
  }

  drawBridges() {
    if (!this.sessionHasRefs() || this.stars.length < 2) return;
    for (const s of this.stars) {
      const node = s.node;
      if (!node || !Array.isArray(node.refs) || !node.refs.length || node.rel !== 'synthesizes' || s._x == null) continue;
      const tgts = node.refs.map(id => this.starById(id)).filter(t => t && t._x != null);
      if (tgts.length >= 2) this.drawNebula(s, tgts);
    }
    for (const s of this.stars) {
      const node = s.node;
      if (!node || !Array.isArray(node.refs) || !node.refs.length || node.rel === 'synthesizes' || s._x == null) continue;
      for (const tid of node.refs) { const t = this.starById(tid); if (!t || t._x == null) continue; this.drawBridge(s, t, node.rel); }
    }
  }

  drawNebula(src, tgts) {
    const pts = [src, ...tgts];
    let sumX = 0, sumY = 0; for (const p of pts) { sumX += p._x; sumY += p._y; }
    const cx = sumX / pts.length, cy = sumY / pts.length;
    let maxR = 0; for (const p of pts) { const d = Math.hypot(p._x - cx, p._y - cy); if (d > maxR) maxR = d; }
    const r = maxR * 1.35 + 28;
    const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(210, 170, 230, 0.22)'); grad.addColorStop(0.4, 'rgba(170, 190, 235, 0.12)'); grad.addColorStop(1, 'rgba(40, 40, 80, 0)');
    this.ctx.fillStyle = grad; this.ctx.beginPath(); this.ctx.arc(cx, cy, r, 0, Math.PI * 2); this.ctx.fill();
  }

  drawBridge(src, tgt, rel) {
    const x1 = src._x, y1 = src._y, x2 = tgt._x, y2 = tgt._y;
    const dx = x2 - x1, dy = y2 - y1, dist = Math.hypot(dx, dy);
    if (dist < 24) return;
    const maxReach = Math.min(this.W, this.H) * 0.55;
    const distFade = dist > maxReach ? Math.max(0.35, 1 - (dist - maxReach) / maxReach) : 1;
    const seed = ((src.node && src.node.id) || 0) * 1000 + ((tgt.node && tgt.node.id) || 0);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const nx = -dy / dist, ny = dx / dist;
    const bow = (this.pseudoRand(seed) - 0.5) * dist * 0.12;
    const cx = mx + nx * bow, cy = my + ny * bow;
    this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    if (rel === 'contradicts') {
      const steps = Math.max(6, Math.floor(dist / 22));
      this.ctx.strokeStyle = `rgba(255, 180, 170, ${0.26 * distFade})`; this.ctx.lineWidth = 0.9;
      this.ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps; const bx = x1 + dx * t, by = y1 + dy * t;
        const offset = ((this.pseudoRand(seed + i) - 0.5) * 6 + Math.sin(this.stellarT * 40 + i) * 2);
        const px = bx + nx * offset, py = by + ny * offset;
        if (i === 0) this.ctx.moveTo(px, py); else this.ctx.lineTo(px, py);
      }
      this.ctx.stroke();
    } else if (rel === 'refines') {
      this.ctx.strokeStyle = `rgba(200, 215, 240, ${0.16 * distFade})`; this.ctx.lineWidth = 0.7;
      const cx2 = mx + nx * (bow + dist * 0.08), cy2 = my + ny * (bow + dist * 0.08);
      this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.quadraticCurveTo(cx2, cy2, x2, y2); this.ctx.stroke();
    } else if (rel === 'questions') {
      const steps = Math.max(10, Math.floor(dist / 16));
      this.ctx.strokeStyle = `rgba(220, 200, 240, ${0.24 * distFade})`; this.ctx.lineWidth = 0.85;
      this.ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps; const bx = x1 + dx * t, by = y1 + dy * t;
        const envelope = Math.sin(t * Math.PI); const wob = Math.sin(t * Math.PI * 4 + this.stellarT * 30) * 5 * envelope;
        const px = bx + nx * wob, py = by + ny * wob;
        if (i === 0) this.ctx.moveTo(px, py); else this.ctx.lineTo(px, py);
      }
      this.ctx.stroke();
    } else if (rel === 'supersedes') {
      this.ctx.strokeStyle = `rgba(200, 150, 140, ${0.09 * distFade})`; this.ctx.lineWidth = 6;
      this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.quadraticCurveTo(cx, cy, x2, y2); this.ctx.stroke();
    } else {
      this.ctx.strokeStyle = `rgba(230, 225, 200, ${0.2 * distFade})`; this.ctx.lineWidth = 0.9;
      this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.quadraticCurveTo(cx, cy, x2, y2); this.ctx.stroke();
    }
  }

  drawStellarNurseries() {
    for (const s of this.stars) {
      const inbound = this.starIncoming(s); if (inbound < 3 || s._x == null) continue;
      const n = Math.min(8, 2 + inbound), seed = ((s.node && s.node.id) || 0) * 31;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + this.pseudoRand(seed + i) * 0.4;
        const r = 14 + this.pseudoRand(seed + i * 3) * 14;
        const x = s._x + Math.cos(ang) * r, y = s._y + Math.sin(ang) * r;
        const sz = 0.7 + this.pseudoRand(seed + i * 5) * 0.8;
        this.ctx.fillStyle = 'rgba(255, 245, 220, 0.85)'; this.ctx.beginPath(); this.ctx.arc(x, y, sz, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.fillStyle = 'rgba(255, 230, 190, 0.3)'; this.ctx.beginPath(); this.ctx.arc(x, y, sz * 2.5, 0, Math.PI * 2); this.ctx.fill();
      }
    }
  }

  drawQuasars() {
    const marginX = 22, marginTop = 90, marginBottom = 70, W = this.W, H = this.H;
    for (const s of this.stars) {
      if (!this.hasExternalBecause(s) || s._x == null) continue;
      const x0 = s._x, y0 = s._y;
      const dL = x0, dR = W - x0, dT = Math.max(0, y0 - marginTop), dB = Math.max(0, (H - marginBottom) - y0);
      const minD = Math.min(dL, dR, dT, dB), seed = (s.node && s.node.id) || 0;
      const depth = 30 + this.pseudoRand(seed * 7) * 80, aJitter = (this.pseudoRand(seed) - 0.5);
      let qx, qy;
      if (minD === dL) { qx = marginX + depth; qy = y0 + aJitter * H * 0.18; }
      else if (minD === dR) { qx = W - marginX - depth; qy = y0 + aJitter * H * 0.18; }
      else if (minD === dT) { qx = x0 + aJitter * W * 0.18; qy = marginTop + depth; }
      else { qx = x0 + aJitter * W * 0.18; qy = H - marginBottom - depth; }
      qx = Math.max(marginX + 14, Math.min(W - marginX - 14, qx));
      qy = Math.max(marginTop + 14, Math.min(H - marginBottom - 14, qy));
      this.ctx.strokeStyle = 'rgba(180, 210, 255, 0.09)'; this.ctx.lineWidth = 0.45;
      this.ctx.beginPath(); this.ctx.moveTo(x0, y0); this.ctx.lineTo(qx, qy); this.ctx.stroke();
      this.ctx.fillStyle = 'rgba(180, 220, 255, 0.08)'; this.ctx.beginPath(); this.ctx.arc(qx, qy, 11, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = 'rgba(200, 230, 255, 0.32)'; this.ctx.beginPath(); this.ctx.arc(qx, qy, 4.8, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = 'rgba(230, 245, 255, 0.85)'; this.ctx.beginPath(); this.ctx.arc(qx, qy, 1.7, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  onStart() {
    this.initAural();
    this.startDrift();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one faint drifter per token entering from a hashed edge,
  // drifting toward the centre to join the forming nebula.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const edge = h % 4;
      let x, y;
      switch (edge) {
        case 0: x = ((h >> 4) % this.W); y = -10; break;
        case 1: x = this.W + 10; y = ((h >> 4) % this.H); break;
        case 2: x = ((h >> 4) % this.W); y = this.H + 10; break;
        default: x = -10; y = ((h >> 4) % this.H); break;
      }
      const cx = this.W / 2, cy = this.H / 2;
      const dx = cx - x, dy = cy - y, dist = Math.hypot(dx, dy) || 1;
      const speed = 0.3 + ((h >> 12) % 30) / 100;
      const vx = (dx / dist) * speed, vy = (dy / dist) * speed;
      this.drifters.push({
        x, y, vx, vy,
        brightness: 0.4 + ((h >> 8) % 40) / 100,
        twinkle: ((h >> 16) % 628) / 100,
        trail: [], alpha: 0, targetAlpha: 0.7,
        life: 900,
        partner: null, orbitTimer: 0,
      });
    }
  }

  onNode(n) {
    let spawnPolar = null;
    if (this.driftPhase) { spawnPolar = this.consumeDrifterForSpawn(); this.stopDrift(); }
    this.addStar(n, spawnPolar);
    this.playBridgeIntervals(n);
  }

  onDone() { this.stopDrift(); }
  onError() { this.stopDrift(); }
  onStop() { this.stopDrift(); }

  onClear() {
    this.stars = [];
    this.drifters = [];
    this.shootingStars = [];
    this.coreFlash = 0;
    this.driftPhase = false;
    this.driftCollapsing = false;
  }

  // Off-axis lens flare — a single faint warm point in the upper-right corner,
  // suggesting telescope optics catching a stray light source out of frame.
  drawLensFlare() {
    const fx = this.W * 0.88, fy = this.H * 0.12;
    const r = Math.max(this.W, this.H) * 0.28;
    const grad = this.ctx.createRadialGradient(fx, fy, 0, fx, fy, r);
    grad.addColorStop(0, 'rgba(255, 220, 170, 0.16)');
    grad.addColorStop(0.25, 'rgba(255, 200, 150, 0.06)');
    grad.addColorStop(1, 'rgba(255, 180, 130, 0)');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.stellarT += 0.0008;
    this.simulateDrift();
    this.simulateShootingStars();
    const cx = this.W / 2, cy = this.H / 2;
    this.ctx.fillStyle = '#050510'; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawLensFlare();
    if (this.stars.length > 0) {
      const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, 200);
      grad.addColorStop(0, 'rgba(255, 230, 180, 0.5)'); grad.addColorStop(0.4, 'rgba(200, 160, 220, 0.1)'); grad.addColorStop(1, 'rgba(0, 0, 30, 0)');
      this.ctx.fillStyle = grad; this.ctx.fillRect(0, 0, this.W, this.H);
    }
    for (const s of this.BG_STARS) { this.ctx.fillStyle = `rgba(255, 255, 255, ${s.alpha})`; this.ctx.fillRect(s.x, s.y, s.r, s.r); }
    this.drawDrift();
    for (const s of this.stars) {
      const ang = s.a + this.stellarT;
      let x = cx + Math.cos(ang) * s.r, y = cy + Math.sin(ang) * s.r;
      if (this.mouseX != null) {
        const gx = this.mouseX - x, gy = this.mouseY - y, gDist = Math.hypot(gx, gy);
        if (gDist < 150 && gDist > 0.1) { const pull = (1 - gDist / 150) * 8; s.ox = (s.ox || 0) + ((gx / gDist) * pull - (s.ox || 0)) * 0.1; s.oy = (s.oy || 0) + ((gy / gDist) * pull - (s.oy || 0)) * 0.1; }
        else { s.ox = (s.ox || 0) * 0.9; s.oy = (s.oy || 0) * 0.9; }
      } else { s.ox = (s.ox || 0) * 0.9; s.oy = (s.oy || 0) * 0.9; }
      x += s.ox || 0; y += s.oy || 0;
      s._x = x; s._y = y;
    }
    this.drawBridges();
    this.drawStellarNurseries();
    const ht = this.app.highlightedTopic;
    for (const s of this.stars) {
      const x = s._x, y = s._y;
      const heat = (s.node && typeof s.node.heat === 'number') ? s.node.heat : 0;
      const stance = s.node && s.node.stance;
      const dim = ht && s.node && s.node.topic !== ht ? 0.25 : 1;
      const heatMult = 0.8 + heat * 0.6, haloAlpha = 0.2 * (0.8 + heat * 0.6);
      let twAmp = 0.25, twRate = 60, haloColor = null, coreColor = null, haloScale = 3;
      if (stance === 'questioning') { twAmp = 0.55; twRate = 24; }
      else if (stance === 'exploring') { haloColor = 'rgba(190, 210, 255, 0.22)'; haloScale = 4.2; }
      else if (stance === 'conceding') { haloColor = 'rgba(180, 200, 240, 0.22)'; coreColor = 'rgba(220, 235, 255, 1)'; }
      const tw = Math.max(0, (1 - twAmp) + Math.sin(this.stellarT * twRate + s.twinkle) * twAmp);
      const size = s.size * tw * heatMult;
      this.ctx.fillStyle = haloColor || s.color; this.ctx.globalAlpha = haloAlpha * dim;
      this.ctx.beginPath(); this.ctx.arc(x, y, size * haloScale, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.globalAlpha = dim; this.ctx.fillStyle = coreColor || s.color;
      this.ctx.beginPath(); this.ctx.arc(x, y, size, 0, Math.PI * 2); this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#fffacd';
    this.ctx.beginPath(); this.ctx.arc(cx, cy, 6 + Math.sin(this.stellarT * 40) * 2, 0, Math.PI * 2); this.ctx.fill();
    this.drawQuasars();
    this.drawShootingStars();
  }
}

export { GalaxyMode };

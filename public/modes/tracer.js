import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete, playTone } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey, configureReverb } from '/synth.js';

const A_MINOR = [220.00, 261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 783.99, 880.00];
const FEAR_COOLDOWN_MS = 1400;
const FEAR_RANGE_PX = 200;

class TracerMode extends Mode {
  swimmers = [];
  primePhase = false;
  currents = [];
  currentSpawnTimer = 0;
  nextEmergenceCurrent = null;
  stones = [];
  tethers = [];
  tetherDragFrom = null;
  mouseDownAt = null;
  mouseX = -1;
  mouseY = -1;
  mouseDown = false;

  constructor() {
    super({
      mode: 'tracer',
      aesthetic: 'ambient',
      topicFallbackColor: '#457b9d',
      vars: {
        '--e-bg': '#060618', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#d781d5', '--e-pivot-tint': 'rgba(205,33,60,0.06)', '--e-accent': '#cd213c',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      let closest = null, cd = 20;
      this.swimmers.forEach(s => { const d = Math.hypot(s.x - this.mouseX, s.y - this.mouseY); if (d < cd) { cd = d; closest = s; } });
      if (closest) { showTooltip(e, closest.node, closest.color); this.app.highlightLegendTopic(closest.node.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('mouseleave', () => { this.mouseX = -1; this.mouseDown = false; this.tetherDragFrom = null; this.mouseDownAt = null; });
    this.canvas.addEventListener('mousedown', e => {
      const x = e.clientX, y = e.clientY;
      const hit = this.swimmerAt(x, y);
      this.mouseDownAt = { x, y, t: performance.now(), swimmer: hit };
      if (hit) { this.tetherDragFrom = hit; }
      else { if (this.primePhase) this.spawnStone(x, y); else this.mouseDown = true; }
    });
    this.canvas.addEventListener('mouseup', e => {
      const x = e.clientX, y = e.clientY;
      const startInfo = this.mouseDownAt;
      this.mouseDown = false; this.mouseDownAt = null;
      const wasTetherDrag = this.tetherDragFrom; this.tetherDragFrom = null;
      if (!startInfo) return;
      const dx = x - startInfo.x, dy = y - startInfo.y, dist = Math.hypot(dx, dy), dt = performance.now() - startInfo.t;
      const isClick = dist < 6 && dt < 350;
      if (isClick && startInfo.swimmer) { startInfo.swimmer.spinUntil = performance.now() + 600; playTone(startInfo.swimmer.tone || 440, 1.5, 'sine', 0.06); return; }
      if (wasTetherDrag) {
        const target = this.swimmerAt(x, y);
        if (target && target !== wasTetherDrag) {
          this.tethers.push({ x1: wasTetherDrag.x, y1: wasTetherDrag.y, x2: target.x, y2: target.y, age: 0, maxAge: 180 });
          playTone(330, 0.18, 'triangle', 0.05);
        }
      }
    });
  }

  count() { return this.swimmers.length; }
  legendItems() { return this.swimmers; }

  nodeIncoming(id) { if (id == null) return 0; if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id]; return incomingRefsOf(id, this.swimmers.map(x => x.node).filter(Boolean)); }
  hasExternalBecause(n) { const b = n && n.because; return Array.isArray(b) && b.some(x => typeof x === 'string'); }
  swimmerByNodeId(id) { for (const s of this.swimmers) if (s.node && s.node.id === id) return s; return null; }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'tracer');
      configureReverb({ duration: 4.5, decay: 2.8, wet: 0.65 });
    });
  }

  playSwimmerDrone(toneHz) {
    playSynth({ freq: toneHz, wave: 'sine', voices: 2, detune: 3, attack: 0.5, decay: 0.3, sustain: 0.65, release: 3.0, duration: 12, vol: 0.04, reverbSend: 0.45, delaySend: 0.12 });
  }

  maybeFearWobble(prey, now) {
    if (!prey || !prey.node || !prey.node.id) return;
    for (const predator of this.swimmers) {
      if (predator === prey || !predator.node || predator.node.rel !== 'contradicts') continue;
      if (!Array.isArray(predator.node.refs) || !predator.node.refs.includes(prey.node.id)) continue;
      const d = Math.hypot(predator.x - prey.x, predator.y - prey.y);
      if (d >= FEAR_RANGE_PX) continue;
      if (now - prey.lastFearPing < FEAR_COOLDOWN_MS) return;
      prey.lastFearPing = now;
      const cents = (Math.random() < 0.5 ? -1 : 1) * (12 + Math.random() * 8);
      playSynth({ freq: prey.tone, wave: 'sine', detune: cents, attack: 0.02, decay: 0.12, sustain: 0.35, release: 0.6, duration: 0.4, vol: 0.055, reverbSend: 0.4, delaySend: 0.15 });
      return;
    }
  }

  addSwimmer(node) {
    const info = this.topicInfo(node.topic);
    let x, y, vx, vy;
    if (this.nextEmergenceCurrent && this.nextEmergenceCurrent.points.length > 4) {
      const head = this.nextEmergenceCurrent.points[this.nextEmergenceCurrent.points.length - 1];
      x = head.x; y = head.y; vx = this.nextEmergenceCurrent.vx; vy = this.nextEmergenceCurrent.vy;
      this.nextEmergenceCurrent.color = info.color; this.nextEmergenceCurrent.boost = 1; this.nextEmergenceCurrent = null;
    } else {
      const edge = Math.floor(Math.random() * 4);
      if (edge === 0) { x = 0; y = Math.random() * this.H; vx = 1 + Math.random(); vy = (Math.random() - 0.5) * 2; }
      else if (edge === 1) { x = this.W; y = Math.random() * this.H; vx = -(1 + Math.random()); vy = (Math.random() - 0.5) * 2; }
      else if (edge === 2) { x = Math.random() * this.W; y = 0; vx = (Math.random() - 0.5) * 2; vy = 1 + Math.random(); }
      else { x = Math.random() * this.W; y = this.H; vx = (Math.random() - 0.5) * 2; vy = -(1 + Math.random()); }
    }
    const tone = A_MINOR[this.swimmers.length % A_MINOR.length];
    const stance = node.stance;
    let sizeMult = 1, speedMult = 1, wiggleAmp = 1, bobMode = null;
    if (stance === 'claiming') { sizeMult = 1.3; speedMult = 1.2; wiggleAmp = 0.4; }
    else if (stance === 'questioning') { bobMode = 'pulse'; }
    else if (stance === 'conceding') { sizeMult = 0.9; speedMult = 0.45; wiggleAmp = 0.4; bobMode = 'drift'; }
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    speedMult *= 0.7 + heat * 0.8;
    const inbound = this.nodeIncoming(node.id);
    const pivotScale = inbound >= 3 ? 1 + Math.min(inbound - 2, 5) * 0.12 : 1;
    const elapsed = typeof node.elapsed_ms === 'number' ? node.elapsed_ms : 0;
    const temp = Math.max(0, Math.min(1, (elapsed - 600) / 3400));
    const wakeTint = { r: Math.round(255 * (1 - temp) + 90 * temp), g: Math.round(130 * (1 - temp) + 150 * temp), b: Math.round(80 * (1 - temp) + 230 * temp) };
    const isExternal = this.hasExternalBecause(node);
    if (isExternal) { const sp = Math.hypot(vx, vy) || 1; vx *= 1.8 * (sp + 0.3) / sp; vy *= 1.8 * (sp + 0.3) / sp; }
    const rgb = [parseInt(info.color.slice(1, 3), 16), parseInt(info.color.slice(3, 5), 16), parseInt(info.color.slice(5, 7), 16)];
    this.swimmers.push({ x, y, vx, vy, color: info.color, rgb, size: (5 + node.confidence * 5) * sizeMult * pivotScale, trail: [], trailMaxAge: 28 + node.confidence * 28, node, wigglePhase: Math.random() * Math.PI * 2, speed: (0.8 + node.confidence * 0.8) * speedMult, tone, stance: stance || null, wiggleAmp, bobMode, wakeTint, isExternal, lastFearPing: 0 });
    this.playSwimmerDrone(tone);
  }

  spawnCurrent() {
    const edge = Math.floor(Math.random() * 4), speed = 0.9 + Math.random() * 0.6, diag = (Math.random() - 0.5) * 1.2;
    let x, y, vx, vy;
    if (edge === 0) { x = -20; y = Math.random() * this.H; vx = speed; vy = diag; }
    else if (edge === 1) { x = this.W + 20; y = Math.random() * this.H; vx = -speed; vy = diag; }
    else if (edge === 2) { x = Math.random() * this.W; y = -20; vx = diag; vy = speed; }
    else { x = Math.random() * this.W; y = this.H + 20; vx = diag; vy = -speed; }
    const c = { points: [{ x, y }], vx, vy, age: 0, maxAge: 300, alpha: 1, color: null, boost: 0 };
    this.currents.push(c);
    this.nextEmergenceCurrent = c;
  }

  startPrime() { this.primePhase = true; this.currents = []; this.currentSpawnTimer = 20; this.nextEmergenceCurrent = null; }
  stopPrime() { this.primePhase = false; }

  simulatePrime() {
    if (this.primePhase) { this.currentSpawnTimer--; if (this.currentSpawnTimer <= 0 && this.currents.length < 5) { this.spawnCurrent(); this.currentSpawnTimer = 60 + Math.random() * 80; } }
    for (let i = this.currents.length - 1; i >= 0; i--) {
      const c = this.currents[i]; c.age++;
      const head = c.points[c.points.length - 1], nx = head.x + c.vx, ny = head.y + c.vy;
      c.points.push({ x: nx, y: ny });
      if (c.points.length > 140) c.points.shift();
      if (c.boost > 0) c.boost *= 0.94;
      const offCanvas = nx < -40 || nx > this.W + 40 || ny < -40 || ny > this.H + 40;
      if (c.age > c.maxAge || (offCanvas && c.points[0].x !== head.x && c.points.length < 3)) {
        this.currents.splice(i, 1);
        if (c === this.nextEmergenceCurrent) this.nextEmergenceCurrent = null;
      }
    }
  }

  spawnStone(x, y) {
    this.stones.push({ x, y, age: 0, maxAge: 90, maxR: 180 });
    playTone(220 + Math.random() * 80, 0.4, 'sine', 0.04);
  }

  simulateStones() {
    for (let i = this.stones.length - 1; i >= 0; i--) {
      const s = this.stones[i]; s.age++;
      if (s.age > s.maxAge) { this.stones.splice(i, 1); continue; }
      const t = s.age / s.maxAge, r = s.maxR * t, ringWidth = 30;
      for (const c of this.currents) {
        const head = c.points[c.points.length - 1], dx = head.x - s.x, dy = head.y - s.y, d = Math.hypot(dx, dy);
        if (d > r - ringWidth && d < r + ringWidth) { const push = 0.4 * (1 - t); c.vx += (dx / Math.max(1, d)) * push; c.vy += (dy / Math.max(1, d)) * push; }
      }
    }
  }

  swimmerAt(x, y, hitR = 14) {
    let closest = null, cd = hitR;
    this.swimmers.forEach(s => { const d = Math.hypot(s.x - x, s.y - y); if (d < cd) { cd = d; closest = s; } });
    return closest;
  }

  applyRefsBehaviour(s) {
    const node = s.node;
    if (!node || !Array.isArray(node.refs) || !node.refs.length) return;
    const rel = node.rel;
    for (const tid of node.refs) {
      const target = this.swimmerByNodeId(tid); if (!target || target === s) continue;
      const dx = target.x - s.x, dy = target.y - s.y, d = Math.hypot(dx, dy); if (d < 1) continue;
      const nx = dx / d, ny = dy / d;
      if (rel === 'supports') { const pull = 0.018 * Math.min(1, 180 / d); s.vx += nx * pull; s.vy += ny * pull; const tsp = Math.hypot(target.vx, target.vy) || 1; s.vx += (target.vx / tsp) * 0.007; s.vy += (target.vy / tsp) * 0.007; }
      else if (rel === 'contradicts') { if (d < 200) { const push = 0.045 * (1 - d / 200); s.vx -= nx * push; s.vy -= ny * push; } }
      else if (rel === 'synthesizes') { const pull = 0.035 * Math.min(1, 200 / d); s.vx += nx * pull; s.vy += ny * pull; }
      else if (rel === 'refines') { const pull = 0.014 * Math.min(1, 160 / d); s.vx += nx * pull; s.vy += ny * pull; }
      else if (rel === 'questions') { const pull = 0.022 * Math.min(1, 180 / d); s.vx += -ny * pull; s.vy += nx * pull; }
      else if (rel === 'supersedes') { if (d < 60) { target.vx += -nx * 0.28; target.vy += -ny * 0.28; } else { const pull = 0.032 * Math.min(1, 160 / d); s.vx += nx * pull; s.vy += ny * pull; } }
    }
  }

  simulate() {
    const now = performance.now();
    this.swimmers.forEach(s => {
      this.applyRefsBehaviour(s);
      this.maybeFearWobble(s, now);
      s.wigglePhase += 0.05;
      const turn = Math.sin(s.wigglePhase) * 0.012 * (s.wiggleAmp || 1);
      const cosT = Math.cos(turn), sinT = Math.sin(turn);
      const tvx = s.vx * cosT - s.vy * sinT, tvy = s.vx * sinT + s.vy * cosT;
      s.vx = tvx; s.vy = tvy;
      if (s.bobMode === 'pulse') { const bob = Math.sin(s.wigglePhase * 1.2) * 0.08; const spd = Math.hypot(s.vx, s.vy) || 1; s.vx += -(s.vy / spd) * bob; s.vy += (s.vx / spd) * bob; }
      else if (s.bobMode === 'drift') s.vy += 0.008;
      if (this.mouseDown && this.mouseX > 0) { const dx = this.mouseX - s.x, dy = this.mouseY - s.y, d = Math.max(20, Math.hypot(dx, dy)); if (d < 150) { s.vx += (dx / d) * 0.5; s.vy += (dy / d) * 0.5; } }
      if (s.spinUntil && now < s.spinUntil) { const sp = Math.hypot(s.vx, s.vy) || 1; const angle = Math.atan2(s.vy, s.vx) + 0.35; s.vx = Math.cos(angle) * sp; s.vy = Math.sin(angle) * sp; }
      const sp = Math.hypot(s.vx, s.vy) || 0.001, target = s.speed;
      s.vx = (s.vx / sp) * (sp * 0.97 + target * 0.03); s.vy = (s.vy / sp) * (sp * 0.97 + target * 0.03);
      s.x += s.vx; s.y += s.vy;
      if (s.x < -20) s.x = this.W + 10; if (s.x > this.W + 20) s.x = -10;
      if (s.y < -20) s.y = this.H + 10; if (s.y > this.H + 20) s.y = -10;
      s.trail.push({ x: s.x, y: s.y, age: 0 });
      for (const p of s.trail) p.age++;
      while (s.trail.length > 0 && s.trail[0].age > s.trailMaxAge) s.trail.shift();
    });
    for (let i = this.tethers.length - 1; i >= 0; i--) { this.tethers[i].age++; if (this.tethers[i].age > this.tethers[i].maxAge) this.tethers.splice(i, 1); }
  }

  drawPrime() {
    for (const c of this.currents) {
      const pts = c.points; if (pts.length < 2) continue;
      const col = c.color || '#6aa8c4';
      const [rr, gg, bb] = [parseInt(col.slice(1,3),16), parseInt(col.slice(3,5),16), parseInt(col.slice(5,7),16)];
      for (let i = 1; i < pts.length; i++) {
        const t = i / pts.length, envelope = Math.sin(t * Math.PI);
        const baseAlpha = c.color ? 0.35 : 0.18, alpha = envelope * baseAlpha * (1 + c.boost * 2);
        if (alpha <= 0.01) continue;
        this.ctx.strokeStyle = `rgba(${rr},${gg},${bb},${alpha})`; this.ctx.lineWidth = 0.9 + envelope * 0.8 + c.boost * 1.5;
        this.ctx.beginPath(); this.ctx.moveTo(pts[i - 1].x, pts[i - 1].y); this.ctx.lineTo(pts[i].x, pts[i].y); this.ctx.stroke();
      }
    }
  }

  drawStones() {
    for (const s of this.stones) {
      const t = s.age / s.maxAge, r = s.maxR * t, alpha = (1 - t) * 0.6;
      this.ctx.strokeStyle = `rgba(140,200,230,${alpha})`; this.ctx.lineWidth = 1.5;
      this.ctx.beginPath(); this.ctx.arc(s.x, s.y, r, 0, Math.PI * 2); this.ctx.stroke();
      if (t < 0.5) { this.ctx.strokeStyle = `rgba(140,200,230,${alpha * 0.4})`; this.ctx.lineWidth = 1; this.ctx.beginPath(); this.ctx.arc(s.x, s.y, r * 0.55, 0, Math.PI * 2); this.ctx.stroke(); }
    }
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one swimmer-current per token entering from a hashed edge.
  // These ghost swimmers draw exploratory trails across the dark canvas while the
  // model thinks.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const edge = h % 4;
      const speed = 0.9 + ((h >> 8) % 8) / 10;
      const diag = (((h >> 12) % 24) / 10 - 1.2);
      let x, y, vx, vy;
      if (edge === 0) { x = -20; y = 30 + ((h >> 4) % (this.H - 60)); vx = speed; vy = diag; }
      else if (edge === 1) { x = this.W + 20; y = 30 + ((h >> 4) % (this.H - 60)); vx = -speed; vy = diag; }
      else if (edge === 2) { x = 30 + ((h >> 4) % (this.W - 60)); y = -20; vx = diag; vy = speed; }
      else { x = 30 + ((h >> 4) % (this.W - 60)); y = this.H + 20; vx = diag; vy = -speed; }
      const c = { points: [{ x, y }], vx, vy, age: 0, maxAge: 280, alpha: 1, color: null, boost: 0 };
      this.currents.push(c);
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.addSwimmer(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.swimmers = []; this.currents = []; this.stones = []; this.tethers = [];
    this.tetherDragFrom = null; this.primePhase = false; this.nextEmergenceCurrent = null;
    const grad = this.ctx.createLinearGradient(0, 0, 0, this.H);
    grad.addColorStop(0, '#0a0a26');
    grad.addColorStop(1, '#020208');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (!this.app.isPaused()) { this.simulate(); this.simulatePrime(); this.simulateStones(); }
    const grad = this.ctx.createLinearGradient(0, 0, 0, this.H);
    if (this.app.isPaused()) {
      grad.addColorStop(0, '#0a0a26');
      grad.addColorStop(1, '#020208');
    } else {
      grad.addColorStop(0, 'rgba(20, 20, 52, 0.12)');
      grad.addColorStop(1, 'rgba(2, 2, 8, 0.12)');
    }
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawPrime(); this.drawStones();
    for (const t of this.tethers) {
      const fade = 1 - t.age / t.maxAge, dx = t.x2 - t.x1, dy = t.y2 - t.y1;
      const mx = (t.x1 + t.x2) / 2 - dy * 0.06, my = (t.y1 + t.y2) / 2 + dx * 0.06;
      this.ctx.strokeStyle = `rgba(180,220,240,${0.28 * fade})`; this.ctx.lineWidth = 1.2;
      this.ctx.beginPath(); this.ctx.moveTo(t.x1, t.y1); this.ctx.quadraticCurveTo(mx, my, t.x2, t.y2); this.ctx.stroke();
      this.ctx.strokeStyle = `rgba(180,220,240,${0.08 * fade})`; this.ctx.lineWidth = 4;
      this.ctx.beginPath(); this.ctx.moveTo(t.x1, t.y1); this.ctx.quadraticCurveTo(mx, my, t.x2, t.y2); this.ctx.stroke();
    }
    if (this.tetherDragFrom && this.mouseX > 0) {
      this.ctx.strokeStyle = 'rgba(180,220,240,0.35)'; this.ctx.setLineDash([4, 4]); this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.moveTo(this.tetherDragFrom.x, this.tetherDragFrom.y); this.ctx.lineTo(this.mouseX, this.mouseY); this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
    const ht = this.app.highlightedTopic;
    this.swimmers.forEach(s => {
      const dimmed = ht && s.node.topic !== ht, dimFactor = dimmed ? 0.03 : 1;
      if (s.trail.length > 1) for (let i = 1; i < s.trail.length; i++) {
        const p = s.trail[i], fade = 1 - p.age / s.trailMaxAge;
        const wt = s.wakeTint;
        if (wt) { const [r, g, b] = s.rgb; const mr = Math.round(r * 0.6 + wt.r * 0.4), mg = Math.round(g * 0.6 + wt.g * 0.4), mb = Math.round(b * 0.6 + wt.b * 0.4); this.ctx.strokeStyle = `rgb(${mr},${mg},${mb})`; }
        else this.ctx.strokeStyle = s.color;
        this.ctx.globalAlpha = fade * 0.22 * dimFactor; this.ctx.lineWidth = s.size * 0.22 * fade;
        this.ctx.beginPath(); this.ctx.moveTo(s.trail[i-1].x, s.trail[i-1].y); this.ctx.lineTo(p.x, p.y); this.ctx.stroke();
      }
      const angle = Math.atan2(s.vy, s.vx);
      this.ctx.save(); this.ctx.translate(s.x, s.y); this.ctx.rotate(angle);
      const [tr, tg, tb] = s.rgb;
      const dtr = Math.round(tr * 0.6), dtg = Math.round(tg * 0.6), dtb = Math.round(tb * 0.6);
      this.ctx.fillStyle = `rgb(${dtr},${dtg},${dtb})`; this.ctx.globalAlpha = 0.9 * dimFactor;
      this.ctx.beginPath(); this.ctx.moveTo(-s.size * 0.7, 0); this.ctx.lineTo(-s.size * 2.4, -s.size * 1.5); this.ctx.lineTo(-s.size * 1.5, 0); this.ctx.lineTo(-s.size * 2.4, s.size * 1.5); this.ctx.closePath(); this.ctx.fill();
      this.ctx.fillStyle = s.color; this.ctx.globalAlpha = 0.95 * dimFactor;
      this.ctx.beginPath(); this.ctx.ellipse(0, 0, s.size * 1.25, s.size * 0.78, 0, 0, Math.PI * 2); this.ctx.fill();
      if (s.stance !== 'conceding') { this.ctx.fillStyle = `rgb(${dtr},${dtg},${dtb})`; this.ctx.globalAlpha = 0.75 * dimFactor; this.ctx.beginPath(); this.ctx.moveTo(-s.size * 0.35, -s.size * 0.72); this.ctx.lineTo(0, -s.size * 1.4); this.ctx.lineTo(s.size * 0.4, -s.size * 0.72); this.ctx.closePath(); this.ctx.fill(); }
      this.ctx.fillStyle = '#fff'; this.ctx.globalAlpha = 0.9 * dimFactor;
      this.ctx.beginPath(); this.ctx.arc(s.size * 0.7, -s.size * 0.18, Math.max(1.2, s.size * 0.22), 0, Math.PI * 2); this.ctx.fill();
      this.ctx.restore();
    });
    this.ctx.globalAlpha = 1;
  }
}

export { TracerMode };

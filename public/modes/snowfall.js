import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete } from '/clinky.js';
import { quantizeToKey, midiToFreq, pickSessionKey, setAesthetic, playSynth, PRESETS, configureReverb } from '/synth.js';

const PIN_BAR_FRAC = 0.6;
const HEX_ANGLE = Math.PI / 3;
const CATCH_RADIUS = 40;

class SnowfallMode extends Mode {
  flakes = [];
  settled = [];
  primePhase = false;
  frost = [];
  frostSpawnTimer = 0;
  mouseX = -1;
  mouseY = -1;
  caughtFlake = null;
  examining = null;
  bridgeStates = new Map();

  constructor() {
    super({
      mode: 'snowfall',
      aesthetic: 'ambient',
      topicFallbackColor: '#a8dadc',
      vars: {
        '--e-bg': '#0a0a18', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#cae6ff', '--e-pivot-tint': 'rgba(202,230,255,0.06)', '--e-accent': '#a0c4ff',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left; this.mouseY = e.clientY - r.top;
      let closest = null, cd = 25;
      this.flakes.forEach(f => { const d = Math.hypot(f.x - this.mouseX, f.y - this.mouseY); if (d < cd) { cd = d; closest = f; } });
      if (closest) { showTooltip(e, closest.node, closest.color); this.app.highlightLegendTopic(closest.node.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
      this.canvas.style.cursor = this.caughtFlake ? 'grab' : 'crosshair';
    });
    this.canvas.addEventListener('mouseleave', () => { this.mouseX = -1; this.mouseY = -1; });
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.primePhase) {
        const cx = this.W / 2, cy = this.H / 2;
        const raw = Math.atan2(cy - my, cx - mx);
        const heading = Math.round(raw / HEX_ANGLE) * HEX_ANGLE;
        this.spawnFrost({ x: mx, y: my }, heading); return;
      }
      let best = null, bestD = 25;
      for (const f of this.flakes) { const d = Math.hypot(f.x - mx, f.y - my); if (d < bestD) { bestD = d; best = f; } }
      if (best) this.examining = { flake: best, t: 0, duration: 90 };
    });
  }

  count() { return this.flakes.length; }
  legendItems() { return this.flakes; }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.flakes.map(f => f.node).filter(Boolean));
  }

  hasExternalBecause(n) { const b = n && n.because; return Array.isArray(b) && b.some(x => typeof x === 'string'); }
  flakeByNodeId(id) { for (const f of this.flakes) if (f.node && f.node.id === id) return f; return null; }

  sideBuffer() {
    const el = document.querySelector('.topic-legend');
    if (!el) return 40;
    const rect = el.getBoundingClientRect();
    return Math.max(40, window.innerWidth - rect.left + 12);
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'snowfall');
      configureReverb({ duration: 5.0, decay: 3.0, wet: 0.7 });
    });
  }

  pinBarY() { return this.H * PIN_BAR_FRAC; }

  playIceBell(node) {
    if (!node) return;
    const info = this.topicInfo(node.topic);
    const rawFreq = info.note || 440;
    const rawMidi = Math.round(69 + 12 * Math.log2(rawFreq / 440));
    const midi = quantizeToKey(rawMidi) + 12;
    const elapsed = typeof node.elapsed_ms === 'number' ? node.elapsed_ms : 0;
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const conf = typeof node.confidence === 'number' ? node.confidence : 0.7;
    const duration = 0.7 + Math.min(elapsed, 6000) / 6000 * 1.7;
    const vol = 0.09 * (0.7 + conf * 0.4);
    playSynth({ midi, ...PRESETS.bell, duration, vol, reverbSend: 0.65, delaySend: 0.12 });
    if (heat > 0.15) playSynth({ midi: midi + 19, ...PRESETS.bell, duration: duration * 0.7, vol: vol * 0.45 * heat, reverbSend: 0.6, delaySend: 0.12 });
    if (heat > 0.4) playSynth({ midi: midi + 24, ...PRESETS.bell, duration: duration * 0.55, vol: vol * 0.3 * heat, reverbSend: 0.6, delaySend: 0.12 });
  }

  playPinPluck(node) {
    if (!node) return;
    const info = this.topicInfo(node.topic);
    const rawFreq = info.note || 440;
    const rawMidi = Math.round(69 + 12 * Math.log2(rawFreq / 440));
    const midi = quantizeToKey(rawMidi) + 24;
    const conf = typeof node.confidence === 'number' ? node.confidence : 0.7;
    playSynth({ midi, wave: 'sine', attack: 0.001, decay: 0.12, sustain: 0.0, release: 0.4, duration: 0.3, vol: 0.05 * (0.7 + conf * 0.4), reverbSend: 0.55, delaySend: 0.15 });
  }

  checkPinBarCrossing(flake) {
    if (flake.settled || flake._pinned) return;
    if (flake.y >= this.pinBarY()) { flake._pinned = true; this.playPinPluck(flake.node); }
  }

  makeArmTemplate(size, node) {
    const segs = [];
    segs.push([0, 0, 0, -size]);
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const baseDensity = node.type === 'resolution' ? 1.0 : node.type === 'dead-end' ? 0.35 : node.type === 'aside' ? 0.45 : 0.75;
    const density = baseDensity * (0.7 + heat * 0.8);
    const branchCount = 2 + Math.floor(Math.random() * 3 * density);
    for (let i = 0; i < branchCount; i++) {
      const t = 0.15 + (i / Math.max(branchCount, 1)) * 0.7 + (Math.random() - 0.5) * 0.06;
      const py = -size * t;
      const ang = (Math.PI / 3) + Math.random() * (Math.PI / 4), len = size * (0.22 + Math.random() * 0.28) * (1 - t * 0.45);
      const dx = Math.sin(ang) * len, dy = -Math.cos(ang) * len;
      segs.push([0, py, -dx, py + dy]); segs.push([0, py, dx, py + dy]);
      if (Math.random() < 0.55 * density) {
        const subT = 0.45 + Math.random() * 0.3, subBx = dx * subT, subBy = py + dy * subT, subLen = len * (0.35 + Math.random() * 0.35);
        const subAng = ang - (Math.PI / 4) - Math.random() * (Math.PI / 6), sdx = Math.sin(subAng) * subLen, sdy = -Math.cos(subAng) * subLen;
        segs.push([-subBx, subBy, -subBx - sdx, subBy + sdy]); segs.push([-subBx, subBy, -subBx + sdx * 0.35, subBy + sdy * 0.35]);
        segs.push([subBx, subBy, subBx + sdx, subBy + sdy]); segs.push([subBx, subBy, subBx - sdx * 0.35, subBy + sdy * 0.35]);
      }
    }
    if (Math.random() < 0.4) {
      const tipLen = size * 0.08;
      if (Math.random() < 0.5) segs.push([-tipLen, -size, tipLen, -size]);
      else { segs.push([0, -size, -tipLen, -size - tipLen]); segs.push([0, -size, tipLen, -size - tipLen]); }
    }
    return segs;
  }

  addFlake(node) {
    const info = this.topicInfo(node.topic);
    const inbound = this.nodeIncoming(node.id);
    const pivotScale = inbound >= 3 ? 1 + Math.min(inbound - 2, 5) * 0.14 : 1;
    const size = (14 + node.confidence * 26) * pivotScale;
    const stance = node.stance;
    let symmetry = node.type === 'dead-end' ? 3 : 6;
    if (node.type !== 'dead-end' && stance === 'exploring') symmetry = ((node.id || 0) % 2 === 0) ? 5 : 7;
    const armScales = [];
    for (let k = 0; k < symmetry; k++) armScales.push(1);
    if (node.type !== 'dead-end') {
      if (stance === 'questioning') { const omit = (node.id || 0) % symmetry; armScales[omit] = 0; }
      else if (stance === 'conceding') { const base = (node.id || 0) % symmetry; armScales[base] = 0.55; armScales[(base + 3) % symmetry] = 0.65; }
    }
    const elapsed = typeof node.elapsed_ms === 'number' ? node.elapsed_ms : 0;
    const fallFactor = Math.max(0.35, 1.3 - Math.min(elapsed, 5000) / 5000 * 0.95);
    const edgeBuffer = size + 10, buf = this.sideBuffer();
    const minX = Math.max(edgeBuffer, buf), maxX = Math.min(this.W - edgeBuffer, this.W - buf);
    const isExternal = this.hasExternalBecause(node);
    let spawnX = minX + Math.random() * Math.max(0, maxX - minX), spawnY = -size * 2, spawnVx = (Math.random() - 0.5) * 0.3;
    if (isExternal) { const fromLeft = Math.random() < 0.5; spawnX = fromLeft ? minX + size : maxX - size; spawnY = -size - Math.random() * (this.H * 0.25); spawnVx = fromLeft ? 0.9 + Math.random() * 0.4 : -(0.9 + Math.random() * 0.4); }
    this.flakes.push({ x: spawnX, y: spawnY, vy: (0.3 + Math.random() * 0.5) * fallFactor, vx: spawnVx, size, symmetry, armScales, armTemplate: this.makeArmTemplate(size, node), centrePlateR: Math.random() < 0.3 ? size * (0.08 + Math.random() * 0.08) : 0, color: info.color, rotation: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 0.01, node, settled: false, wobblePhase: Math.random() * Math.PI * 2, pivotScale, isExternal, _pinned: false });
  }

  drawCrystal(flake, alpha) {
    this.ctx.strokeStyle = flake.color; this.ctx.globalAlpha = alpha; this.ctx.lineWidth = 0.9 + flake.size / 70; this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    const cx = flake.x, cy = flake.y, step = (Math.PI * 2) / flake.symmetry, armScales = flake.armScales || null;
    for (let k = 0; k < flake.symmetry; k++) {
      const scale = armScales ? armScales[k] : 1; if (scale <= 0.01) continue;
      const a = flake.rotation + step * k, ca = Math.cos(a), sa = Math.sin(a);
      this.ctx.beginPath();
      for (const [x1, y1, x2, y2] of flake.armTemplate) {
        const sx1 = x1 * scale, sy1 = y1 * scale, sx2 = x2 * scale, sy2 = y2 * scale;
        const rx1 = sx1 * ca - sy1 * sa + cx, ry1 = sx1 * sa + sy1 * ca + cy;
        const rx2 = sx2 * ca - sy2 * sa + cx, ry2 = sx2 * sa + sy2 * ca + cy;
        this.ctx.moveTo(rx1, ry1); this.ctx.lineTo(rx2, ry2);
      }
      this.ctx.stroke();
    }
    if (flake.centrePlateR > 0) {
      const r = flake.centrePlateR; this.ctx.beginPath();
      for (let i = 0; i < 6; i++) { const a = flake.rotation + (Math.PI * 2 / 6) * i; const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r; if (i === 0) this.ctx.moveTo(px, py); else this.ctx.lineTo(px, py); }
      this.ctx.closePath(); this.ctx.stroke();
    }
  }

  spawnFrost(origin, heading) {
    let x, y, h;
    if (origin) { x = origin.x; y = origin.y; h = heading; }
    else {
      const edge = Math.floor(Math.random() * 4);
      if (edge === 0) { x = Math.random() * this.W; y = 0; h = Math.PI / 2; }
      else if (edge === 1) { x = this.W; y = Math.random() * this.H; h = Math.PI; }
      else if (edge === 2) { x = Math.random() * this.W; y = this.H; h = -Math.PI / 2; }
      else { x = 0; y = Math.random() * this.H; h = 0; }
      h += (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.5 ? 0 : HEX_ANGLE / 2);
    }
    this.frost.push({ points: [{ x, y }], heading: h, growing: true, maxLength: 50 + Math.random() * 90, alpha: 0, targetAlpha: 0.3 + Math.random() * 0.18, width: 0.5 + Math.random() * 0.5, branchDelay: 18 + Math.random() * 22 });
  }

  startPrime() {
    this.primePhase = true; this.frost = []; this.frostSpawnTimer = 8;
    for (let i = 0; i < 3; i++) this.spawnFrost();
  }

  stopPrime() { this.primePhase = false; for (const t of this.frost) t.growing = false; }

  simulatePrime() {
    if (this.primePhase) {
      this.frostSpawnTimer--;
      const livingCount = this.frost.reduce((n, t) => n + (t.growing ? 1 : 0), 0);
      if (this.frostSpawnTimer <= 0 && livingCount < 12 && this.frost.length < 80) { this.spawnFrost(); this.frostSpawnTimer = 18 + Math.random() * 28; }
    }
    for (let i = this.frost.length - 1; i >= 0; i--) {
      const t = this.frost[i];
      t.alpha += (t.targetAlpha - t.alpha) * 0.04;
      if (!this.primePhase) t.targetAlpha *= 0.992;
      if (t.growing) {
        const tip = t.points[t.points.length - 1], step = 1.2;
        const nx = tip.x + Math.cos(t.heading) * step, ny = tip.y + Math.sin(t.heading) * step;
        t.points.push({ x: nx, y: ny });
        if (t.points.length > t.maxLength) t.growing = false;
        if (nx < -10 || nx > this.W + 10 || ny < -10 || ny > this.H + 10) t.growing = false;
        if (Math.random() < 0.03) { const snap = Math.round(t.heading / HEX_ANGLE) * HEX_ANGLE; t.heading += (snap - t.heading) * 0.5; }
        t.branchDelay--;
        if (t.branchDelay <= 0 && this.frost.length < 80 && Math.random() < 0.22) {
          const branchDir = Math.random() < 0.5 ? -HEX_ANGLE : HEX_ANGLE;
          this.spawnFrost({ x: nx, y: ny }, t.heading + branchDir);
          t.branchDelay = 22 + Math.random() * 30;
        }
      }
      if (t.alpha < 0.01 && !t.growing) this.frost.splice(i, 1);
    }
  }

  drawFrostBridges() {
    for (const src of this.settled) {
      const node = src.node; if (!node || !Array.isArray(node.refs) || !node.refs.length) continue;
      const rel = node.rel;
      for (const tid of node.refs) {
        const tgt = this.flakeByNodeId(tid); if (!tgt || !tgt.settled || tgt === src) continue;
        const key = `${node.id}:${tid}`;
        let st = this.bridgeStates.get(key);
        if (!st) { st = { progress: 0, holdT: 0, alphaMult: 1 }; this.bridgeStates.set(key, st); }
        if (st.progress < 1) st.progress = Math.min(1, st.progress + 0.012);
        else if (st.holdT < 40) st.holdT++;
        else if (st.alphaMult > 0.18) st.alphaMult = Math.max(0.18, st.alphaMult - 0.009);
        this.drawFrostBridge(src.x, src.y, tgt.x, tgt.y, rel, st.progress, st.alphaMult);
      }
    }
  }

  drawFrostBridge(x1, y1, x2, y2, rel, progress, aMul) {
    const dx = x2 - x1, dy = y2 - y1, dist = Math.hypot(dx, dy);
    if (dist < 30) return;
    const nx = -dy / dist, ny = dx / dist;
    const ink = 'rgba(200, 220, 240,';
    this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    const ex = x1 + dx * progress, ey = y1 + dy * progress;
    if (rel === 'contradicts') {
      this.ctx.strokeStyle = `${ink} ${0.3 * aMul})`; this.ctx.lineWidth = 0.8;
      if (progress <= 0.42) { this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(ex, ey); this.ctx.stroke(); }
      else {
        this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(x1 + dx * 0.42, y1 + dy * 0.42); this.ctx.stroke();
        if (progress > 0.58) { this.ctx.beginPath(); this.ctx.moveTo(x1 + dx * 0.58, y1 + dy * 0.58); this.ctx.lineTo(ex, ey); this.ctx.stroke(); }
      }
    } else if (rel === 'synthesizes') { this.ctx.strokeStyle = `${ink} ${0.48 * aMul})`; this.ctx.lineWidth = 1.6; this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(ex, ey); this.ctx.stroke(); }
    else if (rel === 'refines') {
      this.ctx.strokeStyle = `${ink} ${0.32 * aMul})`; this.ctx.lineWidth = 0.6; this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(ex, ey); this.ctx.stroke();
      for (const t of [0.3, 0.7]) { if (progress <= t) continue; const mx = x1 + dx * t, my = y1 + dy * t, tl = 5; this.ctx.strokeStyle = `${ink} ${0.18 * aMul})`; this.ctx.lineWidth = 0.5; this.ctx.beginPath(); this.ctx.moveTo(mx - nx * tl, my - ny * tl); this.ctx.lineTo(mx + nx * tl, my + ny * tl); this.ctx.stroke(); }
    } else if (rel === 'questions') { const p = Math.min(progress, 0.75); this.ctx.strokeStyle = `${ink} ${0.3 * aMul})`; this.ctx.lineWidth = 0.7; this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(x1 + dx * p, y1 + dy * p); this.ctx.stroke(); }
    else if (rel === 'supersedes') { this.ctx.strokeStyle = `${ink} ${0.18 * aMul})`; this.ctx.lineWidth = 0.6; this.ctx.setLineDash([3, 5]); this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(ex, ey); this.ctx.stroke(); this.ctx.setLineDash([]); }
    else { this.ctx.strokeStyle = `${ink} ${0.35 * aMul})`; this.ctx.lineWidth = 0.8; this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.lineTo(ex, ey); this.ctx.stroke(); }
  }

  drawFoundationHaloes() {
    for (const f of this.settled) {
      if (!f.node) continue;
      const inbound = this.nodeIncoming(f.node.id); if (inbound < 3) continue;
      const intensity = Math.min(1, (inbound - 2) / 4);
      const r = parseInt(f.color.slice(1, 3), 16), g = parseInt(f.color.slice(3, 5), 16), b = parseInt(f.color.slice(5, 7), 16);
      const radius = f.size * 1.35;
      this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.22 * intensity})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.arc(f.x, f.y, radius, 0, Math.PI * 2); this.ctx.stroke();
      this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.11 * intensity})`; this.ctx.lineWidth = 2.2;
      this.ctx.beginPath(); this.ctx.arc(f.x, f.y, radius * 1.3, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  drawFrost() {
    if (this.frost.length === 0) return;
    this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    for (const t of this.frost) {
      if (t.points.length < 2 || t.alpha < 0.01) continue;
      this.ctx.strokeStyle = `rgba(200, 220, 240, ${t.alpha})`; this.ctx.lineWidth = t.width;
      this.ctx.beginPath(); this.ctx.moveTo(t.points[0].x, t.points[0].y);
      for (let j = 1; j < t.points.length; j++) this.ctx.lineTo(t.points[j].x, t.points[j].y);
      this.ctx.stroke();
    }
  }

  simulate() {
    const groundY = this.H - 20, buf = this.sideBuffer();
    this.caughtFlake = null;
    if (this.mouseX >= 0) {
      let best = null, bestD = CATCH_RADIUS;
      for (const f of this.flakes) { if (f.settled) continue; const d = Math.hypot(f.x - this.mouseX, f.y - this.mouseY); if (d < bestD) { bestD = d; best = f; } }
      this.caughtFlake = best;
    }
    this.flakes.forEach(f => {
      if (f.settled) return;
      if (f === this.caughtFlake) { f.rotation += f.rotSpeed * 0.3; return; }
      f.wobblePhase += 0.05; f.x += f.vx + Math.sin(f.wobblePhase) * 0.3; f.y += f.vy;
      this.checkPinBarCrossing(f); f.rotation += f.rotSpeed;
      const minFx = Math.max(f.size + 10, buf), maxFx = Math.min(this.W - f.size - 10, this.W - buf);
      if (f.x < minFx) { f.x = minFx; f.vx = Math.abs(f.vx) * 0.5; }
      else if (f.x > maxFx) { f.x = maxFx; f.vx = -Math.abs(f.vx) * 0.5; }
      let settleY = groundY;
      this.settled.forEach(s => { if (Math.abs(s.x - f.x) < s.size + f.size) settleY = Math.min(settleY, s.y - s.size * 0.8); });
      if (f.y + f.size >= settleY) { f.y = settleY - f.size; f.settled = true; this.settled.push(f); this.playIceBell(f.node); }
    });
  }

  // Prompt-unpack: spawn one ghost-frost branch per token at a hashed position.
  // Each branch is a faint dendrite mark — no crystal, just a faint line — that
  // drifts down and dims, marking where real flakes will grow.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const x = 40 + (h % Math.max(1, this.W - 80));
      const y = 20 + ((h >> 8) % Math.max(1, Math.round(this.H * 0.3)));
      const heading = (((h >> 12) % 628) / 100) - Math.PI / 2;
      this.frost.push({
        points: [{ x, y }],
        heading,
        growing: true,
        maxLength: 30 + ((h >> 16) % 40),
        alpha: 0,
        targetAlpha: 0.22 + ((h >> 20) % 10) / 100,
        width: 0.5,
        branchDelay: 9999,   // no branching from unpack frost
      });
    }
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.addFlake(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.flakes = []; this.settled = []; this.frost = [];
    this.bridgeStates.clear(); this.primePhase = false;
    this.caughtFlake = null; this.examining = null;
    this.canvas.style.cursor = 'crosshair';
  }

  // Frosted window — soft cool-grey radial fog at the edges, transparent at
  // the centre. We're inside looking out through a frosted pane.
  drawFrostedWindow() {
    const cx = this.W / 2, cy = this.H / 2;
    const innerR = Math.min(this.W, this.H) * 0.30;
    const outerR = Math.max(this.W, this.H) * 0.75;
    const grad = this.ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    grad.addColorStop(0, 'rgba(180, 200, 230, 0)');
    grad.addColorStop(1, 'rgba(180, 200, 230, 0.18)');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulate(); this.simulatePrime();
    if (this.examining) { this.examining.t++; if (this.examining.t >= this.examining.duration) this.examining = null; }
    const skyGrad = this.ctx.createLinearGradient(0, 0, 0, this.H);
    skyGrad.addColorStop(0, '#080814');
    skyGrad.addColorStop(0.7, '#0c0a18');
    skyGrad.addColorStop(1, '#1a1230');
    this.ctx.fillStyle = skyGrad;
    this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawFrostedWindow();
    this.drawFrost();
    this.ctx.strokeStyle = '#1a1a30'; this.ctx.lineWidth = 1;
    this.ctx.beginPath(); this.ctx.moveTo(0, this.H - 20); this.ctx.lineTo(this.W, this.H - 20); this.ctx.stroke();
    this.drawFrostBridges(); this.drawFoundationHaloes();
    const ht = this.app.highlightedTopic;
    const examDim = this.examining ? 0.25 : 1;
    this.flakes.forEach(f => { if (f === this.examining?.flake) return; const legendDim = ht && f.node && f.node.topic !== ht ? 0.25 : 1; const a = (f.settled ? 0.55 : 0.8) * examDim * legendDim; this.drawCrystal(f, a); });
    if (this.examining) {
      const f = this.examining.flake, t = this.examining.t / this.examining.duration;
      const scale = t < 0.2 ? 1 + (t / 0.2) * 1.6 : t > 0.8 ? 1 + ((1 - t) / 0.2) * 1.6 : 2.6;
      this.ctx.save(); this.ctx.translate(f.x, f.y); this.ctx.scale(scale, scale); this.ctx.translate(-f.x, -f.y);
      this.drawCrystal(f, 1); this.ctx.restore();
    }
    this.ctx.globalAlpha = 1;
  }
}

export { SnowfallMode };

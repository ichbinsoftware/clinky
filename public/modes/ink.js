import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, playTone } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey, quantizeToKey, configureReverb } from '/synth.js';

const PRACTICE_TYPES = ['claim', 'branch', 'choice', 'dead-end', 'aside', 'resolution'];
const CORNER_ZONE = 140;

class InkMode extends Mode {
  strokes = [];
  primePhase = false;
  practiceStrokes = [];
  practiceSpawnTimer = 0;
  seal = null;

  constructor() {
    super({
      mode: 'ink',
      aesthetic: 'ambient',
      topicFallbackColor: '#2a2a30',
      vars: {
        '--e-bg': '#f2ecd8', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(168,144,96,0.12)', '--e-accent': '#8a2a2a',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.strokes.map(s => s.node).filter(Boolean), topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      if (this.strokes.length === 0) return;
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let closest = null, cd = 60;
      for (const s of this.strokes) { const d = Math.hypot(s.x - mx, s.y - my); if (d < cd) { cd = d; closest = s; } }
      if (closest) { showTooltip(e, closest.node, this.topicInfo(closest.topic).color); this.app.highlightLegendTopic(closest.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.primePhase) {
        const pHit = this.practiceAtPoint(mx, my);
        if (pHit) { this.commitPractice(pHit); return; }
        this.spawnPracticeAt(mx, my); return;
      }
      const sHit = this.strokeAtPoint(mx, my);
      if (sHit) { sHit.age = 0; this.playInkStroke(sHit.node); return; }
      if (!this.seal && this.strokes.length > 0 && this.inCornerZone(mx, my)) this.placeSeal(mx, my);
    });
  }

  count() { return this.strokes.length; }
  legendItems() { return this.strokes; }

  strokeIncoming(s) {
    const id = s.node && s.node.id;
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.strokes.map(x => x.node).filter(Boolean));
  }

  hasExternalBecause(s) {
    const b = s.node && s.node.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  sessionHasRefs() {
    for (const s of this.strokes) { const r = s.node && s.node.refs; if (Array.isArray(r) && r.length > 0) return true; }
    return false;
  }

  pseudoRand(seed) { const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('ambient');
      pickSessionKey(this.app.prompt() || 'ink');
      configureReverb({ duration: 4.0, decay: 2.8, wet: 0.65 });
    });
  }

  inkVoice(elapsed) {
    if (elapsed < 1000) return { wave: 'sine', voices: 1, detune: 0, filter: null };
    if (elapsed < 3000) return { wave: 'triangle', voices: 1, detune: 0, filter: { type: 'lowpass', freq: 2800, Q: 0.6 } };
    if (elapsed < 6000) return { wave: 'sawtooth', voices: 2, detune: 12, filter: { type: 'lowpass', freq: 1800, Q: 0.8 } };
    return { wave: 'sawtooth', voices: 4, detune: 80, filter: { type: 'bandpass', freq: 1500, Q: 2 } };
  }

  playInkStroke(node) {
    if (!node) return;
    const info = this.topicInfo(node.topic);
    const elapsed = typeof node.elapsed_ms === 'number' ? node.elapsed_ms : 0;
    const voiceShape = this.inkVoice(elapsed);
    const rawFreq = info.note || 440;
    const rawMidi = Math.round(69 + 12 * Math.log2(rawFreq / 440));
    const midi = quantizeToKey(rawMidi);
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const conf = typeof node.confidence === 'number' ? node.confidence : 0.7;
    playSynth({ midi, ...voiceShape, attack: 0.02, decay: 0.3, sustain: 0.4, release: 1.4, duration: 0.3, vol: 0.08 + conf * 0.05, reverbSend: 0.55 + heat * 0.25, delaySend: 0.15 });
  }

  inkColor(topicColor) {
    const [r, g, b] = hexToRgb(topicColor);
    const k = 0.55;
    return [Math.round(r * (1 - k) + 28 * k), Math.round(g * (1 - k) + 26 * k), Math.round(b * (1 - k) + 32 * k)];
  }

  makePath(type, confidence) {
    const pts = [];
    const size = 50 + confidence * 70;
    const widthBase = 2 + confidence * 2.5;
    if (type === 'claim') {
      for (let i = 0; i <= 20; i++) { const t = i / 20; const px = -size / 2 + t * size; const py = Math.sin(t * Math.PI) * 2 - 2; const w = widthBase * (0.4 + Math.sin(t * Math.PI) * 0.8); pts.push({ px, py, w }); }
    } else if (type === 'branch') {
      for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push({ px: 0, py: size * 0.35 - t * size * 0.35, w: widthBase * (0.5 + t * 0.7) }); }
      pts.push({ break: true });
      for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push({ px: -t * size * 0.45, py: -t * size * 0.45, w: widthBase * (1.0 - t * 0.6) }); }
      pts.push({ break: true });
      for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push({ px: t * size * 0.45, py: -t * size * 0.45, w: widthBase * (1.0 - t * 0.6) }); }
    } else if (type === 'choice') {
      for (let i = 0; i <= 30; i++) { const t = i / 30; const px = -size / 2 + t * size; const py = Math.sin(t * Math.PI * 1.5) * size * 0.25; const w = widthBase * (0.5 + Math.sin(t * Math.PI) * 0.9); pts.push({ px, py, w }); }
    } else if (type === 'dead-end') {
      for (let i = 0; i <= 12; i++) { const t = i / 12; const px = -size * 0.35 + t * size * 0.5; const py = 0; const w = t < 0.85 ? widthBase * 0.6 : widthBase * 1.8; pts.push({ px, py, w }); }
    } else if (type === 'aside') {
      for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push({ px: t * 14, py: 0, w: widthBase * 0.8 * (1 - t) }); }
    } else if (type === 'resolution') {
      const steps = 42, startAng = Math.PI * 0.78, endAng = startAng + Math.PI * 1.85, r = size * 0.36;
      for (let i = 0; i <= steps; i++) { const t = i / steps; const ang = startAng + (endAng - startAng) * t; const w = widthBase * (0.45 + Math.sin(t * Math.PI) * 1.0); pts.push({ px: Math.cos(ang) * r, py: Math.sin(ang) * r, w }); }
    } else {
      for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push({ px: -size / 2 + t * size, py: 0, w: widthBase }); }
    }
    return pts;
  }

  addStroke(node) {
    const info = this.topicInfo(node.topic);
    const margin = 120;
    const x = margin + Math.random() * (this.W - margin * 2);
    const y = margin + Math.random() * (this.H - margin * 2);
    this.strokes.push({ node, topic: node.topic, type: node.type, confidence: node.confidence, x, y, rotation: (Math.random() - 0.5) * 0.4, path: this.makePath(node.type, node.confidence), color: this.inkColor(info.color), age: 0 });
  }

  spawnPractice() {
    const margin = 120, type = PRACTICE_TYPES[Math.floor(Math.random() * PRACTICE_TYPES.length)];
    this.practiceStrokes.push({ type, x: margin + Math.random() * (this.W - margin * 2), y: margin + Math.random() * (this.H - margin * 2), rotation: (Math.random() - 0.5) * 0.4, path: this.makePath(type, 0.45 + Math.random() * 0.2), alpha: 0, targetAlpha: 0.22 + Math.random() * 0.08, age: 0, maxAge: 90 });
  }

  spawnPracticeAt(x, y) {
    const type = PRACTICE_TYPES[Math.floor(Math.random() * PRACTICE_TYPES.length)];
    this.practiceStrokes.push({ type, x, y, rotation: (Math.random() - 0.5) * 0.4, path: this.makePath(type, 0.45 + Math.random() * 0.2), alpha: 0, targetAlpha: 0.26 + Math.random() * 0.08, age: 0, maxAge: 100, userPlaced: true, committed: false });
  }

  startPrime() { this.primePhase = true; this.practiceStrokes = []; this.practiceSpawnTimer = 20; this.spawnPractice(); }
  stopPrime() { this.primePhase = false; for (const p of this.practiceStrokes) p.targetAlpha = 0; }

  simulatePrime() {
    if (this.primePhase) {
      this.practiceSpawnTimer--;
      const live = this.practiceStrokes.filter(p => !p.committed && p.targetAlpha > 0).length;
      if (this.practiceSpawnTimer <= 0 && live < 2) { this.spawnPractice(); this.practiceSpawnTimer = 90 + Math.random() * 60; }
    }
    for (let i = this.practiceStrokes.length - 1; i >= 0; i--) {
      const p = this.practiceStrokes[i];
      if (p.committed) continue;
      p.age++;
      if (p.targetAlpha > 0) {
        if (p.age < 18) p.alpha = (p.age / 18) * p.targetAlpha;
        else if (p.age < p.maxAge - 24) p.alpha = p.targetAlpha;
        else p.alpha = p.targetAlpha * Math.max(0, 1 - (p.age - (p.maxAge - 24)) / 24);
        if (p.age >= p.maxAge) { p.alpha = 0; p.targetAlpha = 0; }
      } else p.alpha *= 0.92;
      if (p.alpha < 0.005 && p.targetAlpha === 0) this.practiceStrokes.splice(i, 1);
    }
  }

  practiceAtPoint(mx, my, tol = 60) {
    let best = null, bestD = tol;
    for (const p of this.practiceStrokes) { if (p.alpha < 0.04) continue; const d = Math.hypot(p.x - mx, p.y - my); if (d < bestD) { bestD = d; best = p; } }
    return best;
  }

  strokeAtPoint(mx, my, tol = 60) {
    let best = null, bestD = tol;
    for (const s of this.strokes) { const d = Math.hypot(s.x - mx, s.y - my); if (d < bestD) { bestD = d; best = s; } }
    return best;
  }

  commitPractice(p) {
    p.committed = true; p.targetAlpha = p.alpha;
    playTone(180 + Math.random() * 40, 0.35, 'sine', 0.03);
  }

  inCornerZone(x, y) {
    const W = this.W, H = this.H;
    return (x < CORNER_ZONE && y < CORNER_ZONE) || (x > W - CORNER_ZONE && y < CORNER_ZONE) || (x < CORNER_ZONE && y > H - CORNER_ZONE);
  }

  placeSeal(x, y) {
    this.seal = { x, y };
    playTone(110, 0.12, 'sine', 0.07);
    setTimeout(() => playTone(220, 0.3, 'triangle', 0.05), 60);
  }

  worldPoint(s, p) {
    const c = Math.cos(s.rotation), sn = Math.sin(s.rotation);
    return { x: s.x + p.px * c - p.py * sn, y: s.y + p.px * sn + p.py * c };
  }

  quadAt(a, b, c, t) { const u = 1 - t; return u * u * a + 2 * u * t * b + t * t * c; }

  taperedQuad(x1, y1, cx, cy, x2, y2, t0, t1, rgb, peakW, peakA) {
    const steps = Math.max(10, Math.floor((t1 - t0) * 28));
    const [r, g, b] = rgb;
    this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    let prevX = this.quadAt(x1, cx, x2, t0), prevY = this.quadAt(y1, cy, y2, t0);
    for (let i = 1; i <= steps; i++) {
      const t = t0 + ((t1 - t0) * i) / steps;
      const x = this.quadAt(x1, cx, x2, t), y = this.quadAt(y1, cy, y2, t);
      const u = (t - t0) / (t1 - t0), env = Math.sin(u * Math.PI);
      const a = peakA * (0.15 + env * 0.85), w = peakW * (0.25 + env * 0.9);
      this.ctx.strokeStyle = `rgba(${r},${g},${b},${a})`; this.ctx.lineWidth = w;
      this.ctx.beginPath(); this.ctx.moveTo(prevX, prevY); this.ctx.lineTo(x, y); this.ctx.stroke();
      prevX = x; prevY = y;
    }
  }

  strokeById(id) { for (const s of this.strokes) if (s.node && s.node.id === id) return s; return null; }

  drawWhiskerArc(x1, y1, x2, y2, rel, rgb, srcId, tgtId) {
    const dx = x2 - x1, dy = y2 - y1, dist = Math.hypot(dx, dy);
    if (dist < 18) return;
    const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
    const nx = -dy / dist, ny = dx / dist;
    const seed = (srcId || 0) * 1000 + (tgtId || 0);
    const bow = (this.pseudoRand(seed) - 0.5) * dist * 0.34 + (this.pseudoRand(seed + 1) > 0.5 ? 1 : -1) * dist * 0.06;
    const cx = midX + nx * bow, cy = midY + ny * bow;
    if (rel === 'contradicts') { this.taperedQuad(x1, y1, cx, cy, x2, y2, 0, 0.42, rgb, 1.6, 0.32); this.taperedQuad(x1, y1, cx, cy, x2, y2, 0.58, 1, rgb, 1.6, 0.32); }
    else if (rel === 'refines') { this.taperedQuad(x1, y1, cx, cy, x2, y2, 0, 1, rgb, 0.9, 0.2); }
    else if (rel === 'questions') {
      this.taperedQuad(x1, y1, cx, cy, x2, y2, 0, 0.78, rgb, 1.5, 0.28);
      const ex = this.quadAt(x1, cx, x2, 0.78), ey = this.quadAt(y1, cy, y2, 0.78);
      const tx = this.quadAt(x1, cx, x2, 0.7), ty = this.quadAt(y1, cy, y2, 0.7);
      const dxT = ex - tx, dyT = ey - ty, len = Math.hypot(dxT, dyT) || 1;
      const perpX = -dyT / len, perpY = dxT / len;
      const [r, g, b] = rgb;
      this.ctx.strokeStyle = `rgba(${r},${g},${b},0.18)`; this.ctx.lineWidth = 1; this.ctx.lineCap = 'round';
      this.ctx.beginPath(); this.ctx.moveTo(ex, ey); this.ctx.quadraticCurveTo(ex + dxT * 0.8 + perpX * 6, ey + dyT * 0.8 + perpY * 6, ex + perpX * 10, ey + perpY * 10); this.ctx.stroke();
    } else if (rel === 'supersedes') {
      const [r, g, b] = rgb;
      this.ctx.strokeStyle = `rgba(${r},${g},${b},0.08)`; this.ctx.lineWidth = 8; this.ctx.lineCap = 'round';
      this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.quadraticCurveTo(cx, cy, x2, y2); this.ctx.stroke();
    } else { this.taperedQuad(x1, y1, cx, cy, x2, y2, 0, 1, rgb, 1.4, 0.24); }
  }

  drawWhiskers() {
    if (!this.sessionHasRefs() || this.strokes.length < 2) return;
    for (const s of this.strokes) {
      const node = s.node;
      if (!node || !Array.isArray(node.refs) || node.refs.length === 0) continue;
      const info = this.topicInfo(s.topic);
      const rgb = this.inkColor(info.color);
      if (node.rel === 'synthesizes' && node.refs.length >= 2) {
        const tgts = node.refs.map(id => this.strokeById(id)).filter(Boolean);
        if (tgts.length >= 2) {
          const pts = [{ x: s.x, y: s.y }, ...tgts.map(t => ({ x: t.x, y: t.y }))];
          const [r, g, b] = rgb;
          this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
          for (let i = 1; i < pts.length; i++) {
            const u = (i - 0.5) / (pts.length - 1), env = Math.sin(u * Math.PI);
            this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.24 * (0.2 + env * 0.8)})`; this.ctx.lineWidth = 1.6 * (0.3 + env * 0.9);
            this.ctx.beginPath(); this.ctx.moveTo(pts[i - 1].x, pts[i - 1].y); this.ctx.lineTo(pts[i].x, pts[i].y); this.ctx.stroke();
          }
          continue;
        }
      }
      for (const tid of node.refs) { const t = this.strokeById(tid); if (!t) continue; this.drawWhiskerArc(s.x, s.y, t.x, t.y, node.rel, rgb, node.id, tid); }
    }
  }

  drawExternalChips() {
    for (const s of this.strokes) {
      if (!this.hasExternalBecause(s)) continue;
      const seed = (s.node && s.node.id) || 0;
      const margin = 36, W = this.W, H = this.H;
      const dLeft = s.x, dRight = W - s.x, dTop = s.y, dBottom = H - s.y;
      const minD = Math.min(dLeft, dRight, dTop, dBottom);
      let chipX, chipY;
      if (minD === dLeft) { chipX = margin; chipY = s.y + (this.pseudoRand(seed) - 0.5) * 40; }
      else if (minD === dRight) { chipX = W - margin; chipY = s.y + (this.pseudoRand(seed) - 0.5) * 40; }
      else if (minD === dTop) { chipX = s.x + (this.pseudoRand(seed) - 0.5) * 40; chipY = margin; }
      else { chipX = s.x + (this.pseudoRand(seed) - 0.5) * 40; chipY = H - margin; }
      this.ctx.strokeStyle = 'rgba(120, 40, 44, 0.22)'; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.moveTo(s.x, s.y); this.ctx.lineTo(chipX, chipY); this.ctx.stroke();
      const size = 10;
      this.ctx.fillStyle = 'rgba(182, 34, 38, 0.85)'; this.ctx.fillRect(chipX - size / 2, chipY - size / 2, size, size);
      this.ctx.fillStyle = 'rgba(210, 50, 52, 0.3)'; this.ctx.fillRect(chipX - size / 2 + 1, chipY - size / 2 + 1, size - 2, size - 2);
    }
  }

  drawPivotHaloes() {
    for (const s of this.strokes) {
      const inbound = this.strokeIncoming(s); if (inbound < 3) continue;
      const intensity = Math.min(1, (inbound - 2) / 4);
      const [r, g, b] = s.color;
      const baseR = 30 + s.confidence * 12;
      for (let i = 0; i < 3; i++) {
        const rr = baseR + i * 10, a = (0.09 - i * 0.025) * intensity;
        if (a <= 0) continue;
        this.ctx.strokeStyle = `rgba(${r},${g},${b},${a})`; this.ctx.lineWidth = 2 + i;
        this.ctx.beginPath(); this.ctx.arc(s.x, s.y, rr, 0, Math.PI * 2); this.ctx.stroke();
      }
    }
  }

  drawSeal() {
    if (!this.seal) return;
    this.ctx.save(); this.ctx.translate(this.seal.x, this.seal.y);
    const size = 32;
    this.ctx.fillStyle = 'rgba(182, 34, 38, 0.92)'; this.ctx.fillRect(-size / 2, -size / 2, size, size);
    this.ctx.fillStyle = 'rgba(210, 50, 52, 0.35)'; this.ctx.fillRect(-size / 2 + 2, -size / 2 + 2, size - 4, size - 4);
    this.ctx.strokeStyle = 'rgba(242, 236, 216, 0.9)'; this.ctx.lineWidth = 2.4; this.ctx.lineCap = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(0, -size * 0.28); this.ctx.lineTo(0, size * 0.28);
    this.ctx.moveTo(-size * 0.28, -size * 0.08); this.ctx.lineTo(size * 0.28, -size * 0.08);
    this.ctx.moveTo(-size * 0.22, size * 0.22); this.ctx.lineTo(size * 0.22, size * 0.22);
    this.ctx.stroke();
    const grad = this.ctx.createRadialGradient(0, 0, size * 0.6, 0, 0, size * 1.2);
    grad.addColorStop(0, 'rgba(120, 20, 24, 0.15)'); grad.addColorStop(1, 'rgba(120, 20, 24, 0)');
    this.ctx.fillStyle = grad; this.ctx.fillRect(-size, -size, size * 2, size * 2);
    this.ctx.restore();
  }

  drawPractice() {
    if (this.practiceStrokes.length === 0) return;
    this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    for (const p of this.practiceStrokes) {
      if (p.alpha < 0.005) continue;
      const subs = [[]];
      for (const pt of p.path) { if (pt.break) { subs.push([]); continue; } subs[subs.length - 1].push({ ...this.worldPoint(p, pt), w: pt.w }); }
      for (const sub of subs) {
        for (let i = 1; i < sub.length; i++) {
          const a = sub[i - 1], b = sub[i], w = ((a.w + b.w) / 2) * 0.7;
          this.ctx.strokeStyle = `rgba(120, 115, 120, ${p.alpha})`; this.ctx.lineWidth = w;
          this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
        }
      }
    }
  }

  drawStroke(s, dim) {
    const [r, g, b] = s.color;
    const age = s.age;
    const heat = (s.node && typeof s.node.heat === 'number') ? s.node.heat : 0;
    const elapsed = (s.node && typeof s.node.elapsed_ms === 'number') ? s.node.elapsed_ms : 0;
    const stance = s.node && s.node.stance;
    const wetness = 0.7 + heat * 0.65;
    const dryness = Math.min(1, Math.max(0, (elapsed - 1500) / 7500));
    const bleedRadius = Math.min(1, age / 60) * (14 + s.confidence * 10) * wetness;
    let wMult = 1, aMult = 1, tailTaper = 0;
    if (stance === 'claiming') { wMult = 1.18; aMult = 1.05; }
    else if (stance === 'questioning') { tailTaper = 0.5; }
    else if (stance === 'conceding') { wMult = 0.6; aMult = 0.7; tailTaper = 0.7; }
    const subs = [[]];
    for (const p of s.path) { if (p.break) { subs.push([]); continue; } subs[subs.length - 1].push({ ...this.worldPoint(s, p), w: p.w }); }
    if (bleedRadius > 1) {
      this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.05 * dim * aMult})`; this.ctx.lineWidth = bleedRadius * 2; this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
      for (const sub of subs) { if (sub.length < 2) continue; this.ctx.beginPath(); this.ctx.moveTo(sub[0].x, sub[0].y); for (let i = 1; i < sub.length; i++) this.ctx.lineTo(sub[i].x, sub[i].y); this.ctx.stroke(); }
    }
    if (bleedRadius > 0.5) {
      this.ctx.strokeStyle = `rgba(${r},${g},${b},${0.13 * dim * aMult})`; this.ctx.lineWidth = Math.max(4, bleedRadius);
      for (const sub of subs) { if (sub.length < 2) continue; this.ctx.beginPath(); this.ctx.moveTo(sub[0].x, sub[0].y); for (let i = 1; i < sub.length; i++) this.ctx.lineTo(sub[i].x, sub[i].y); this.ctx.stroke(); }
    }
    const sid = (s.node && s.node.id) || 0;
    for (const sub of subs) {
      const len = sub.length;
      for (let i = 1; i < len; i++) {
        const a = sub[i - 1], bb = sub[i];
        if (dryness > 0.15 && this.pseudoRand(sid * 131 + i) < dryness * 0.35) continue;
        const t = i / (len - 1 || 1);
        let envT = 1;
        if (tailTaper > 0 && t > 0.7) envT = 1 - ((t - 0.7) / 0.3) * tailTaper;
        const w = ((a.w + bb.w) / 2) * wMult * envT;
        const alpha = 0.88 * dim * aMult * envT;
        this.ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`; this.ctx.lineWidth = w;
        this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(bb.x, bb.y); this.ctx.stroke();
      }
    }
  }

  // Stronger fibre — paper-grain noise rendered into an offscreen canvas, then
  // masked via destination-in with a radial gradient (transparent centre,
  // opaque corners) so the centre stays clean for strokes. Cached.
  drawCornerFibre() {
    if (!this._fibreOff || this._fibreW !== this.W || this._fibreH !== this.H) {
      if (!this._fibreOff) this._fibreOff = document.createElement('canvas');
      this._fibreOff.width = Math.max(1, Math.ceil(this.W));
      this._fibreOff.height = Math.max(1, Math.ceil(this.H));
      this._fibreW = this.W; this._fibreH = this.H;
      const oc = this._fibreOff.getContext('2d');
      // Build fibre tile once
      if (!this._fibreTile) {
        const tile = document.createElement('canvas');
        tile.width = 64; tile.height = 64;
        const tc = tile.getContext('2d');
        const id = tc.createImageData(64, 64);
        for (let i = 0; i < 64 * 64; i++) {
          const r = Math.random();
          if (r < 0.35) {
            id.data[i * 4 + 0] = 90;
            id.data[i * 4 + 1] = 70;
            id.data[i * 4 + 2] = 45;
            id.data[i * 4 + 3] = 30 + Math.random() * 40;
          } else {
            id.data[i * 4 + 3] = 0;
          }
        }
        tc.putImageData(id, 0, 0);
        this._fibreTile = tile;
      }
      const pat = oc.createPattern(this._fibreTile, 'repeat');
      oc.fillStyle = pat;
      oc.fillRect(0, 0, this.W, this.H);
      // Mask: keep only the corners
      oc.globalCompositeOperation = 'destination-in';
      const mask = oc.createRadialGradient(this.W / 2, this.H / 2, Math.min(this.W, this.H) * 0.20, this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.7);
      mask.addColorStop(0, 'rgba(0,0,0,0)');
      mask.addColorStop(1, 'rgba(0,0,0,1)');
      oc.fillStyle = mask;
      oc.fillRect(0, 0, this.W, this.H);
      oc.globalCompositeOperation = 'source-over';
    }
    this.ctx.drawImage(this._fibreOff, 0, 0);
  }

  drawPaper() {
    this.ctx.fillStyle = '#ffffff'; this.ctx.fillRect(0, 0, this.W, this.H);
    const g = this.ctx.createRadialGradient(this.W / 2, this.H / 2, 0, this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.6);
    g.addColorStop(0, 'rgba(250, 244, 220, 0.6)'); g.addColorStop(1, 'rgba(215, 205, 175, 0.15)');
    this.ctx.fillStyle = g; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawCornerFibre();
    // Tea stain — one warm sepia patch at a random fixed position per session.
    // Aged paper has provenance.
    if (!this._teaStain) {
      const corner = Math.floor(Math.random() * 4);
      const fx = (corner & 1) ? 0.68 + Math.random() * 0.20 : 0.12 + Math.random() * 0.20;
      const fy = (corner & 2) ? 0.68 + Math.random() * 0.20 : 0.12 + Math.random() * 0.20;
      this._teaStain = { fx, fy, fr: 0.18 + Math.random() * 0.10, intensity: 0.18 + Math.random() * 0.08 };
    }
    const t = this._teaStain;
    const cx = t.fx * this.W, cy = t.fy * this.H;
    const r = t.fr * Math.max(this.W, this.H);
    const tg = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    tg.addColorStop(0, `rgba(150, 100, 55, ${t.intensity})`);
    tg.addColorStop(0.5, `rgba(160, 110, 65, ${t.intensity * 0.4})`);
    tg.addColorStop(1, 'rgba(170, 120, 75, 0)');
    this.ctx.fillStyle = tg;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  simulate() { for (const s of this.strokes) { if (s.age < 120) s.age++; } }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: spawn one grey practice stroke per token at a hashed position
  // and rotation. Uses the existing practice-stroke system so they fade normally.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    const types = ['claim', 'branch', 'choice', 'aside', 'resolution'];
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const x = 80 + (h % (this.W - 160));
      const y = 80 + ((h >> 8) % (this.H - 160));
      const type = types[(h >> 12) % types.length];
      const confidence = 0.35 + ((h >> 16) % 30) / 100;
      this.practiceStrokes.push({
        type, x, y,
        rotation: ((Math.abs(h >> 4) % 100) / 100 - 0.5) * 0.5,
        path: this.makePath(type, confidence),
        alpha: 0,
        targetAlpha: 0.18 + ((h >> 20) % 8) / 100,
        age: 0,
        maxAge: 120,
      });
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.addStroke(n);
    this.playInkStroke(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.strokes = [];
    this.practiceStrokes = [];
    this.primePhase = false;
    this.seal = null;
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulate();
    this.simulatePrime();
    this.drawPaper();
    this.drawPractice();
    this.drawWhiskers();
    const ht = this.app.highlightedTopic;
    for (const s of this.strokes) {
      const dim = ht && s.topic !== ht ? 0.15 : 1;
      this.drawStroke(s, dim);
    }
    this.drawExternalChips();
    this.drawPivotHaloes();
    this.drawSeal();
  }
}

export { InkMode };

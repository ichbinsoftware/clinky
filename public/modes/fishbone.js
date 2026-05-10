import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, relColor, relGlyph } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

const RULER_LEN = 340;
const RULER_SPEED = 1.1;
const TICK_PEAK_ALPHA = 0.7;

class FishboneMode extends Mode {
  primePhase = false;
  rulerY = 0;
  rulerDir = 1;
  rulerPause = 0;
  tickCooldown = 0;
  tickMarks = [];
  threadFocus = null;
  topicLock = null;
  effectHover = false;
  topicFirstSeen = new Set();

  constructor() {
    super({
      mode: 'fishbone',
      aesthetic: 'industrial',
      topicFallbackColor: '#b8c0d9',
      vars: {
        '--e-bg': '#0b2545', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#a8884a', '--e-pivot-tint': 'rgba(168,136,74,0.06)', '--e-accent': '#d4a04a',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const mx = e.clientX, my = e.clientY;
      const hit = this.nodeHitTest(mx, my);
      if (hit) { showTooltip(e, hit, this.topicInfo(hit.topic).color); this.app.highlightLegendTopic(hit.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
      const onEffect = this.effectBoxHitTest(mx, my);
      if (onEffect !== this.effectHover) this.effectHover = onEffect;
      let cursor = 'default';
      if (hit) cursor = 'pointer';
      else if (onEffect) cursor = 'pointer';
      else if (this.labelHitTest(mx, my)) cursor = 'pointer';
      else if (this.boneHitTest(mx, my)) cursor = 'pointer';
      this.canvas.style.cursor = cursor;
    });
    this.canvas.addEventListener('mouseleave', () => { this.effectHover = false; });
    this.canvas.addEventListener('click', e => {
      const mx = e.clientX, my = e.clientY;
      if (this.primePhase) { this.tickMarks.push({ x: mx, y: my, age: 0, alpha: 0, fadingOut: false, user: true }); return; }
      const nodeHit = this.nodeHitTest(mx, my);
      if (nodeHit) { this.threadFocus = (this.threadFocus === nodeHit) ? null : nodeHit; this.topicLock = null; return; }
      const labelTopic = this.labelHitTest(mx, my);
      if (labelTopic) { this.topicLock = (this.topicLock === labelTopic) ? null : labelTopic; this.threadFocus = null; return; }
      const boneTopic = this.boneHitTest(mx, my);
      if (boneTopic) { this.topicLock = (this.topicLock === boneTopic) ? null : boneTopic; this.threadFocus = null; return; }
      this.threadFocus = null; this.topicLock = null;
    });
  }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.nodes);
  }

  hasExternalBecause(n) {
    const b = n && n.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  nodeById(id) { for (const n of this.nodes) if (n.id === id) return n; return null; }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('industrial');
      pickSessionKey(this.app.prompt() || 'fishbone');
    });
  }

  drumKick() {
    const root = getSessionKey().rootMidi;
    playSynth({ midi: root - 24, wave: 'sawtooth', voices: 3, detune: 18, attack: 0.001, decay: 0.10, sustain: 0.0, release: 0.06, duration: 0.08, vol: 0.20, filter: { type: 'lowpass', freq: 220, Q: 4 }, distortion: { drive: 0.55, tone: 'crunch', mix: 0.65 }, reverbSend: 0.30, delaySend: 0.22 });
  }

  drumSnare() {
    playSynth({ freq: 900, wave: 'sawtooth', voices: 5, detune: 60, attack: 0.001, decay: 0.06, sustain: 0.0, release: 0.10, duration: 0.05, vol: 0.10, filter: { type: 'bandpass', freq: 900, Q: 5 }, distortion: { drive: 0.4, tone: 'crunch', mix: 0.4 }, reverbSend: 0.55, delaySend: 0.45 });
  }

  drumHat() {
    playSynth({ freq: 4500, wave: 'sawtooth', voices: 5, detune: 80, attack: 0.001, decay: 0.025, sustain: 0.0, release: 0.04, duration: 0.03, vol: 0.06, filter: { type: 'bandpass', freq: 4500, Q: 8 }, distortion: { drive: 0.3, tone: 'crunch', mix: 0.4 }, reverbSend: 0.40, delaySend: 0.50 });
  }

  playInvestigativeHit(node) {
    const isPivot = this.nodeIncoming(node.id) >= 3;
    const isNewTopic = !this.topicFirstSeen.has(node.topic);
    if (isNewTopic) this.topicFirstSeen.add(node.topic);
    if (isPivot) this.drumKick();
    else if (isNewTopic) this.drumSnare();
    else this.drumHat();
  }

  sideBuffer() {
    const el = document.querySelector('.topic-legend');
    if (!el) return 40;
    const rect = el.getBoundingClientRect();
    return Math.max(40, window.innerWidth - rect.left + 12);
  }

  pointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  computeLayout() {
    const headY = this.H / 2;
    const spineL = Math.max(100, this.sideBuffer()), spineR = this.W - Math.max(260, this.sideBuffer() + 200);
    const n = this.topics.length;
    const positions = new Map(), bones = new Map();
    this.topics.forEach((t, i) => {
      const above = i % 2 === 0;
      const pairIdx = Math.floor(i / 2), pairCount = Math.ceil(n / 2);
      const frac = pairCount > 0 ? (pairIdx + 0.5) / pairCount : 0.5;
      const sx = spineL + (spineR - spineL) * (0.1 + frac * 0.85);
      const boneLen = Math.min(220, (this.H - 120) / 2.3);
      const ang = above ? -1.1 : 1.1;
      const ex = sx - boneLen * Math.cos(ang), ey = headY + boneLen * Math.sin(ang);
      bones.set(t.id, { sx, sy: headY, ex, ey, above, ang });
    });
    const byTopic = new Map();
    for (const nd of this.nodes) { if (!byTopic.has(nd.topic)) byTopic.set(nd.topic, []); byTopic.get(nd.topic).push(nd); }
    for (const [tid, arr] of byTopic) {
      const b = bones.get(tid); if (!b) continue;
      arr.forEach((nd, i) => {
        const frac = 0.15 + (i / Math.max(arr.length, 1)) * 0.8;
        const px = b.sx + (b.ex - b.sx) * frac, py = b.sy + (b.ey - b.sy) * frac;
        const subLen = 90;
        positions.set(nd, { px, py, tx: px + Math.cos(b.above ? b.ang - Math.PI * 0.45 : -b.ang + Math.PI * 0.55) * subLen, ty: py + Math.sin(b.above ? b.ang - Math.PI * 0.45 : -b.ang + Math.PI * 0.55) * subLen });
      });
    }
    return { headY, spineL, spineR, bones, positions };
  }

  nodeHitTest(mx, my) {
    const { positions } = this.computeLayout();
    for (const node of this.nodes) { const p = positions.get(node); if (!p) continue; if (Math.hypot(p.tx - mx, p.ty - my) < 14) return node; }
    return null;
  }

  boneHitTest(mx, my) {
    const { bones } = this.computeLayout();
    for (const t of this.topics) { const b = bones.get(t.id); if (!b) continue; if (this.pointToSegment(mx, my, b.sx, b.sy, b.ex, b.ey) < 10) return t.id; }
    return null;
  }

  labelHitTest(mx, my) {
    const { bones } = this.computeLayout();
    this.ctx.font = "700 11px 'JetBrains Mono', monospace";
    for (const t of this.topics) {
      const b = bones.get(t.id); if (!b) continue;
      const labelText = t.label.toUpperCase();
      const w = this.ctx.measureText(labelText).width;
      const lx = b.ex - 12, ly = b.ey + (b.above ? -6 : 6);
      const PAD = 8;
      if (mx >= lx - PAD && mx <= lx + w + PAD && my >= ly - 14 && my <= ly + 14) return t.id;
    }
    return null;
  }

  effectBoxHitTest(mx, my) {
    const { headY, spineR } = this.computeLayout();
    return mx >= spineR && mx <= spineR + 180 && my >= headY - 36 && my <= headY + 36;
  }

  getThreadSet() {
    if (!this.threadFocus) return null;
    const ancestors = new Set(), descendants = new Set();
    const byId = new Map();
    for (const n of this.nodes) if (n.id != null) byId.set(n.id, n);
    for (const refId of (this.threadFocus.refs || [])) { const target = byId.get(refId); if (target) ancestors.add(target); }
    for (const other of this.nodes) { if (other.refs && other.refs.includes(this.threadFocus.id)) descendants.add(other); }
    return { ancestors, descendants };
  }

  getNodeDim(node) {
    if (this.threadFocus) { const set = this.getThreadSet(); if (node === this.threadFocus) return 1; if (set.ancestors.has(node) || set.descendants.has(node)) return 1; return 0.2; }
    if (this.topicLock) return node.topic === this.topicLock ? 1 : 0.22;
    return 1;
  }

  getBoneDim(topicId) {
    if (this.threadFocus) { const set = this.getThreadSet(); const activeNodes = new Set([this.threadFocus, ...set.ancestors, ...set.descendants]); for (const n of activeNodes) if (n.topic === topicId) return 1; return 0.24; }
    if (this.topicLock) return topicId === this.topicLock ? 1 : 0.24;
    return 1;
  }

  startPrime() { this.primePhase = true; this.rulerY = 100; this.rulerDir = 1; this.rulerPause = 0; this.tickCooldown = 40; this.tickMarks = []; }
  stopPrime() { this.primePhase = false; for (const t of this.tickMarks) t.fadingOut = true; }

  simulatePrime() {
    const marginY = 80;
    if (this.primePhase) {
      if (this.rulerPause > 0) { this.rulerPause--; }
      else {
        this.rulerY += RULER_SPEED * this.rulerDir;
        if (this.rulerY >= this.H - marginY) { this.rulerY = this.H - marginY; this.rulerDir = -1; }
        if (this.rulerY <= marginY) { this.rulerY = marginY; this.rulerDir = 1; }
        this.tickCooldown--;
        if (this.tickCooldown <= 0) {
          const cx = this.W / 2, endSide = Math.random() < 0.5 ? -1 : 1;
          this.tickMarks.push({ x: cx + endSide * RULER_LEN / 2, y: this.rulerY, age: 0, alpha: 0, fadingOut: false });
          this.tickCooldown = 55 + Math.floor(Math.random() * 70); this.rulerPause = 14;
        }
      }
    }
    for (let i = this.tickMarks.length - 1; i >= 0; i--) {
      const t = this.tickMarks[i]; t.age++;
      if (t.fadingOut) t.alpha -= 0.025;
      else if (t.age < 8) t.alpha = (t.age / 8) * TICK_PEAK_ALPHA;
      else if (t.age > 260) t.alpha = Math.max(0, TICK_PEAK_ALPHA - (t.age - 260) / 40 * TICK_PEAK_ALPHA);
      else t.alpha = TICK_PEAK_ALPHA;
      if (t.alpha <= 0 && t.age > 10) this.tickMarks.splice(i, 1);
    }
  }

  drawRuler() {
    if (this.primePhase) {
      const cx = this.W / 2, left = cx - RULER_LEN / 2, right = cx + RULER_LEN / 2;
      this.ctx.strokeStyle = 'rgba(227, 137, 94, 0.52)'; this.ctx.lineWidth = 1.2;
      this.ctx.beginPath(); this.ctx.moveTo(left, this.rulerY); this.ctx.lineTo(right, this.rulerY); this.ctx.stroke();
      this.ctx.beginPath(); this.ctx.moveTo(left, this.rulerY - 9); this.ctx.lineTo(left, this.rulerY + 9); this.ctx.stroke();
      this.ctx.strokeStyle = 'rgba(227, 137, 94, 0.28)'; this.ctx.lineWidth = 0.5;
      for (let x = left + 20; x < right; x += 20) {
        const hIsLong = Math.round((x - left) / 20) % 2 === 0;
        this.ctx.beginPath(); this.ctx.moveTo(x, this.rulerY - (hIsLong ? 3 : 2)); this.ctx.lineTo(x, this.rulerY + (hIsLong ? 3 : 2)); this.ctx.stroke();
      }
    }
    for (const t of this.tickMarks) {
      if (t.alpha < 0.02) continue;
      this.ctx.strokeStyle = `rgba(227, 137, 94, ${t.alpha})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      if (t.user) { this.ctx.moveTo(t.x - 6, t.y - 6); this.ctx.lineTo(t.x + 6, t.y + 6); this.ctx.moveTo(t.x + 6, t.y - 6); this.ctx.lineTo(t.x - 6, t.y + 6); }
      else { this.ctx.moveTo(t.x - 6, t.y); this.ctx.lineTo(t.x + 6, t.y); this.ctx.moveTo(t.x, t.y - 6); this.ctx.lineTo(t.x, t.y + 6); }
      this.ctx.stroke();
    }
  }

  drawAllRefsArcs(positions) {
    const headY = this.H / 2;
    const focusSet = this.threadFocus ? this.getThreadSet() : null;
    for (const src of this.nodes) {
      if (!Array.isArray(src.refs) || !src.refs.length) continue;
      const sp = positions.get(src); if (!sp) continue;
      for (const tid of src.refs) {
        const tgt = this.nodeById(tid); if (!tgt) continue;
        const tp = positions.get(tgt); if (!tp) continue;
        let alpha = this.threadFocus ? 0.08 : 0.14, lineW = 1;
        if (this.threadFocus) {
          const focused = (src === this.threadFocus && (focusSet.ancestors.has(tgt) || tgt === this.threadFocus)) || (tgt === this.threadFocus && (focusSet.descendants.has(src) || src === this.threadFocus));
          if (focused) { alpha = 0.85; lineW = 1.6; }
        }
        const rel = src.rel;
        this.ctx.strokeStyle = relColor(rel); this.ctx.globalAlpha = alpha; this.ctx.lineWidth = lineW;
        if (rel === 'questions') this.ctx.setLineDash([4, 4]);
        else if (rel === 'supersedes') this.ctx.setLineDash([2, 6]);
        else if (rel === 'refines') this.ctx.setLineDash([1, 3]);
        else this.ctx.setLineDash([]);
        const midX = (sp.tx + tp.tx) / 2, midY = (sp.ty + tp.ty) / 2;
        let pushAway;
        if (rel === 'contradicts') { const srcAbove = sp.ty < headY, tgtAbove = tp.ty < headY; pushAway = (srcAbove === tgtAbove) ? (srcAbove ? 80 : -80) : 0; }
        else pushAway = midY < headY ? -40 : 40;
        this.ctx.beginPath(); this.ctx.moveTo(sp.tx, sp.ty); this.ctx.quadraticCurveTo(midX, midY + pushAway, tp.tx, tp.ty); this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }
    this.ctx.globalAlpha = 1; this.ctx.setLineDash([]);
  }

  drawThreadLines(positions) {
    if (!this.threadFocus) return;
    const set = this.getThreadSet(), focusPos = positions.get(this.threadFocus);
    if (!focusPos) return;
    this.ctx.setLineDash([4, 4]); this.ctx.lineWidth = 1.8;
    const headY = this.H / 2;
    const drawArc = (x1, y1, x2, y2, rel) => {
      this.ctx.strokeStyle = relColor(rel);
      const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2, pushAway = ((midY < headY) ? -40 : 40);
      this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.quadraticCurveTo(midX, midY + pushAway, x2, y2); this.ctx.stroke();
    };
    for (const anc of set.ancestors) { const ap = positions.get(anc); if (!ap) continue; drawArc(ap.tx, ap.ty, focusPos.tx, focusPos.ty, this.threadFocus.rel); }
    for (const des of set.descendants) { const dp = positions.get(des); if (!dp) continue; drawArc(focusPos.tx, focusPos.ty, dp.tx, dp.ty, des.rel); }
    this.ctx.setLineDash([]);
  }

  drawEnvironmentalArrows(positions) {
    const margin = 18, W = this.W, H = this.H;
    for (const node of this.nodes) {
      if (!this.hasExternalBecause(node)) continue;
      const p = positions.get(node); if (!p) continue;
      const tx = p.tx, ty = p.ty;
      const dL = tx, dR = W - tx, dT = ty, dB = H - ty;
      const minD = Math.min(dL, dR, dT, dB);
      let sx, sy;
      if (minD === dL) { sx = margin; sy = ty; } else if (minD === dR) { sx = W - margin; sy = ty; }
      else if (minD === dT) { sx = tx; sy = margin; } else { sx = tx; sy = H - margin; }
      const dx = tx - sx, dy = ty - sy, d = Math.hypot(dx, dy) || 1;
      const ex = tx - (dx / d) * 24, ey = ty - (dy / d) * 24;
      const info = this.topicInfo(node.topic);
      this.ctx.strokeStyle = info.color; this.ctx.globalAlpha = 0.65; this.ctx.lineWidth = 1.4; this.ctx.setLineDash([5, 3]);
      this.ctx.beginPath(); this.ctx.moveTo(sx, sy); this.ctx.lineTo(ex, ey); this.ctx.stroke(); this.ctx.setLineDash([]);
      const ang = Math.atan2(dy, dx), headSize = 7;
      this.ctx.fillStyle = info.color; this.ctx.globalAlpha = 0.85;
      this.ctx.beginPath(); this.ctx.moveTo(ex, ey); this.ctx.lineTo(ex - Math.cos(ang - 0.4) * headSize, ey - Math.sin(ang - 0.4) * headSize); this.ctx.lineTo(ex - Math.cos(ang + 0.4) * headSize, ey - Math.sin(ang + 0.4) * headSize); this.ctx.closePath(); this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  drawEffectCallout() {
    if (!this.effectHover) return;
    const prompt = this.app.prompt(); if (!prompt) return;
    const { headY, spineR } = this.computeLayout();
    const hb = { x: spineR, y: headY - 36, w: 180, h: 72 };
    const text = prompt.length > 90 ? prompt.slice(0, 87) + '…' : prompt;
    this.ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    const m = this.ctx.measureText(text);
    const padX = 14, w = Math.min(360, Math.max(220, m.width + padX * 2)), h = 58;
    const x = hb.x - w - 20, y = hb.y - 2;
    this.ctx.fillStyle = 'rgba(10, 10, 10, 0.94)'; this.ctx.fillRect(x, y, w, h);
    this.ctx.strokeStyle = 'rgba(10, 10, 10, 0.94)'; this.ctx.lineWidth = 2;
    this.ctx.beginPath(); this.ctx.moveTo(x + w, y + h / 2); this.ctx.lineTo(hb.x, hb.y + hb.h / 2); this.ctx.stroke();
    this.ctx.fillStyle = '#f5f1e8'; this.ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'top';
    const textWidth = w - padX * 2, words = text.split(' ');
    let line1 = '', line2 = '';
    for (const word of words) {
      const trial = line1 ? line1 + ' ' + word : word;
      if (this.ctx.measureText(trial).width <= textWidth) line1 = trial;
      else line2 = line2 ? line2 + ' ' + word : word;
    }
    if (line2 && this.ctx.measureText(line2).width > textWidth) {
      while (line2.length > 3 && this.ctx.measureText(line2 + '…').width > textWidth) line2 = line2.slice(0, -1);
      line2 = line2 + '…';
    }
    this.ctx.fillText(line1, x + padX, y + 8);
    if (line2) this.ctx.fillText(line2, x + padX, y + 22);
    this.ctx.fillStyle = 'rgba(245, 241, 232, 0.58)'; this.ctx.font = "500 9.5px 'JetBrains Mono', monospace";
    this.ctx.fillText(`${this.nodes.length} causes · ${this.topics.length} bones`, x + padX, y + h - 14);
  }

  trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: drop one tick mark per token at a hashed position along
  // the ruler, giving the empty fishbone a sense of the prompt's scale.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const cx = this.W / 2;
      const xOff = (h % Math.round(RULER_LEN)) - RULER_LEN / 2;
      const x = cx + xOff;
      const y = this.H * (0.2 + ((h >> 8) % 600) / 1000);
      this.tickMarks.push({ x, y, age: 0, alpha: 0, fadingOut: false });
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    this.playInvestigativeHit(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.tickMarks = [];
    this.rulerY = 100; this.rulerDir = 1; this.rulerPause = 0; this.tickCooldown = 0;
    this.threadFocus = null; this.topicLock = null; this.effectHover = false;
    this.topicFirstSeen.clear();
    if (this.primePhase) this.stopPrime();
    this.primePhase = false;
  }

  draw() {
    if (this.app.isPaused()) return;
    this.ctx.fillStyle = '#0b2545'; this.ctx.fillRect(0, 0, this.W, this.H);
    // Drafting lamp — warm radial light from just past the upper-left corner.
    const lamp = this.ctx.createRadialGradient(this.W * -0.05, this.H * -0.05, 0, this.W * -0.05, this.H * -0.05, Math.max(this.W, this.H) * 0.85);
    lamp.addColorStop(0, 'rgba(255, 220, 140, 0.20)');
    lamp.addColorStop(0.5, 'rgba(255, 220, 140, 0.06)');
    lamp.addColorStop(1, 'rgba(255, 220, 140, 0)');
    this.ctx.fillStyle = lamp;
    this.ctx.fillRect(0, 0, this.W, this.H);
    this.ctx.strokeStyle = 'rgba(255,255,255,0.04)'; this.ctx.lineWidth = 0.5;
    for (let x = 0; x < this.W; x += 40) { this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, this.H); this.ctx.stroke(); }
    for (let y = 0; y < this.H; y += 40) { this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(this.W, y); this.ctx.stroke(); }
    this.simulatePrime();
    this.drawRuler();
    const { headY, spineL, spineR, bones, positions } = this.computeLayout();
    const ht = this.app.highlightedTopic;
    this.ctx.strokeStyle = '#e0e1dd'; this.ctx.lineWidth = 3;
    this.ctx.beginPath(); this.ctx.moveTo(spineL, headY); this.ctx.lineTo(spineR, headY); this.ctx.stroke();
    const hb = { x: spineR, y: headY - 36, w: 180, h: 72 };
    this.ctx.fillStyle = '#e0e1dd'; this.ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
    this.ctx.fillStyle = '#0b2545'; this.ctx.font = "700 12px 'Space Grotesk', sans-serif"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
    this.ctx.fillText('EFFECT', hb.x + hb.w / 2, hb.y + 22);
    this.ctx.font = "500 9px 'JetBrains Mono', monospace"; this.ctx.fillText('the prompt', hb.x + hb.w / 2, hb.y + 40);
    this.ctx.fillStyle = '#1d4e89'; this.ctx.font = "500 9px 'JetBrains Mono', monospace"; this.ctx.fillText('(root answer)', hb.x + hb.w / 2, hb.y + 56);
    this.ctx.fillStyle = '#e0e1dd';
    this.ctx.beginPath(); this.ctx.moveTo(spineR, headY - 8); this.ctx.lineTo(hb.x, headY); this.ctx.lineTo(spineR, headY + 8); this.ctx.closePath(); this.ctx.fill();
    for (const t of this.topics) {
      const b = bones.get(t.id); if (!b) continue;
      const htDim = ht && ht !== t.id ? 0.3 : 1;
      const dim = Math.min(htDim, this.getBoneDim(t.id));
      this.ctx.globalAlpha = dim;
      this.ctx.strokeStyle = t.color; this.ctx.lineWidth = 2;
      this.ctx.beginPath(); this.ctx.moveTo(b.sx, b.sy); this.ctx.lineTo(b.ex, b.ey); this.ctx.stroke();
      this.ctx.fillStyle = t.color; this.ctx.font = "700 11px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'left'; this.ctx.textBaseline = b.above ? 'bottom' : 'top';
      this.ctx.fillText(t.label.toUpperCase(), b.ex - 12, b.ey + (b.above ? -6 : 6));
      if (this.topicLock === t.id) { const w = this.ctx.measureText(t.label.toUpperCase()).width; const underlineY = b.ey + (b.above ? -4 : 20); this.ctx.fillRect(b.ex - 12, underlineY, w, 1.5); }
    }
    this.ctx.globalAlpha = 1;
    this.drawAllRefsArcs(positions);
    this.drawThreadLines(positions);
    this.drawEnvironmentalArrows(positions);
    for (const node of this.nodes) {
      const p = positions.get(node); if (!p) continue;
      const info = this.topicInfo(node.topic);
      const htDim = ht && ht !== node.topic ? 0.25 : 1;
      const dim = Math.min(htDim, this.getNodeDim(node));
      this.ctx.globalAlpha = dim;
      const [r, g, b] = hexToRgb(info.color);
      const heat = typeof node.heat === 'number' ? node.heat : 0;
      const heatMult = 0.85 + heat * 0.7;
      this.ctx.strokeStyle = `rgba(${r},${g},${b},0.75)`; this.ctx.lineWidth = 1.2 * heatMult;
      const stance = node.stance;
      if (stance === 'exploring') this.ctx.setLineDash([1, 3]);
      else if (stance === 'questioning') this.ctx.setLineDash([4, 4]);
      else this.ctx.setLineDash([]);
      if (stance === 'conceding') {
        const dx = p.tx - p.px, dy = p.ty - p.py;
        this.ctx.beginPath(); this.ctx.moveTo(p.px, p.py); this.ctx.lineTo(p.px + dx * 0.42, p.py + dy * 0.42); this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.moveTo(p.px + dx * 0.58, p.py + dy * 0.58); this.ctx.lineTo(p.tx, p.ty); this.ctx.stroke();
      } else { this.ctx.beginPath(); this.ctx.moveTo(p.px, p.py); this.ctx.lineTo(p.tx, p.ty); this.ctx.stroke(); }
      this.ctx.setLineDash([]);
      const baseRad = 3 + (node.confidence || 0.7) * 2;
      const rad = this.threadFocus === node ? baseRad + 3 : baseRad;
      this.ctx.fillStyle = info.color; this.ctx.beginPath(); this.ctx.arc(p.tx, p.ty, rad, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.font = "500 10px 'Space Grotesk', sans-serif"; this.ctx.fillStyle = '#e0e1dd';
      this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
      this.ctx.fillText(this.trunc(node.text, 36), p.tx + 8, p.ty);
      if (node.type === 'resolution') { this.ctx.strokeStyle = info.color; this.ctx.lineWidth = 1; this.ctx.beginPath(); this.ctx.arc(p.tx, p.ty, 8, 0, Math.PI * 2); this.ctx.stroke(); }
      if (this.threadFocus === node) { this.ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`; this.ctx.lineWidth = 1.5; this.ctx.beginPath(); this.ctx.arc(p.tx, p.ty, rad + 5, 0, Math.PI * 2); this.ctx.stroke(); }
      const inbound = this.nodeIncoming(node.id);
      if (inbound >= 3) {
        const badgeR = rad + 6, bx = p.tx - badgeR - 2, by = p.ty - badgeR - 2;
        this.ctx.fillStyle = `rgba(${r},${g},${b},0.95)`; this.ctx.beginPath(); this.ctx.arc(bx, by, 8, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.strokeStyle = '#0b2545'; this.ctx.lineWidth = 1.4; this.ctx.beginPath(); this.ctx.arc(bx, by, 8, 0, Math.PI * 2); this.ctx.stroke();
        this.ctx.fillStyle = '#0b2545'; this.ctx.font = "700 10px 'JetBrains Mono', monospace"; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
        this.ctx.fillText(String(Math.min(inbound, 9)), bx, by + 0.5);
      }
    }
    this.ctx.globalAlpha = 1;
    this.drawEffectCallout();
  }
}

export { FishboneMode };

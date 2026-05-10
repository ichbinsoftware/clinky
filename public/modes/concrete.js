import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey, quantizeToKey, configureReverb } from '/synth.js';

const PHONEMES = {
  a: { f1: 730,  f2: 1090, cls: 'vowel' }, e: { f1: 530,  f2: 1840, cls: 'vowel' },
  i: { f1: 270,  f2: 2290, cls: 'vowel' }, o: { f1: 570,  f2: 840,  cls: 'vowel' },
  u: { f1: 300,  f2: 870,  cls: 'vowel' }, y: { f1: 300,  f2: 1800, cls: 'vowel' },
  s: { f1: 4500, f2: 6500, cls: 'sibilant' }, z: { f1: 4500, f2: 6500, cls: 'sibilant-voiced' },
  f: { f1: 1800, f2: 3500, cls: 'fricative' }, v: { f1: 1800, f2: 3500, cls: 'fricative-voiced' },
  h: { f1: 2000, f2: 3000, cls: 'breath' },
  t: { f1: 1800, f2: 2800, cls: 'plosive' }, d: { f1: 1800, f2: 2800, cls: 'plosive-voiced' },
  p: { f1: 600,  f2: 1200, cls: 'plosive' }, b: { f1: 600,  f2: 1200, cls: 'plosive-voiced' },
  k: { f1: 1500, f2: 2400, cls: 'plosive' }, g: { f1: 1500, f2: 2400, cls: 'plosive-voiced' },
  q: { f1: 1500, f2: 2400, cls: 'plosive' }, c: { f1: 1500, f2: 2400, cls: 'plosive' },
  x: { f1: 1500, f2: 2400, cls: 'plosive' },
  m: { f1: 280,  f2: 1100, cls: 'nasal' }, n: { f1: 280,  f2: 1700, cls: 'nasal' },
  l: { f1: 400,  f2: 1200, cls: 'liquid' }, r: { f1: 450,  f2: 1200, cls: 'liquid' },
  w: { f1: 300,  f2: 900,  cls: 'glide' },  j: { f1: 270,  f2: 2200, cls: 'glide' },
};

const SHAPES = {
  claim: 'circle', branch: 'fork', choice: 'spiral',
  'dead-end': 'collapse', aside: 'scatter', resolution: 'square',
};

class ConcreteMode extends Mode {
  typeBlocks = [];
  primePhase = false;
  letters = [];
  clusterTimer = 0;
  clusterTarget = null;
  magnets = [];
  dragState = null;

  static LETTER_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZαβγδεζηθικλμνξπρστυφχψω0123456789';

  constructor() {
    super({
      mode: 'concrete',
      aesthetic: 'classical',
      topicFallbackColor: '#0a0a0a',
      vars: {
        '--e-bg': '#ffffff', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(26,18,8,0.05)', '--e-accent': '#1a1208',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.dragState) {
        const dx = mx - this.dragState.startX, dy = my - this.dragState.startY;
        if (!this.dragState.started && Math.hypot(dx, dy) > 5) {
          this.dragState.started = true;
          this.canvas.style.cursor = 'grabbing';
        }
        if (this.dragState.started) {
          this.dragState.block.x = mx - this.dragState.offsetX;
          this.dragState.block.y = my - this.dragState.offsetY;
          return;
        }
      }
      const hit = this.blockAtPoint(mx, my);
      this.canvas.style.cursor = hit ? 'grab' : 'crosshair';
      if (hit) { showTooltip(e, hit.node, hit.color); this.app.highlightLegendTopic(hit.node.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('mousedown', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const hit = this.blockAtPoint(mx, my);
      if (hit) this.dragState = { block: hit, startX: mx, startY: my, offsetX: mx - hit.x, offsetY: my - hit.y, started: false };
    });
    this.canvas.addEventListener('mouseup', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (this.dragState) {
        const wasDrag = this.dragState.started;
        const block = this.dragState.block;
        this.dragState = null;
        this.canvas.style.cursor = 'crosshair';
        if (!wasDrag) { this.wobbleBlock(block); this.playConcreteUtterance(block.node); }
        return;
      }
      if (this.primePhase) {
        if (this.clusterTarget && !this.clusterTarget.pinned) {
          const d = Math.hypot(this.clusterTarget.cx - mx, this.clusterTarget.cy - my);
          if (d < 80) { this.clusterTarget.pinned = true; return; }
        }
        this.magnets.push({ x: mx, y: my, life: 120, maxLife: 120 });
      }
    });
    this.canvas.addEventListener('mouseleave', () => {
      if (this.dragState && !this.dragState.started) this.dragState = null;
      this.canvas.style.cursor = 'crosshair';
    });
  }

  count() { return this.typeBlocks.length; }
  legendItems() { return this.typeBlocks; }

  blockIncoming(b) {
    const id = b.node && b.node.id;
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.typeBlocks.map(x => x.node).filter(Boolean));
  }

  pivotScaleFor(b) {
    const inbound = this.blockIncoming(b);
    if (inbound < 3) return 1;
    return 1 + Math.min(0.55, (inbound - 2) * 0.15);
  }

  hasExternalBecause(b) {
    const x = b.node && b.node.because;
    return Array.isArray(x) && x.some(v => typeof v === 'string');
  }

  sessionHasRefs() {
    for (const b of this.typeBlocks) {
      const r = b.node && b.node.refs;
      if (Array.isArray(r) && r.length > 0) return true;
    }
    return false;
  }

  blockById(id) {
    for (const b of this.typeBlocks) if (b.node && b.node.id === id) return b;
    return null;
  }

  relTypoGlyph(rel) {
    switch (rel) {
      case 'supports': return '—'; case 'contradicts': return '≠';
      case 'synthesizes': return '+'; case 'refines': return '~';
      case 'questions': return '?'; case 'supersedes': return '»';
      default: return '·';
    }
  }

  interleaveQuestions(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) { out += s[i]; if (i < s.length - 1) out += '?'; }
    return out;
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('classical');
      pickSessionKey(this.app.prompt() || 'concrete');
      configureReverb({ duration: 3.5, decay: 2.4, wet: 0.55 });
    });
  }

  playPhoneme(ch, midi, heat, gain) {
    if (ch === '?') {
      playSynth({ midi: midi + 7, wave: 'triangle', attack: 0.005, decay: 0.05, sustain: 0.1, release: 0.08, duration: 0.04, vol: 0.04 * gain, reverbSend: 0.3 });
      return;
    }
    const p = PHONEMES[ch.toLowerCase()];
    if (!p) return;
    const bright = 1 + heat * 0.25;
    if (p.cls === 'vowel') {
      [p.f1, p.f2].forEach((freq, bandIdx) => {
        playSynth({ midi, wave: 'triangle', voices: 2, detune: 8, attack: 0.015, decay: 0.06, sustain: 0.7, release: 0.1, duration: 0.1, vol: (bandIdx === 0 ? 0.05 : 0.035) * gain, filter: { type: 'bandpass', freq: freq * bright, Q: 5 }, reverbSend: 0.35, delaySend: 0.08 });
      });
      return;
    }
    if (p.cls === 'nasal' || p.cls === 'liquid' || p.cls === 'glide') {
      playSynth({ midi, wave: 'triangle', voices: 2, detune: 6, attack: 0.02, decay: 0.05, sustain: 0.6, release: 0.12, duration: 0.1, vol: 0.05 * gain, filter: { type: 'bandpass', freq: p.f2 * bright, Q: 4 }, reverbSend: 0.32, delaySend: 0.08 });
      return;
    }
    if (p.cls === 'sibilant' || p.cls === 'sibilant-voiced') {
      playSynth({ freq: 220, wave: 'sawtooth', voices: 4, detune: 110, attack: 0.003, decay: 0.03, sustain: 0.3, release: 0.05, duration: 0.06, vol: 0.045 * gain, filter: { type: 'bandpass', freq: p.f1 * bright, Q: 6 }, reverbSend: 0.22 });
      return;
    }
    if (p.cls === 'fricative' || p.cls === 'fricative-voiced' || p.cls === 'breath') {
      playSynth({ freq: 180, wave: 'sawtooth', voices: 3, detune: 80, attack: 0.005, decay: 0.04, sustain: 0.3, release: 0.06, duration: 0.06, vol: 0.04 * gain, filter: { type: 'bandpass', freq: p.f1 * bright, Q: 5 }, reverbSend: 0.26 });
      return;
    }
    if (p.cls === 'plosive' || p.cls === 'plosive-voiced') {
      const voiced = p.cls === 'plosive-voiced';
      playSynth({ freq: voiced ? 200 : 280, wave: 'sawtooth', voices: 2, detune: 60, attack: 0.002, decay: 0.015, sustain: 0.1, release: 0.03, duration: 0.02, vol: 0.05 * gain, filter: { type: 'bandpass', freq: p.f2 * bright, Q: 8 }, reverbSend: 0.18 });
    }
  }

  playConcreteUtterance(node) {
    if (!node || !node.text) return;
    const info = this.topicInfo(node.topic);
    const rawFreq = info.note || 440;
    const rawMidi = Math.round(69 + 12 * Math.log2(rawFreq / 440));
    const midi = quantizeToKey(rawMidi);
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const conf = typeof node.confidence === 'number' ? node.confidence : 0.7;
    const stance = node.stance;
    let stepMs = 80, gain = 0.85 + conf * 0.3;
    if (stance === 'claiming') { stepMs = 65; gain *= 1.1; }
    else if (stance === 'conceding') { stepMs = 110; gain *= 0.65; }
    const text = (stance === 'questioning' ? this.interleaveQuestions(node.text) : node.text).slice(0, 16);
    let cursor = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === ' ') { cursor += stepMs * 1.2; continue; }
      setTimeout(() => this.playPhoneme(ch, midi, heat, gain), cursor);
      cursor += stepMs;
    }
  }

  spawnLetter(seededFrom) {
    const edge = Math.floor(Math.random() * 4);
    let x, y;
    if (seededFrom) { x = seededFrom.x; y = seededFrom.y; }
    else if (edge === 0) { x = Math.random() * this.W; y = -10; }
    else if (edge === 1) { x = this.W + 10; y = Math.random() * this.H; }
    else if (edge === 2) { x = Math.random() * this.W; y = this.H + 10; }
    else { x = -10; y = Math.random() * this.H; }
    this.letters.push({ ch: ConcreteMode.LETTER_POOL[Math.floor(Math.random() * ConcreteMode.LETTER_POOL.length)], x, y, vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6, size: 11 + Math.random() * 9, rot: (Math.random() - 0.5) * 0.6, rotV: (Math.random() - 0.5) * 0.01, alpha: 0, targetAlpha: 0.5 + Math.random() * 0.25, targetX: null, targetY: null });
  }

  startPrime() {
    this.primePhase = true;
    this.letters = [];
    this.clusterTimer = 80;
    this.clusterTarget = null;
    for (let i = 0; i < 14; i++) {
      this.spawnLetter();
      this.letters[this.letters.length - 1].x = this.W * (0.1 + Math.random() * 0.8);
      this.letters[this.letters.length - 1].y = this.H * (0.1 + Math.random() * 0.8);
    }
  }

  stopPrime() {
    this.primePhase = false;
    this.clusterTarget = null;
    for (const L of this.letters) L.targetAlpha = 0;
  }

  startCluster() {
    if (this.letters.length < 8) return;
    const margin = 140;
    const cx = margin + Math.random() * (this.W - margin * 2);
    const cy = margin + Math.random() * (this.H - margin * 2);
    const shapes = ['circle', 'fork', 'spiral', 'scatter'];
    const shape = shapes[Math.floor(Math.random() * shapes.length)];
    const count = 6 + Math.floor(Math.random() * 5);
    const ranked = this.letters.map(L => ({ L, d: Math.hypot(L.x - cx, L.y - cy) })).sort((a, b) => a.d - b.d).slice(0, count).map(r => r.L);
    ranked.forEach((L, i) => {
      let tx, ty;
      if (shape === 'circle') { const ang = (i / count) * Math.PI - Math.PI / 2; const r = 38 + Math.random() * 10; tx = cx + Math.cos(ang) * r; ty = cy + Math.sin(ang) * r; }
      else if (shape === 'fork') { const half = Math.floor(count / 2); const branch = i < half ? -1 : 1; const t = i < half ? (half - i) : (i - half); tx = cx + branch * t * 10; ty = cy + t * 10; }
      else if (shape === 'spiral') { const ang = i * 0.5; const r = 10 + i * 5; tx = cx + Math.cos(ang) * r; ty = cy + Math.sin(ang) * r; }
      else { tx = cx + (Math.random() - 0.5) * 70; ty = cy + (Math.random() - 0.5) * 70; }
      L.targetX = tx; L.targetY = ty;
    });
    this.clusterTarget = { cx, cy, shape, members: ranked, life: 60 + Math.random() * 40 };
  }

  simulatePrime() {
    if (this.primePhase) {
      this.clusterTimer--;
      if (this.letters.length < 26 && Math.random() < 0.06) this.spawnLetter();
      if (this.clusterTimer <= 0) {
        if (!this.clusterTarget) this.startCluster();
        else if (!this.clusterTarget.pinned) {
          this.clusterTarget.life--;
          if (this.clusterTarget.life <= 0) {
            for (const L of this.clusterTarget.members) { L.targetX = null; L.targetY = null; }
            this.clusterTarget = null;
            this.clusterTimer = 120 + Math.random() * 100;
          }
        }
      }
    }
    for (let i = this.magnets.length - 1; i >= 0; i--) {
      this.magnets[i].life--;
      if (this.magnets[i].life <= 0) this.magnets.splice(i, 1);
    }
    const cx = this.W / 2, cy = this.H / 2;
    for (let i = this.letters.length - 1; i >= 0; i--) {
      const L = this.letters[i];
      L.alpha += (L.targetAlpha - L.alpha) * 0.04;
      if (!this.primePhase) L.alpha *= 0.96;
      if (L.targetX != null) {
        L.vx += (L.targetX - L.x) * 0.02; L.vy += (L.targetY - L.y) * 0.02;
        L.vx *= 0.85; L.vy *= 0.85;
      } else {
        const dx = cx - L.x, dy = cy - L.y;
        const d = Math.hypot(dx, dy) || 1;
        const pull = d > 300 ? 0.012 : 0.002;
        L.vx += (dx / d) * pull + (Math.random() - 0.5) * 0.08;
        L.vy += (dy / d) * pull + (Math.random() - 0.5) * 0.08;
        for (const m of this.magnets) {
          const mdx = m.x - L.x, mdy = m.y - L.y;
          const md = Math.hypot(mdx, mdy) || 1;
          if (md < 220) { const strength = 0.08 * (m.life / m.maxLife) * (1 - md / 220); L.vx += (mdx / md) * strength; L.vy += (mdy / md) * strength; }
        }
        L.vx *= 0.96; L.vy *= 0.96;
      }
      L.x += L.vx; L.y += L.vy; L.rot += L.rotV;
      if (L.alpha < 0.01 && L.targetAlpha === 0) this.letters.splice(i, 1);
    }
  }

  simulateWobble() {
    for (const b of this.typeBlocks) {
      for (const c of b.chars) {
        if (c.wobbleT < 1) c.wobbleT = Math.min(1, c.wobbleT + 0.02);
      }
    }
  }

  wobbleBlock(block) {
    for (const c of block.chars) {
      const ang = Math.random() * Math.PI * 2;
      const r = 50 + Math.random() * 25;
      c.wobbleT = 0; c.wobbleDX = Math.cos(ang) * r; c.wobbleDY = Math.sin(ang) * r; c.wobbleRot = (Math.random() - 0.5) * 0.8;
    }
    for (const c of block.chars) c.rot += (Math.random() - 0.5) * 0.08;
  }

  blockAtPoint(x, y) {
    let best = null, bestD = Infinity;
    for (const b of this.typeBlocks) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < b.hitR && d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  absorbLettersNear(x, y, count) {
    if (this.letters.length === 0) return;
    const ranked = this.letters.map(L => ({ L, d: Math.hypot(L.x - x, L.y - y) })).sort((a, b) => a.d - b.d).slice(0, count);
    for (const { L } of ranked) L.targetAlpha = 0;
  }

  addTypeBlock(node, spawnPos) {
    const info = this.topicInfo(node.topic);
    const shape = SHAPES[node.type] || 'circle';
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const heatMult = 0.9 + heat * 0.4;
    const baseFontSize = (11 + node.confidence * 10) * heatMult;
    const margin = 80;
    const x = spawnPos ? spawnPos.x : margin + Math.random() * (this.W - margin * 2);
    const y = spawnPos ? spawnPos.y : margin + Math.random() * (this.H - margin * 2);
    let text = node.text;
    if (node.stance === 'questioning') text = this.interleaveQuestions(text);
    const chars = [];
    if (shape === 'circle') {
      const radius = (40 + node.confidence * 30) * heatMult;
      const n = text.length;
      for (let i = 0; i < n; i++) { const ang = (i / n) * Math.PI * 2 - Math.PI / 2; chars.push({ ch: text[i], rx: Math.cos(ang) * radius, ry: Math.sin(ang) * radius, rot: ang + Math.PI / 2, size: baseFontSize }); }
    } else if (shape === 'spiral') {
      for (let i = 0; i < text.length; i++) { const ang = i * 0.4; const r = (15 + i * 3) * heatMult; chars.push({ ch: text[i], rx: Math.cos(ang) * r, ry: Math.sin(ang) * r, rot: ang + Math.PI / 2, size: baseFontSize }); }
    } else if (shape === 'fork') {
      const half = Math.floor(text.length / 2);
      for (let i = 0; i < text.length; i++) { const isLeft = i < half; const t = isLeft ? (half - i) : (i - half); const branch = isLeft ? -1 : 1; chars.push({ ch: text[i], rx: branch * t * 9 * heatMult, ry: t * 9 * heatMult, rot: 0, size: baseFontSize }); }
    } else if (shape === 'collapse') {
      for (let i = 0; i < text.length; i++) chars.push({ ch: text[i], rx: 0, ry: i * (baseFontSize * 0.9), rot: 0, size: baseFontSize * (1 - i / text.length * 0.7) });
    } else if (shape === 'scatter') {
      for (let i = 0; i < text.length; i++) chars.push({ ch: text[i], rx: (Math.random() - 0.5) * 60 * heatMult, ry: (Math.random() - 0.5) * 60 * heatMult, rot: (Math.random() - 0.5) * 0.4, size: baseFontSize * 0.85 });
    } else {
      const half = (45 + node.confidence * 25) * heatMult;
      const side = half * 2; const perimeter = side * 4; const n = text.length;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * perimeter;
        let rx, ry, rot;
        if (t < side) { rx = -half + t; ry = -half; rot = 0; }
        else if (t < side * 2) { rx = half; ry = -half + (t - side); rot = Math.PI / 2; }
        else if (t < side * 3) { rx = half - (t - side * 2); ry = half; rot = Math.PI; }
        else { rx = -half; ry = half - (t - side * 3); rot = -Math.PI / 2; }
        chars.push({ ch: text[i], rx, ry, rot, size: baseFontSize });
      }
    }
    for (const c of chars) { c.wobbleT = 1; c.wobbleDX = 0; c.wobbleDY = 0; c.wobbleRot = 0; }
    const block = { chars, color: info.color, node, shape, x, y, hitR: (60 + node.confidence * 30) * heatMult, stance: node.stance || null, pivotScale: 1 };
    this.typeBlocks.push(block);
    for (const b of this.typeBlocks) b.pivotScale = this.pivotScaleFor(b);
  }

  drawTypographicConnectors() {
    if (!this.sessionHasRefs() || this.typeBlocks.length < 2) return;
    this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
    for (const b of this.typeBlocks) {
      const node = b.node;
      if (!node || !Array.isArray(node.refs) || !node.refs.length) continue;
      const glyph = this.relTypoGlyph(node.rel);
      for (const tid of node.refs) {
        const t = this.blockById(tid);
        if (!t) continue;
        this.drawTypoConnector(b.x, b.y, t.x, t.y, glyph, b.color, b.hitR, t.hitR);
      }
    }
  }

  drawTypoConnector(x1, y1, x2, y2, glyph, color, r1, r2) {
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    const clearStart = r1 * 0.9, clearEnd = r2 * 0.9;
    const available = dist - clearStart - clearEnd;
    if (available < 20) return;
    const ang = Math.atan2(dy, dx);
    const spacing = 18;
    const steps = Math.floor(available / spacing);
    if (steps < 1) return;
    const t0 = clearStart / dist, t1 = 1 - clearEnd / dist;
    this.ctx.save();
    this.ctx.fillStyle = color; this.ctx.globalAlpha = 0.38;
    this.ctx.font = `10px 'JetBrains Mono', monospace`;
    for (let i = 1; i <= steps; i++) {
      const t = t0 + (t1 - t0) * (i / (steps + 1));
      const x = x1 + dx * t, y = y1 + dy * t;
      this.ctx.save(); this.ctx.translate(x, y); this.ctx.rotate(ang); this.ctx.fillText(glyph, 0, 0); this.ctx.restore();
    }
    this.ctx.restore();
  }

  drawExternalBrackets() {
    this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
    for (const b of this.typeBlocks) {
      if (!this.hasExternalBecause(b)) continue;
      const scale = b.pivotScale || 1;
      const hit = b.hitR * scale;
      const off = hit * 1.05;
      const size = Math.max(26, hit * 0.55);
      this.ctx.save(); this.ctx.fillStyle = b.color; this.ctx.globalAlpha = 0.75;
      this.ctx.font = `${size}px Georgia, serif`;
      this.ctx.fillText('«', b.x - off, b.y); this.ctx.fillText('»', b.x + off, b.y);
      this.ctx.restore();
    }
  }

  drawMagnets() {
    for (const m of this.magnets) {
      const t = m.life / m.maxLife;
      this.ctx.fillStyle = `rgba(90, 80, 65, ${0.08 * t})`;
      this.ctx.beginPath(); this.ctx.arc(m.x, m.y, 40 * t, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.strokeStyle = `rgba(90, 80, 65, ${0.3 * t})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.arc(m.x, m.y, 6, 0, Math.PI * 2); this.ctx.stroke();
    }
    if (this.clusterTarget && this.clusterTarget.pinned) {
      this.ctx.strokeStyle = 'rgba(90, 80, 65, 0.32)'; this.ctx.lineWidth = 1;
      this.ctx.setLineDash([3, 3]);
      this.ctx.beginPath(); this.ctx.arc(this.clusterTarget.cx, this.clusterTarget.cy, 60, 0, Math.PI * 2); this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
  }

  drawPrime() {
    if (this.letters.length === 0) return;
    this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
    for (const L of this.letters) {
      if (L.alpha < 0.01) continue;
      this.ctx.save(); this.ctx.translate(L.x, L.y); this.ctx.rotate(L.rot);
      this.ctx.font = `${L.size}px 'JetBrains Mono', monospace`;
      this.ctx.fillStyle = `rgba(120, 110, 95, ${L.alpha})`;
      this.ctx.fillText(L.ch, 0, 0);
      this.ctx.restore();
    }
  }

  // Typographer's grid — faint horizontal baseline rows at 16px intervals.
  // Grid the poet would have set type on. Static; cached to an offscreen canvas.
  drawTypographersGrid() {
    if (!this._gridOff || this._gridW !== this.W || this._gridH !== this.H) {
      if (!this._gridOff) this._gridOff = document.createElement('canvas');
      this._gridOff.width = Math.max(1, Math.ceil(this.W));
      this._gridOff.height = Math.max(1, Math.ceil(this.H));
      this._gridW = this.W; this._gridH = this.H;
      const oc = this._gridOff.getContext('2d');
      oc.clearRect(0, 0, this.W, this.H);
      oc.strokeStyle = 'rgba(0, 0, 0, 0.04)';
      oc.lineWidth = 1;
      const step = 16;
      for (let y = 0.5; y <= this.H; y += step) {
        oc.beginPath();
        oc.moveTo(0, y); oc.lineTo(this.W, y);
        oc.stroke();
      }
    }
    this.ctx.drawImage(this._gridOff, 0, 0);
  }

  redraw() {
    const ht = this.app.highlightedTopic;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawTypographersGrid();
    this.drawPrime();
    this.drawMagnets();
    this.drawTypographicConnectors();
    this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
    for (const b of this.typeBlocks) {
      const scale = b.pivotScale || 1;
      const dim = ht && b.node && b.node.topic !== ht ? 0.25 : 1;
      let fontWeight = 400, fontStyle = 'normal', strike = false;
      if (b.stance === 'claiming') fontWeight = 700;
      else if (b.stance === 'exploring') fontStyle = 'italic';
      else if (b.stance === 'conceding') { fontStyle = 'italic'; strike = true; }
      this.ctx.fillStyle = b.color;
      this.ctx.globalAlpha = dim;
      for (const c of b.chars) {
        const env = c.wobbleT < 1 ? Math.sin(c.wobbleT * Math.PI) : 0;
        const size = c.size * scale;
        this.ctx.save();
        this.ctx.translate(b.x + c.rx * scale + c.wobbleDX * env, b.y + c.ry * scale + c.wobbleDY * env);
        this.ctx.rotate(c.rot + c.wobbleRot * env);
        this.ctx.font = `${fontStyle} ${fontWeight} ${size}px 'JetBrains Mono', monospace`;
        this.ctx.fillText(c.ch, 0, 0);
        this.ctx.restore();
      }
      this.ctx.globalAlpha = 1;
      if (strike) {
        const hit = b.hitR * scale;
        this.ctx.save(); this.ctx.strokeStyle = b.color; this.ctx.globalAlpha = 0.75; this.ctx.lineWidth = 1.5;
        this.ctx.beginPath(); this.ctx.moveTo(b.x - hit * 0.95, b.y); this.ctx.lineTo(b.x + hit * 0.95, b.y); this.ctx.stroke();
        this.ctx.restore();
      }
    }
    this.drawExternalBrackets();
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: seed the floating letter pool with the actual prompt tokens so
  // the letters on-canvas loosely mirror the user's words before blocks arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const x = this.W  * (0.1 + (h % 800) / 1000);
      const y = this.H * (0.1 + ((h >> 10) % 800) / 1000);
      // Spawn each character of the token as a floating letter
      for (let ci = 0; ci < tok.length; ci++) {
        const ch = tok[ci];
        const cx = x + (ci - tok.length / 2) * 14;
        this.letters.push({
          ch: ch.toUpperCase(),
          x: cx, y,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          size: 13 + ((h >> (ci * 3)) % 6),
          rot: (Math.random() - 0.5) * 0.3,
          rotV: (Math.random() - 0.5) * 0.008,
          alpha: 0,
          targetAlpha: 0.35 + ((h >> 8) % 20) / 100,
          targetX: null, targetY: null,
        });
      }
    }
  }

  onNode(n) {
    let spawnPos = null;
    if (this.primePhase) {
      if (this.clusterTarget && this.clusterTarget.pinned) {
        spawnPos = { x: this.clusterTarget.cx, y: this.clusterTarget.cy };
        for (const L of this.clusterTarget.members) L.targetAlpha = 0;
      } else {
        this.absorbLettersNear(this.W / 2, this.H / 2, Math.min(this.letters.length, 10));
      }
      this.stopPrime();
    }
    this.addTypeBlock(n, spawnPos);
    this.playConcreteUtterance(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.typeBlocks = [];
    this.letters = [];
    this.magnets = [];
    this.primePhase = false;
    this.clusterTarget = null;
    this.dragState = null;
    this.canvas.style.cursor = 'crosshair';
    this.redraw();
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime();
    this.simulateWobble();
    this.redraw();
  }
}

export { ConcreteMode };

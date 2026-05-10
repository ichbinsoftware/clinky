import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, playTone } from '/clinky.js';
import { playSynth, PRESETS, setAesthetic, pickSessionKey, getSessionKey, configureDelay } from '/synth.js';

const PENT_MAJOR_INDICES = [0, 1, 2, 4, 5];
const PENT_MINOR_INDICES = [0, 2, 3, 4, 6];

function hashTopic(topicId) {
  const s = String(topicId || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

class BounceMode extends Mode {
  drops = [];
  platforms = [];
  tuningPhase = false;
  tuningLines = [];
  pluckSpawnTimer = 0;

  static TUNING_LINE_COUNT = 6;
  static TUNING_FREQS = [740, 659.25, 587.33, 523.25, 466.16, 415.30];

  constructor() {
    super({
      mode: 'bounce',
      aesthetic: 'videogame',
      topicFallbackColor: '#2a9d8f',
      vars: {
        '--e-bg': '#0a0a0a', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#eaad28', '--e-pivot-tint': 'rgba(238,195,100,0.08)', '--e-accent': '#eec364',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let closest = null, cd = 30;
      this.drops.forEach(d => {
        if (!d.alive && d.bounces <= 0) return;
        const dd = Math.hypot(d.x - mx, d.y - my);
        if (dd < cd) { cd = dd; closest = d; }
      });
      if (closest) { showTooltip(e, closest.node, closest.color); this.app.highlightLegendTopic(closest.node.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('click', e => {
      if (this.tuningPhase) return;
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const radius = 90;
      this.drops.forEach(d => {
        const dx = d.x - mx, dy = d.y - my;
        const dist = Math.hypot(dx, dy);
        if (dist < radius) {
          const falloff = 1 - dist / radius;
          const strength = falloff * 14;
          if (dist > 0.1) d.vx = (d.vx || 0) + (dx / dist) * strength * 0.6;
          d.vy = -Math.abs(strength) - 2;
          if (d.settled) { d.alive = true; d.settled = false; d.bounces = 0; }
        }
      });
    });
  }

  count() { return this.drops.length; }
  legendItems() { return this.drops; }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.drops.map(d => d.node).filter(Boolean));
  }

  hasExternalBecause(n) {
    const b = n && n.because;
    return Array.isArray(b) && b.some(x => typeof x === 'string');
  }

  topicOfNodeId(id) {
    for (const d of this.drops) if (d.node && d.node.id === id) return d.topic;
    return null;
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('videogame');
      pickSessionKey(this.app.prompt() || 'bounce');
      configureDelay({ time: 0.18, feedback: 0.38, wet: 0.25 });
    });
  }

  topicPentatonicMidi(topicId) {
    const key = getSessionKey();
    const mask = (key.scale === 'minor') ? PENT_MINOR_INDICES : PENT_MAJOR_INDICES;
    const notes = key.notes;
    const pentNotes = mask.map(i => notes[i % notes.length]);
    const slot = hashTopic(topicId) % (pentNotes.length * 2);
    const baseNote = pentNotes[slot % pentNotes.length];
    const octaveLift = slot >= pentNotes.length ? 12 : 0;
    return baseNote + octaveLift;
  }

  playBouncePluck(topicId, opts = {}) {
    const midi = this.topicPentatonicMidi(topicId) + 12;
    playSynth({ midi, ...PRESETS.pluck, vol: opts.vol != null ? opts.vol : 0.13, reverbSend: 0.05, delaySend: 0.45 });
  }

  playCrossBouncePluck(refTopicId) {
    const midi = this.topicPentatonicMidi(refTopicId) + 12 - 5;
    playSynth({ midi, ...PRESETS.pluck, vol: 0.06, reverbSend: 0.05, delaySend: 0.35 });
  }

  rebuildTuningLineYs() {
    if (this.tuningLines.length === 0) return;
    for (let i = 0; i < this.tuningLines.length; i++) {
      this.tuningLines[i].y = this.H * (0.2 + (i / (BounceMode.TUNING_LINE_COUNT - 1)) * 0.6);
    }
  }

  startTuning() {
    this.tuningPhase = true;
    this.tuningLines = [];
    for (let i = 0; i < BounceMode.TUNING_LINE_COUNT; i++) {
      this.tuningLines.push({
        y: this.H * (0.2 + (i / (BounceMode.TUNING_LINE_COUNT - 1)) * 0.6),
        alpha: 0, plucks: [], freq: BounceMode.TUNING_FREQS[i] || 440,
      });
    }
    this.pluckSpawnTimer = 40 + Math.random() * 30;
  }

  stopTuning() { this.tuningPhase = false; }

  spawnPluck() {
    if (this.tuningLines.length === 0) return;
    const lineIdx = Math.floor(Math.random() * this.tuningLines.length);
    const line = this.tuningLines[lineIdx];
    const padX = this.W * 0.1;
    const lineW = this.W * 0.8;
    line.plucks.push({ origin: padX + 0.2 * lineW + Math.random() * lineW * 0.6, age: 0, amp: 10 + Math.random() * 8 });
    playTone(line.freq, 0.35, 'sine', 0.09);
  }

  simulateTuning() {
    if (this.tuningPhase) {
      this.pluckSpawnTimer--;
      if (this.pluckSpawnTimer <= 0) {
        this.spawnPluck();
        this.pluckSpawnTimer = 50 + Math.random() * 80;
      }
    }
    for (const line of this.tuningLines) {
      if (this.tuningPhase) line.alpha = Math.min(0.32, line.alpha + 0.012);
      else line.alpha *= 0.93;
      for (let i = line.plucks.length - 1; i >= 0; i--) {
        line.plucks[i].age += 1;
        if (line.plucks[i].age > 130) line.plucks.splice(i, 1);
      }
    }
    if (!this.tuningPhase && this.tuningLines.length > 0
        && this.tuningLines.every(l => l.alpha < 0.005 && l.plucks.length === 0)) {
      this.tuningLines = [];
    }
  }

  drawTuning() {
    if (this.tuningLines.length === 0) return;
    const padX = this.W * 0.1;
    const lineW = this.W * 0.8;
    for (const line of this.tuningLines) {
      if (line.alpha < 0.005 && line.plucks.length === 0) continue;
      this.ctx.strokeStyle = `rgba(180, 220, 180, ${line.alpha})`;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      const samples = 80;
      for (let s = 0; s <= samples; s++) {
        const x = padX + (s / samples) * lineW;
        let dy = 0;
        for (const p of line.plucks) {
          const t = p.age / 60;
          const speed = 320;
          const left = p.origin - t * speed;
          const right = p.origin + t * speed;
          const wid = 70 + t * 30;
          const decay = Math.exp(-t * 1.1);
          const dEnvL = Math.exp(-Math.pow((x - left) / wid, 2));
          const dEnvR = Math.exp(-Math.pow((x - right) / wid, 2));
          dy += p.amp * decay * (dEnvL - dEnvR);
        }
        const y = line.y + dy;
        if (s === 0) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
      }
      this.ctx.stroke();
    }
  }

  rebuildPlatforms() {
    const old = this.platforms || [];
    this.platforms = this.topics.map((tp, i) => {
      const existing = old.find(p => p.topic === tp.id);
      return {
        x: this.W * 0.1,
        y: this.H * (0.2 + (i / Math.max(this.topics.length - 1, 1)) * 0.6),
        w: this.W * 0.8,
        color: tp.color, topic: tp.id,
        hits: existing ? existing.hits : 0,
        glow: existing ? existing.glow : 0,
      };
    });
    this.drops.forEach(d => {
      const target = this.platforms.find(p => p.topic === d.topic);
      const oldTarget = old.find(p => p.topic === d.topic);
      if (!target) return;
      if (d.settled || (!d.alive && d.bounces > 0)) { d.y = target.y - d.radius; d.vy = 0; }
      else if (d.alive && oldTarget) d.y += (target.y - oldTarget.y);
    });
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = innerWidth;
    this.H = innerHeight;
    this.canvas.width  = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width  = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.rebuildPlatforms();
    this.rebuildTuningLineYs();
  }

  addDrop(node) {
    const info = this.topicInfo(node.topic);
    const heat = typeof node.heat === 'number' ? node.heat : 0;
    const startY = -10 - heat * this.H * 0.28;
    const stance = node.stance;
    let restitution = 0.6;
    if (stance === 'claiming') restitution = 0.85;
    else if (stance === 'exploring') restitution = 0.68;
    else if (stance === 'questioning') restitution = 0.4;
    else if (stance === 'conceding') restitution = 0.22;
    const elapsed = typeof node.elapsed_ms === 'number' ? node.elapsed_ms : 0;
    const gravity = Math.max(0.06, 0.15 - Math.min(elapsed, 6000) / 6000 * 0.09);
    const inbound = this.nodeIncoming(node.id);
    const pivotScale = inbound >= 3 ? 1 + Math.min(inbound - 2, 5) * 0.14 : 1;
    const isExternal = this.hasExternalBecause(node);
    this.drops.push({
      x: this.W * (0.15 + Math.random() * 0.7),
      y: startY, vx: 0, vy: 0,
      radius: (4 + node.confidence * 6) * pivotScale,
      color: info.color, node, topic: node.topic, rel: node.rel,
      bounces: 0, alive: true, restitution, gravity, pivotScale, isExternal,
      trail: isExternal ? [] : null,
      bouncedPlatforms: new Set(),
    });
  }

  simulate() {
    this.drops.forEach(d => {
      if (d.trail) {
        if (d.alive) d.trail.push({ x: d.x, y: d.y, age: 0 });
        if (d.trail.length > 24) d.trail.shift();
        for (const t of d.trail) t.age++;
      }
      if (!d.alive) return;
      d.vy += (d.gravity || 0.15);
      d.vx = (d.vx || 0) * 0.97;
      d.x += d.vx;
      if (d.x < d.radius + 4) { d.x = d.radius + 4; d.vx = Math.abs(d.vx) * 0.6; }
      if (d.x > this.W - d.radius - 4) { d.x = this.W - d.radius - 4; d.vx = -Math.abs(d.vx) * 0.6; }
      const prevBottom = d.y + d.radius;
      d.y += d.vy;
      const nextBottom = d.y + d.radius;
      const refs = d.node && d.node.refs;
      if (Array.isArray(refs) && refs.length > 0 && d.vy > 0 && !d.settled) {
        for (const tid of refs) {
          const refTopic = this.topicOfNodeId(tid);
          if (!refTopic || refTopic === d.topic) continue;
          if (d.bouncedPlatforms.has(refTopic)) continue;
          const rp = this.platforms.find(p => p.topic === refTopic);
          if (!rp) continue;
          if (prevBottom <= rp.y && nextBottom >= rp.y && d.x > rp.x && d.x < rp.x + rp.w) {
            d.bouncedPlatforms.add(refTopic);
            if (d.rel === 'supersedes') continue;
            d.vy = -(Math.abs(d.vy) * 0.55);
            d.y = rp.y - d.radius;
            rp.hits++; rp.glow = 1;
            const own = this.platforms.find(p => p.topic === d.topic);
            const ownCx = own ? own.x + own.w / 2 : d.x;
            const dirToOwn = Math.sign(ownCx - d.x) || 1;
            if (d.rel === 'supports') d.vx += dirToOwn * 2.2;
            else if (d.rel === 'contradicts') { d.vx += -dirToOwn * 4.5; d.vy *= 1.25; }
            else if (d.rel === 'synthesizes') d.vy *= 1.3;
            else if (d.rel === 'refines') d.vy *= 0.45;
            else if (d.rel === 'questions') { d.vx += (Math.random() - 0.5) * 4; d.vy *= 0.82; }
            this.playCrossBouncePluck(refTopic);
            break;
          }
        }
      }
      const target = this.platforms.find(p => p.topic === d.topic);
      if (target && d.vy > 0 && prevBottom <= target.y && nextBottom >= target.y && d.x > target.x && d.x < target.x + target.w) {
        d.vy = -(Math.abs(d.vy) * (d.restitution || 0.6));
        d.y = target.y - d.radius;
        d.bounces++; target.hits++; target.glow = 1;
        this.playBouncePluck(d.node.topic, { vol: 0.13 * Math.pow(0.82, d.bounces - 1) });
        if (Math.abs(d.vy) < 1.2) { d.vy = 0; d.y = target.y - d.radius; d.alive = false; d.settled = true; }
      }
      if (d.bounces > 8 && !d.settled) {
        const t = this.platforms.find(p => p.topic === d.topic);
        if (t) { d.y = t.y - d.radius; d.vy = 0; d.settled = true; }
        d.alive = false;
      }
      if (d.y > this.H + 20) { d.alive = false; if (!d.settled) d.bounces = 0; }
    });
    this.drops = this.drops.filter(d => d.alive || d.bounces > 0);
    this.platforms.forEach(p => { if (p.glow > 0) p.glow *= 0.95; });
  }

  onStart() {
    this.initAural();
    this.startTuning();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: one ghost drop per token that bounces off a temporary platform
  // at a hashed vertical position and fades when nodes arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const xFrac = (h % 700 + 150) / 1000;
      const x = this.W * xFrac;
      const startY = -12 - ((h >> 8) % 60);
      const restitution = 0.45 + ((h >> 12) % 30) / 100;
      // Ghost node object — minimal shape, greyscale
      const ghostNode = { id: null, topic: '__ghost__', text: tok, type: 'claim', confidence: 0.4, heat: 0, stance: null, refs: [], rel: 'supports', elapsed_ms: 0 };
      this.drops.push({
        x, y: startY, vx: 0, vy: 0,
        radius: 4,
        color: 'rgba(150,150,150,0.55)',
        node: ghostNode, topic: '__ghost__', rel: 'supports',
        bounces: 0, alive: true, restitution, gravity: 0.13,
        pivotScale: 1, isExternal: false,
        trail: null, bouncedPlatforms: new Set(),
        _ghost: true,
      });
    }
  }

  onTopics(t) {
    this.rebuildPlatforms();
    this.stopTuning();
  }

  onNode(n) {
    this.addDrop(n);
  }

  onDone() { this.stopTuning(); }
  onError() { this.stopTuning(); }
  onStop() { this.stopTuning(); }

  onClear() {
    this.drops = [];
    this.platforms = [];
    this.tuningLines = [];
    this.tuningPhase = false;
  }

  // Stage floor — vertical gradient from near-black at the top to a slightly
  // lighter charcoal at the bottom. Implies a floor without drawing one.
  drawStageFloor() {
    const grad = this.ctx.createLinearGradient(0, 0, 0, this.H);
    grad.addColorStop(0, '#050505');
    grad.addColorStop(1, '#1a1a1a');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulate();
    this.simulateTuning();
    this.drawStageFloor();
    this.drawTuning();
    this.platforms.forEach(p => {
      const [r, g, b] = hexToRgb(p.color);
      if (p.glow > 0.01) {
        this.ctx.fillStyle = `rgba(${r},${g},${b},${p.glow * 0.3})`;
        this.ctx.fillRect(p.x - 4, p.y - 8, p.w + 8, 22);
      }
      const intensity = Math.min(1, 0.3 + p.hits * 0.05);
      this.ctx.fillStyle = `rgba(${r},${g},${b},${intensity})`;
      this.ctx.fillRect(p.x, p.y, p.w, 4);
      this.ctx.fillStyle = p.color; this.ctx.globalAlpha = 0.5;
      this.ctx.font = '10px "JetBrains Mono", monospace';
      this.ctx.fillText(p.topic, p.x - this.ctx.measureText(p.topic).width - 10, p.y + 4);
      this.ctx.globalAlpha = 1;
    });
    const ht = this.app.highlightedTopic;
    this.drops.forEach(d => {
      if (!d.alive && d.bounces <= 0) return;
      const dim = ht && d.topic !== ht ? 0.25 : 1;
      if (d.trail && d.trail.length > 1) {
        this.ctx.lineCap = 'round';
        for (let i = 1; i < d.trail.length; i++) {
          const a = d.trail[i - 1], b = d.trail[i];
          const fade = Math.max(0, 1 - b.age / 24);
          if (fade <= 0) continue;
          this.ctx.strokeStyle = `rgba(235, 225, 190, ${0.55 * fade})`;
          this.ctx.lineWidth = d.radius * 0.7 * fade + 0.5;
          this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
        }
      }
      const inbound = d.node ? this.nodeIncoming(d.node.id) : 0;
      if (d.settled && inbound >= 3) {
        const [r, g, b] = hexToRgb(d.color);
        const intensity = Math.min(1, (inbound - 2) / 4);
        const outerR = d.radius * (1.9 + Math.min(inbound - 2, 4) * 0.2);
        this.ctx.fillStyle = `rgba(${r},${g},${b},${0.13 * intensity})`;
        this.ctx.beginPath(); this.ctx.arc(d.x, d.y, outerR, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.fillStyle = `rgba(${r},${g},${b},${0.22 * intensity})`;
        this.ctx.beginPath(); this.ctx.arc(d.x, d.y, d.radius * 1.4, 0, Math.PI * 2); this.ctx.fill();
      }
      this.ctx.fillStyle = d.color;
      this.ctx.globalAlpha = (d.alive ? 0.8 : (d.settled ? 0.7 : 0.3)) * dim;
      this.ctx.beginPath();
      if (d.vy > 1) this.ctx.ellipse(d.x, d.y, d.radius * 0.7, d.radius, 0, 0, Math.PI * 2);
      else this.ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      this.ctx.fill(); this.ctx.globalAlpha = 1;
    });
  }
}

export { BounceMode };

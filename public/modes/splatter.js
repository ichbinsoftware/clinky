import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, incomingRefsOf, onGraphComplete, nodeBy } from '/clinky.js';
import { playSynth, setAesthetic, pickSessionKey, quantizeToKey, AESTHETICS } from '/synth.js';

const GESTURE_NOTES = 8;
const GESTURE_STEP_MS = 90;
const GESTURE_NOTE_DUR = 0.18;

class SplatterMode extends Mode {
  splatters = [];
  primePhase = false;
  drips = [];
  dripSpawnTimer = 0;
  mouseX = -1;
  mouseY = -1;
  downAt = null;
  dragging = false;
  userGesture = null;
  userGestures = [];
  trailDroplets = [];
  trailing = false;

  constructor() {
    super({
      mode: 'splatter',
      aesthetic: 'jazz',
      topicFallbackColor: '#333',
      vars: {
        '--e-bg': '#e8dfc8', '--e-text': '#1a1208',
        '--e-text-mute': 'rgba(26,18,8,0.7)', '--e-text-faint': 'rgba(26,18,8,0.45)',
        '--e-rule': 'rgba(26,18,8,0.16)',
        '--e-narration': '#5a3818', '--e-pivot-tint': 'rgba(205,33,60,0.08)', '--e-accent': '#cd213c',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left; this.mouseY = e.clientY - r.top;
      if (this.userGesture) {
        this.userGesture.points.push({ x: this.mouseX + (Math.random() - 0.5) * 2, y: this.mouseY + (Math.random() - 0.5) * 2 });
        if (Math.random() < 0.12) this.userGesture.droplets.push({ x: this.mouseX + (Math.random() - 0.5) * 60, y: this.mouseY + (Math.random() - 0.5) * 60, r: 2 + Math.random() * 5 });
        this.dragging = true;
      }
      if (this.trailing) {
        const last = this.trailDroplets[this.trailDroplets.length - 1];
        if (!last || Math.hypot(last.x - this.mouseX, last.y - this.mouseY) > 10) {
          this.trailDroplets.push({ x: this.mouseX + (Math.random() - 0.5) * 8, y: this.mouseY + (Math.random() - 0.5) * 8, r: 1.5 + Math.random() * 2, age: 0, maxAge: 180 });
        }
        this.dragging = true;
      }
      const hit = this.splatterAt(this.mouseX, this.mouseY);
      if (hit) { showTooltip(e, hit, hit.color); this.app.highlightLegendTopic(hit.topic); }
      else { hideTooltip(); this.app.highlightLegendTopic(null); }
    });
    this.canvas.addEventListener('mousedown', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      this.dragging = false;
      if (this.primePhase) {
        const d = this.dripAt(mx, my);
        if (d) { d.flickVx = (mx > d.x ? 1 : -1) * (6 + Math.random() * 4); this.downAt = { drip: d }; return; }
        this.trailing = true; this.downAt = { trail: true }; return;
      }
      const hit = this.splatterAt(mx, my);
      if (hit) { this.downAt = { splatter: hit }; return; }
      this.userGesture = { points: [{ x: mx, y: my }], droplets: [], color: '#5a5248', width: 1.5 };
      this.downAt = { gesture: true };
    });
    this.canvas.addEventListener('mouseup', e => {
      if (!this.downAt) return;
      const was = this.downAt; this.downAt = null;
      if (was.trail) { this.trailing = false; return; }
      if (was.gesture && this.userGesture) { if (this.userGesture.points.length >= 2) this.userGestures.push(this.userGesture); this.userGesture = null; return; }
      if (was.splatter && !this.dragging) { was.splatter.flashUntil = performance.now() + 400; this.playGesture(was.splatter); }
    });
  }

  count() { return this.splatters.length; }
  legendItems() { return this.splatters; }

  splatterIncoming(s) { return s.id != null ? (this.incomingRefsMap[s.id] ?? incomingRefsOf(s.id, this.splatters)) : 0; }
  hasExternalBecause(s) { return Array.isArray(s.because) && s.because.some(b => typeof b === 'string'); }
  sessionHasRefs() { for (const s of this.splatters) if (Array.isArray(s.refs) && s.refs.length > 0) return true; return false; }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('jazz');
      pickSessionKey(this.app.prompt() || 'splatter');
    });
  }

  hexToRgba(h, a) { const r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; }

  pseudoRand(seed) { const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  buildGesture(splat) {
    const pts = splat.points; if (!pts || pts.length < 2) return [];
    const notes = [];
    for (let i = 0; i < GESTURE_NOTES; i++) {
      const idx = Math.floor((i / (GESTURE_NOTES - 1)) * (pts.length - 1));
      const p = pts[idx];
      const ny = Math.max(0, Math.min(1, p.y / this.H));
      const rawMidi = 72 - ny * 24;
      notes.push(quantizeToKey(rawMidi));
    }
    return notes;
  }

  playGesture(splat) {
    if (!splat.gesture || splat.gesture.length === 0) return;
    const jazz = AESTHETICS.jazz;
    splat.gesture.forEach((midi, i) => {
      setTimeout(() => playSynth({ ...jazz.preset, midi, duration: GESTURE_NOTE_DUR, attack: 0.003, decay: 0.08, sustain: 0.2, release: 0.12, vol: 0.10, voices: 1, reverbSend: jazz.reverbSend }), i * GESTURE_STEP_MS);
    });
  }

  spawnDrip(color, onLand) {
    this.drips.push({ x: this.W * (0.1 + Math.random() * 0.8), fallY: this.H * (0.25 + Math.random() * 0.5), age: 0, maxAge: 240, color: color || null, onLand: onLand || null, landed: false, puddleR: 0 });
  }

  startPrime() { this.primePhase = true; this.drips = []; this.dripSpawnTimer = 15; this._unpackSplats = []; }
  stopPrime() { this.primePhase = false; }

  simulatePrime() {
    if (this.primePhase) {
      this.dripSpawnTimer--;
      const alive = this.drips.filter(d => d.age < 180 && !d.color).length;
      if (this.dripSpawnTimer <= 0 && alive < 4) { this.spawnDrip(); this.dripSpawnTimer = 60 + Math.random() * 60; }
    }
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i]; d.age++;
      const fallFrames = 60;
      if (!d.landed && d.flickVx) { d.x += d.flickVx; d.flickVx *= 0.85; if (Math.abs(d.flickVx) < 0.1) d.flickVx = 0; }
      if (d.age >= fallFrames && !d.landed) { d.landed = true; if (d.onLand) d.onLand(d.x, d.fallY); }
      if (d.landed) d.puddleR = Math.min(6, d.puddleR + 0.3);
      if (d.age > d.maxAge) this.drips.splice(i, 1);
    }
    for (let i = this.trailDroplets.length - 1; i >= 0; i--) { this.trailDroplets[i].age++; if (this.trailDroplets[i].age > this.trailDroplets[i].maxAge) this.trailDroplets.splice(i, 1); }
  }

  dripAt(x, y, tol = 14) {
    for (const d of this.drips) {
      if (Math.abs(d.x - x) > tol) continue;
      const t = Math.min(1, d.age / 60), currentY = d.fallY * t, bot = d.landed ? d.fallY : currentY;
      if (y >= -4 && y <= bot + 10) return d;
    }
    return null;
  }

  splatterAt(x, y) {
    let hit = null, hd = Infinity;
    for (const s of this.splatters) { const d = Math.hypot(s.hitBox.x - x, s.hitBox.y - y); if (d < s.hitBox.r && d < hd) { hd = d; hit = s; } }
    return hit;
  }

  makeSplatter(node, atX, atY) {
    const info = this.topicInfo(node.topic);
    const cx = atX !== undefined ? atX : this.W * (0.15 + Math.random() * 0.7);
    const cy = atY !== undefined ? atY : this.H * (0.15 + Math.random() * 0.7);
    const conf = node.confidence || 0.7, heat = node.heat != null ? node.heat : 0;
    const len = 80 + conf * 300 * (1 + heat * 0.3), n = 40 + Math.floor(conf * 80);
    const points = []; let x = cx, y = cy, ang = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) { ang += (Math.random() - 0.5) * 1.2; x += Math.cos(ang) * (5 + Math.random() * 8); y += Math.sin(ang) * (5 + Math.random() * 8); points.push({ x, y }); }
    const dropletCount = Math.floor(n / 2 + heat * n * 0.8), dropletSpread = 80 * (1 + heat * 0.4);
    const droplets = [];
    for (let i = 0; i < dropletCount; i++) {
      const p = points[Math.floor(Math.random() * points.length)];
      droplets.push({ x: p.x + (Math.random() - 0.5) * dropletSpread, y: p.y + (Math.random() - 0.5) * dropletSpread, r: 2 + Math.random() * 6 * (1 + heat * 0.3) });
    }
    const splat = { ...node, color: info.color, points, droplets, width: (1 + conf * 3) * (1 + heat * 0.5), hitBox: { x: cx, y: cy, r: len * 0.5 } };
    splat.gesture = this.buildGesture(splat);
    return splat;
  }

  drawDrips() {
    if (this.drips.length === 0) return;
    this.ctx.lineCap = 'round';
    for (const d of this.drips) {
      const fallFrames = 60, t = Math.min(1, d.age / fallFrames), currentY = d.fallY * t;
      const fadeOut = d.age > 180 ? Math.max(0, 1 - (d.age - 180) / 60) : 1;
      const streakBot = d.landed ? d.fallY : currentY;
      const strokeCol = d.color ? this.hexToRgba(d.color, 0.55 * fadeOut) : `rgba(110,100,85,${0.45 * fadeOut})`;
      this.ctx.strokeStyle = strokeCol; this.ctx.lineWidth = 1.8;
      this.ctx.beginPath(); this.ctx.moveTo(d.x, 0); this.ctx.lineTo(d.x, streakBot); this.ctx.stroke();
      if (!d.landed) {
        const beadR = 2 + t * 1.5;
        this.ctx.fillStyle = d.color ? this.hexToRgba(d.color, 0.85 * fadeOut) : `rgba(90,82,70,${0.7 * fadeOut})`;
        this.ctx.beginPath(); this.ctx.arc(d.x, currentY, beadR, 0, Math.PI * 2); this.ctx.fill();
      }
      if (d.landed) {
        this.ctx.fillStyle = d.color ? this.hexToRgba(d.color, 0.75 * fadeOut) : `rgba(90,82,70,${0.65 * fadeOut})`;
        this.ctx.beginPath(); this.ctx.arc(d.x, d.fallY, d.puddleR, 0, Math.PI * 2); this.ctx.fill();
      }
    }
  }

  drawTrailDroplets() {
    for (const t of this.trailDroplets) { const fade = 1 - t.age / t.maxAge; this.ctx.fillStyle = `rgba(90,82,70,${0.6 * fade})`; this.ctx.beginPath(); this.ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); this.ctx.fill(); }
  }

  drawUserGestures() {
    const all = this.userGesture ? [...this.userGestures, this.userGesture] : this.userGestures;
    if (all.length === 0) return;
    this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    for (const g of all) {
      if (!g.points || g.points.length < 2) continue;
      this.ctx.strokeStyle = g.color; this.ctx.lineWidth = g.width; this.ctx.globalAlpha = 0.6;
      this.ctx.beginPath(); this.ctx.moveTo(g.points[0].x, g.points[0].y);
      for (let i = 1; i < g.points.length; i++) this.ctx.lineTo(g.points[i].x, g.points[i].y);
      this.ctx.stroke();
      this.ctx.globalAlpha = 0.8; this.ctx.fillStyle = g.color;
      for (const d of g.droplets) { this.ctx.beginPath(); this.ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); this.ctx.fill(); }
    }
    this.ctx.globalAlpha = 1;
  }

  drawRefsTrajectories() {
    if (!this.sessionHasRefs() || this.splatters.length < 2) return;
    this.ctx.lineCap = 'round';
    for (const src of this.splatters) {
      if (!Array.isArray(src.refs) || src.refs.length === 0) continue;
      for (const refId of src.refs) {
        const tgt = nodeBy(refId, this.splatters); if (!tgt || tgt === src) continue;
        let width = 1.2, dash = [], alpha = 0.35;
        switch (src.rel) {
          case 'supports': width = 1.3; alpha = 0.35; break;
          case 'refines': width = 0.9; dash = [1, 3]; alpha = 0.28; break;
          case 'synthesizes': width = 1.8; alpha = 0.50; break;
          case 'contradicts': width = 1.3; dash = [4, 3]; alpha = 0.45; break;
          case 'questions': width = 0.9; dash = [2, 4]; alpha = 0.25; break;
          case 'supersedes': width = 2.4; alpha = 0.22; break;
        }
        this.ctx.strokeStyle = src.color; this.ctx.globalAlpha = alpha; this.ctx.lineWidth = width;
        if (dash.length) this.ctx.setLineDash(dash);
        const x1 = src.hitBox.x, y1 = src.hitBox.y, x2 = tgt.hitBox.x, y2 = tgt.hitBox.y;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1, bend = Math.min(60, len * 0.22);
        const cx = mx + (-dy / len) * bend, cy_ = my + (dx / len) * bend;
        this.ctx.beginPath(); this.ctx.moveTo(x1, y1); this.ctx.quadraticCurveTo(cx, cy_, x2, y2); this.ctx.stroke();
        if (dash.length) this.ctx.setLineDash([]);
        if (src.rel === 'contradicts') {
          this.ctx.fillStyle = src.color; this.ctx.globalAlpha = 0.6;
          const seedBase = ((src.id || 0) * 1000 + (tgt.id || 0)) * 100;
          let stepIdx = 0;
          for (let step = 0.15; step < 0.9; step += 0.2) {
            const u = 1 - step, t2 = step;
            const bx = u*u*x1 + 2*u*t2*cx + t2*t2*x2, by = u*u*y1 + 2*u*t2*cy_ + t2*t2*y2;
            const ox = (this.pseudoRand(seedBase + stepIdx * 3 + 0) - 0.5) * 8, oy = (this.pseudoRand(seedBase + stepIdx * 3 + 1) - 0.5) * 8;
            const rr = 1.5 + this.pseudoRand(seedBase + stepIdx * 3 + 2) * 2;
            this.ctx.beginPath(); this.ctx.arc(bx + ox, by + oy, rr, 0, Math.PI*2); this.ctx.fill();
            stepIdx++;
          }
        }
      }
    }
    this.ctx.globalAlpha = 1;
  }

  drawPivotPools() {
    if (!this.sessionHasRefs()) return;
    for (const s of this.splatters) {
      const incoming = this.splatterIncoming(s); if (incoming < 3) continue;
      const r = 18 + Math.min(16, incoming * 2);
      const grad = this.ctx.createRadialGradient(s.hitBox.x, s.hitBox.y, 4, s.hitBox.x, s.hitBox.y, r);
      grad.addColorStop(0, s.color + 'aa'); grad.addColorStop(1, s.color + '00');
      this.ctx.fillStyle = grad; this.ctx.beginPath(); this.ctx.arc(s.hitBox.x, s.hitBox.y, r, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  drawExternalMarkers() {
    for (const s of this.splatters) {
      if (!this.hasExternalBecause(s)) continue;
      this.ctx.fillStyle = 'rgba(60, 52, 40, 0.65)'; this.ctx.font = "700 11px 'JetBrains Mono', monospace";
      this.ctx.textAlign = 'left'; this.ctx.textBaseline = 'middle';
      this.ctx.fillText('↗', s.hitBox.x + s.hitBox.r * 0.5, s.hitBox.y - s.hitBox.r * 0.5);
    }
  }

  // Linen canvas weave — fine cross-hatch tile (offset warp/weft thread
  // segments) cached as a Pattern. Actual canvas beneath the paint.
  drawLinenWeave() {
    if (!this._linenPattern) {
      const tile = document.createElement('canvas');
      tile.width = 8; tile.height = 8;
      const tc = tile.getContext('2d');
      tc.strokeStyle = 'rgba(150, 120, 90, 0.10)';
      tc.lineWidth = 1;
      tc.beginPath();
      tc.moveTo(0, 1.5); tc.lineTo(4, 1.5);
      tc.moveTo(4, 5.5); tc.lineTo(8, 5.5);
      tc.moveTo(2.5, 2); tc.lineTo(2.5, 6);
      tc.moveTo(6.5, 0); tc.lineTo(6.5, 2);
      tc.moveTo(6.5, 6); tc.lineTo(6.5, 8);
      tc.stroke();
      this._linenPattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.ctx.fillStyle = this._linenPattern;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  // Drop-cloth stains — pre-existing paint patches at session-fixed positions
  // in muted earth tones at low alpha. The studio floor has history.
  drawDropClothStains() {
    if (!this._stains) {
      this._stains = [];
      const tints = ['90, 65, 45', '110, 85, 60', '130, 100, 75', '70, 55, 50', '125, 105, 75'];
      const count = 4 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) {
        this._stains.push({
          fx: Math.random(),
          fy: Math.random(),
          fr: 0.08 + Math.random() * 0.08,
          tint: tints[i % tints.length],
          alpha: 0.05 + Math.random() * 0.04,
        });
      }
    }
    for (const s of this._stains) {
      const cx = s.fx * this.W, cy = s.fy * this.H;
      const r = s.fr * Math.max(this.W, this.H);
      const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${s.tint}, ${s.alpha})`);
      g.addColorStop(0.5, `rgba(${s.tint}, ${s.alpha * 0.4})`);
      g.addColorStop(1, `rgba(${s.tint}, 0)`);
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  redraw() {
    const now = performance.now();
    const grad = this.ctx.createLinearGradient(0, 0, 0, this.H);
    grad.addColorStop(0, '#dfdcc4');
    grad.addColorStop(1, '#ece0bc');
    this.ctx.fillStyle = grad; this.ctx.fillRect(0, 0, this.W, this.H);
    this.drawLinenWeave();
    this.drawDropClothStains();
    this.drawDrips(); this.drawTrailDroplets(); this.drawUserGestures();
    this.drawPivotPools(); this.drawRefsTrajectories();
    this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round';
    // Draw ghost unpack splats (faint, greyscale)
    if (this._unpackSplats && this._unpackSplats.length > 0) {
      for (const s of this._unpackSplats) {
        if (this.primePhase) s._alpha = Math.min(s._targetAlpha, (s._alpha || 0) + 0.01);
        else s._alpha = Math.max(0, (s._alpha || 0) - 0.005);
        if ((s._alpha || 0) < 0.01) continue;
        this.ctx.globalAlpha = s._alpha;
        this.ctx.strokeStyle = s.color; this.ctx.lineWidth = s.width * 0.6;
        this.ctx.beginPath(); this.ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) this.ctx.lineTo(s.points[i].x, s.points[i].y);
        this.ctx.stroke();
        this.ctx.fillStyle = s.color;
        for (const d of s.droplets) { this.ctx.beginPath(); this.ctx.arc(d.x, d.y, d.r * 0.5, 0, Math.PI * 2); this.ctx.fill(); }
      }
      this.ctx.globalAlpha = 1;
    }
    const ht = this.app.highlightedTopic;
    for (const s of this.splatters) {
      const flashing = s.flashUntil && now < s.flashUntil, flashBoost = flashing ? (s.flashUntil - now) / 400 : 0;
      const dim = ht && s.topic !== ht ? 0.25 : 1;
      this.ctx.strokeStyle = s.color; this.ctx.lineWidth = s.width + flashBoost * 2; this.ctx.globalAlpha = (0.75 + flashBoost * 0.25) * dim;
      this.ctx.beginPath(); this.ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) this.ctx.lineTo(s.points[i].x, s.points[i].y);
      this.ctx.stroke();
      this.ctx.globalAlpha = (0.85 + flashBoost * 0.15) * dim; this.ctx.fillStyle = s.color;
      for (const d of s.droplets) { this.ctx.beginPath(); this.ctx.arc(d.x, d.y, d.r + flashBoost, 0, Math.PI * 2); this.ctx.fill(); }
    }
    this.ctx.globalAlpha = 1; this.drawExternalMarkers();
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: scatter one small grey-tone splat per token at a hashed position.
  // These pre-populate the canvas with a faint gestural foundation.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    this._unpackSplats = [];
    for (const tok of tokens) {
      const h = this.hashToken(tok);
      const x = 80 + (h % (this.W - 160));
      const y = 80 + ((h >> 8) % (this.H - 160));
      // Minimal ghost node just for making a splat
      const ghostNode = { id: null, topic: '__ghost__', text: tok, type: 'claim', confidence: 0.3 + ((h >> 4) % 30) / 100, heat: 0, stance: null, refs: [], rel: 'supports', elapsed_ms: 0 };
      const splat = this.makeSplatter(ghostNode, x, y);
      // Override color to grey-tone
      splat.color = `rgba(${100 + (Math.abs(h >> 12) % 60)},${95 + (Math.abs(h >> 16) % 50)},${90 + (Math.abs(h >> 20) % 40)},0.45)`;
      splat._ghost = true;
      splat._alpha = 0;
      splat._targetAlpha = 0.4 + ((h >> 24) % 20) / 100;
      this._unpackSplats.push(splat);
    }
  }

  onNode(n) {
    if (this.primePhase) {
      this.spawnDrip(this.topicInfo(n.topic).color, (x, y) => {
        const splat = this.makeSplatter(n, x, y);
        this.splatters.push(splat);
        this.nodes.push(n);
        this.app.updateCounter();
        this.app.updateLegend(this.topics, this.splatters);
        this.playGesture(splat);
      });
      this.stopPrime();
    } else {
      const splat = this.makeSplatter(n);
      this.splatters.push(splat);
      this.playGesture(splat);
    }
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.splatters = []; this.drips = []; this.userGestures = []; this.userGesture = null;
    this.trailDroplets = []; this.trailing = false; this.downAt = null; this.primePhase = false;
    this._unpackSplats = [];
    this.redraw();
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime();
    this.redraw();
  }
}

export { SplatterMode };

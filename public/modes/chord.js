import { Mode } from '/mode.js';
import { showTooltip, hideTooltip, hexToRgb, incomingRefsOf, onGraphComplete, playTone,
         nodeBy, refsFrom, relColor, relGlyph, onBatchStart } from '/clinky.js';
import { playSynth, playChord, midiToFreq, PRESETS, setAesthetic, pickSessionKey, getSessionKey } from '/synth.js';

const ROOTLESS = {
  maj9: [4, 7, 11, 14], min9: [3, 7, 10, 14], dom7: [4, 7, 10, 14],
  min11: [3, 7, 10, 14, 17], altDom: [4, 10, 13, 15],
};
const REL_QUALITY = {
  supports: 'maj9', contradicts: 'altDom', synthesizes: 'min11',
  refines: 'min9', questions: 'dom7', supersedes: 'maj9',
};
const HOVER_COOLDOWN_MS = 350;

class ChordMode extends Mode {
  ordered = [];
  primePhase = false;
  ghostChords = [];
  ghostSpawnTimer = 0;
  pendingUserChord = null;
  userChords = [];
  isolated = null;
  heartbeat = null;
  dragFrom = null;
  dragMouse = { x: 0, y: 0 };
  dragStarted = false;
  mouseDownAt = null;
  lastHoveredChordKey = null;
  batchRipples = [];
  lastChord = null;
  _lastHoverTime = 0;

  constructor() {
    super({
      mode: 'chord',
      aesthetic: 'jazz',
      topicFallbackColor: '#e8e0d0',
      vars: {
        '--e-bg': '#0a0d10', '--e-text': '#f0e8d4',
        '--e-text-mute': 'rgba(240,232,212,0.7)', '--e-text-faint': 'rgba(240,232,212,0.45)',
        '--e-rule': 'rgba(240,232,212,0.14)',
        '--e-narration': '#f9e098', '--e-pivot-tint': 'rgba(124,191,198,0.06)', '--e-accent': '#7cbfc6',
      },
      essayGetSession: () => ({ prompt: this.app.prompt(), nodes: this.nodes, topics: this.topics }),
    });

    onBatchStart(({ batch_id }) => { if (batch_id > 1) this.batchRipples.push({ age: 0 }); });

    this.canvas.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      this.dragMouse.x = mx; this.dragMouse.y = my;
      if (this.mouseDownAt && !this.dragStarted) {
        if (Math.hypot(mx - this.mouseDownAt.x, my - this.mouseDownAt.y) > 5 && this.mouseDownAt.node) {
          this.dragStarted = true; this.dragFrom = this.mouseDownAt.node;
          this.canvas.style.cursor = 'grabbing';
        }
      }
      const nHit = this.nodeAt(mx, my);
      if (nHit) {
        showTooltip(e, nHit, this.topicInfo(nHit.topic).color);
        this.app.highlightLegendTopic(nHit.topic);
        if (!this.dragStarted) this.canvas.style.cursor = 'pointer';
        this.lastHoveredChordKey = null; return;
      }
      hideTooltip(); this.app.highlightLegendTopic(null);
      if (!this.primePhase && this.ordered.length >= 2) {
        const cHit = this.chordAt(mx, my);
        if (cHit) {
          if (!this.dragStarted) this.canvas.style.cursor = 'pointer';
          const key = `${this.ordered.indexOf(cHit.a)}:${this.ordered.indexOf(cHit.b)}`;
          if (key !== this.lastHoveredChordKey) {
            this.lastHoveredChordKey = key;
            this.playHoverVoicing(cHit);
          }
          return;
        }
      }
      this.lastHoveredChordKey = null;
      if (this.segmentAt(mx, my)) { this.canvas.style.cursor = 'pointer'; return; }
      if (!this.primePhase && this.ordered.length > 0 && this.centreAt(mx, my)) { this.canvas.style.cursor = 'pointer'; return; }
      if (!this.dragStarted) this.canvas.style.cursor = 'crosshair';
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.canvas.style.cursor = 'crosshair';
      this.dragMouse.x = -1; this.dragMouse.y = -1;
    });

    this.canvas.addEventListener('mousedown', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      this.mouseDownAt = { x: mx, y: my, time: performance.now(), node: this.nodeAt(mx, my) };
      this.dragStarted = false;
    });

    this.canvas.addEventListener('mouseup', e => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const startInfo = this.mouseDownAt;
      this.mouseDownAt = null;
      if (!startInfo) return;
      if (this.dragStarted && this.dragFrom) {
        const endHit = this.nodeAt(mx, my);
        if (endHit && endHit !== this.dragFrom) {
          const dup = this.userChords.find(u =>
            (Math.abs(u.angleA - this.dragFrom.angle) < 0.01 && Math.abs(u.angleB - endHit.angle) < 0.01) ||
            (Math.abs(u.angleA - endHit.angle) < 0.01 && Math.abs(u.angleB - this.dragFrom.angle) < 0.01));
          if (!dup) {
            this.userChords.push({ angleA: this.dragFrom.angle, angleB: endHit.angle, bornInPrime: false });
            playTone(this.topicInfo(this.dragFrom.topic).note, 0.25, 'triangle', 0.05);
            setTimeout(() => playTone(this.topicInfo(endHit.topic).note, 0.3, 'triangle', 0.05), 120);
          }
        }
        this.dragStarted = false; this.dragFrom = null;
        this.canvas.style.cursor = 'crosshair'; return;
      }
      this.dragStarted = false; this.dragFrom = null;
      if (this.primePhase) {
        if (this.distFromCentre(mx, my) > this.geometry().r + 30) { this.pendingUserChord = null; return; }
        const ang = this.angleFromPoint(mx, my);
        if (!this.pendingUserChord) {
          this.pendingUserChord = { angle: ang };
          playTone(330, 0.22, 'sine', 0.04);
        } else {
          if (Math.abs(ang - this.pendingUserChord.angle) > 0.15) {
            this.userChords.push({ angleA: this.pendingUserChord.angle, angleB: ang, bornInPrime: true });
            playTone(440, 0.3, 'triangle', 0.05);
          }
          this.pendingUserChord = null;
        }
        return;
      }
      if (this.ordered.length > 0 && this.centreAt(mx, my)) { this.triggerHeartbeat(); return; }
      const nHit = this.nodeAt(mx, my);
      if (nHit) {
        this.isolated = (this.isolated && this.isolated.kind === 'node' && this.isolated.node === nHit)
          ? null : { kind: 'node', node: nHit };
        return;
      }
      const tHit = this.segmentAt(mx, my);
      if (tHit) {
        this.isolated = (this.isolated && this.isolated.kind === 'topic' && this.isolated.topicId === tHit)
          ? null : { kind: 'topic', topicId: tHit };
        return;
      }
      this.isolated = null;
    });
  }

  nodeIncoming(id) {
    if (id == null) return 0;
    if (this.incomingRefsMap[id] != null) return this.incomingRefsMap[id];
    return incomingRefsOf(id, this.ordered);
  }

  initAural() {
    this.initAuralOnce(() => {
      setAesthetic('jazz');
      pickSessionKey(this.app.prompt() || 'chord');
    });
  }

  scaleNote(degree) {
    const key = getSessionKey();
    const len = key.notes.length;
    const oct = Math.floor(degree / len) * 12;
    return key.notes[((degree % len) + len) % len] + oct;
  }

  voicelead(target, ref) {
    while (target - ref > 6)  target -= 12;
    while (ref - target > 6)  target += 12;
    return target;
  }

  topicTriad(topicId) {
    const idx = Math.max(0, this.topics.findIndex(t => t.id === topicId));
    const root = (idx * 2) % 7;
    return [this.scaleNote(root) + 12, this.scaleNote(root + 2) + 12, this.scaleNote(root + 4) + 12];
  }

  playHoverVoicing(cHit) {
    const now = performance.now();
    if (now - this._lastHoverTime < HOVER_COOLDOWN_MS) return;
    this._lastHoverTime = now;
    const idx = Math.max(0, this.topics.findIndex(t => t.id === cHit.a.topic));
    const root = (idx * 2) % 7;
    const rootMidi = this.scaleNote(root) + 12;
    const quality = REL_QUALITY[cHit.rel] || 'maj9';
    const intervals = ROOTLESS[quality];
    const midis = intervals.map(i => rootMidi + i);
    playChord(midis.map(midiToFreq), { ...PRESETS.pad, duration: 1.2, vol: 0.12, reverbSend: 0.35 });
  }

  playVoiceLeadChord(node) {
    let target = this.topicTriad(node.topic);
    if (this.lastChord) target = target.map((m, i) => this.voicelead(m, this.lastChord[i]));
    this.lastChord = target;
    playChord(target.map(midiToFreq), { ...PRESETS.pad, duration: 1.5, vol: 0.12, reverbSend: 0.35 });
  }

  geometry() {
    const cx = this.W / 2, cy = this.H / 2;
    const r = Math.min(this.W, this.H) / 2 - 90;
    return { cx, cy, r };
  }

  layout() {
    const G = this.geometry();
    this.ordered = [...this.nodes].sort((a, b) => {
      const ai = this.topics.findIndex(t => t.id === a.topic);
      const bi = this.topics.findIndex(t => t.id === b.topic);
      if (ai !== bi) return ai - bi;
      return this.nodes.indexOf(a) - this.nodes.indexOf(b);
    });
    const N = this.ordered.length;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
      this.ordered[i].angle = ang;
      this.ordered[i].x = G.cx + Math.cos(ang) * G.r;
      this.ordered[i].y = G.cy + Math.sin(ang) * G.r;
    }
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
    this.layout();
  }

  pointOnRing(angle) {
    const G = this.geometry();
    return { x: G.cx + Math.cos(angle) * G.r, y: G.cy + Math.sin(angle) * G.r };
  }

  angleFromPoint(mx, my) {
    const G = this.geometry();
    return Math.atan2(my - G.cy, mx - G.cx);
  }

  distFromCentre(mx, my) {
    const G = this.geometry();
    return Math.hypot(mx - G.cx, my - G.cy);
  }

  distToBezier(px, py, x0, y0, x1, y1, x2, y2) {
    let minD = Infinity;
    const STEPS = 20;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS, u = 1 - t;
      const bx = u * u * x0 + 2 * u * t * x1 + t * t * x2;
      const by = u * u * y0 + 2 * u * t * y1 + t * t * y2;
      const d = Math.hypot(bx - px, by - py);
      if (d < minD) minD = d;
    }
    return minD;
  }

  nodeAt(mx, my, tol = 18) {
    let best = null, bestD = tol;
    for (const n of this.ordered) { const d = Math.hypot(n.x - mx, n.y - my); if (d < bestD) { bestD = d; best = n; } }
    return best;
  }

  segmentAt(mx, my) {
    if (this.ordered.length === 0) return null;
    const G = this.geometry();
    const d = Math.hypot(mx - G.cx, my - G.cy);
    const segmentR = G.r + 16;
    if (Math.abs(d - segmentR) > 10) return null;
    const ang = this.angleFromPoint(mx, my);
    let best = null, bestAngD = Infinity;
    for (const n of this.ordered) {
      const diff = Math.abs(((ang - n.angle + Math.PI) % (Math.PI * 2)) - Math.PI);
      if (diff < bestAngD) { bestAngD = diff; best = n; }
    }
    return best ? best.topic : null;
  }

  centreAt(mx, my) { return this.distFromCentre(mx, my) < 40; }

  enumerateAutoChords() {
    const out = [];
    for (let i = 0; i < this.ordered.length; i++) {
      for (let j = i + 1; j < this.ordered.length; j++) {
        const a = this.ordered[i], b = this.ordered[j];
        if (a.topic === b.topic) out.push({ a, b, kind: 'primary' });
        else if (a.type === b.type) out.push({ a, b, kind: 'secondary' });
      }
    }
    return out;
  }

  enumerateRefsChords() {
    const out = [];
    for (const src of this.ordered) {
      const targets = refsFrom(src, this.ordered);
      for (const tgt of targets) out.push({ a: tgt, b: src, rel: src.rel, stance: src.stance, heat: src.heat });
    }
    return out;
  }

  enumerateBecauseChords() {
    const internal = [], external = [];
    for (const src of this.ordered) {
      if (!Array.isArray(src.because)) continue;
      for (const b of src.because) {
        if (typeof b === 'string') external.push({ node: src, tag: b });
        else { const tgt = nodeBy(b, this.ordered); if (tgt && tgt !== src) internal.push({ a: tgt, b: src }); }
      }
    }
    return { internal, external };
  }

  sessionHasRefs() {
    for (const n of this.ordered) if (Array.isArray(n.refs) && n.refs.length > 0) return true;
    return false;
  }

  topicIncomingSum(topicId) {
    let sum = 0;
    for (const n of this.ordered) {
      if (n.topic !== topicId) continue;
      sum += (this.incomingRefsMap[n.id] || incomingRefsOf(n.id, this.ordered));
    }
    return sum;
  }

  nodeHasChord(n) {
    if (Array.isArray(n.refs) && n.refs.length > 0) return true;
    if ((this.incomingRefsMap[n.id] || incomingRefsOf(n.id, this.ordered)) > 0) return true;
    if (Array.isArray(n.because) && n.because.length > 0) return true;
    return false;
  }

  chordAt(mx, my, tol = 10) {
    const G = this.geometry();
    let best = null, bestD = tol;
    const chords = this.sessionHasRefs() ? this.enumerateRefsChords() : this.enumerateAutoChords();
    for (const c of chords) {
      let bx = G.cx, by = G.cy;
      if (c.rel === 'contradicts') {
        const cmx = (c.a.x + c.b.x) / 2, cmy = (c.a.y + c.b.y) / 2;
        bx = cmx + (cmx - G.cx) * 0.7; by = cmy + (cmy - G.cy) * 0.7;
      }
      const d = this.distToBezier(mx, my, c.a.x, c.a.y, bx, by, c.b.x, c.b.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  isNodeInIsolation(n) {
    if (!this.isolated) return true;
    if (this.isolated.kind === 'node') return n === this.isolated.node;
    if (this.isolated.kind === 'topic') return n.topic === this.isolated.topicId;
    return true;
  }

  isChordInIsolation(a, b) {
    if (!this.isolated) return true;
    if (this.isolated.kind === 'node') return a === this.isolated.node || b === this.isolated.node;
    if (this.isolated.kind === 'topic') return a.topic === this.isolated.topicId || b.topic === this.isolated.topicId;
    return true;
  }

  spawnGhostChord() {
    const angA = Math.random() * Math.PI * 2;
    let angB;
    do { angB = Math.random() * Math.PI * 2; } while (Math.abs(angA - angB) < 0.3);
    this.ghostChords.push({ angleA: angA, angleB: angB, age: 0, maxAge: 110 + Math.random() * 50, amp: 0.22 + Math.random() * 0.1 });
  }

  simulatePrime() {
    if (this.primePhase) {
      this.ghostSpawnTimer--;
      if (this.ghostSpawnTimer <= 0 && this.ghostChords.length < 3) { this.spawnGhostChord(); this.ghostSpawnTimer = 40 + Math.random() * 45; }
    }
    for (let i = this.ghostChords.length - 1; i >= 0; i--) {
      this.ghostChords[i].age++;
      if (this.ghostChords[i].age >= this.ghostChords[i].maxAge) this.ghostChords.splice(i, 1);
    }
  }

  drawGhostChords() {
    if (this.ghostChords.length === 0 && !this.pendingUserChord) return;
    const G = this.geometry();
    for (const g of this.ghostChords) {
      const t = g.age / g.maxAge;
      const env = t < 0.2 ? t / 0.2 : t > 0.8 ? (1 - t) / 0.2 : 1;
      const alpha = g.amp * env;
      if (alpha < 0.01) continue;
      const a = this.pointOnRing(g.angleA), b = this.pointOnRing(g.angleB);
      this.ctx.strokeStyle = `rgba(190, 200, 220, ${alpha})`; this.ctx.lineWidth = 0.9;
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.quadraticCurveTo(G.cx, G.cy, b.x, b.y); this.ctx.stroke();
      this.ctx.fillStyle = `rgba(210, 220, 240, ${alpha * 1.2})`;
      this.ctx.beginPath(); this.ctx.arc(a.x, a.y, 1.6, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.beginPath(); this.ctx.arc(b.x, b.y, 1.6, 0, Math.PI * 2); this.ctx.fill();
    }
    if (this.pendingUserChord) {
      const a = this.pointOnRing(this.pendingUserChord.angle);
      this.ctx.strokeStyle = 'rgba(255, 245, 200, 0.65)'; this.ctx.lineWidth = 1;
      this.ctx.setLineDash([3, 4]);
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.quadraticCurveTo(G.cx, G.cy, this.dragMouse.x, this.dragMouse.y); this.ctx.stroke();
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = 'rgba(255, 245, 200, 0.9)';
      this.ctx.beginPath(); this.ctx.arc(a.x, a.y, 3, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  startPrime() {
    this.primePhase = true;
    this.ghostChords = [];
    this.ghostSpawnTimer = 15;
    this.pendingUserChord = null;
  }

  stopPrime() {
    this.primePhase = false;
    this.pendingUserChord = null;
  }

  triggerHeartbeat() {
    this.heartbeat = { t: 0, duration: 60 };
    playTone(440, 0.35, 'sine', 0.05);
    setTimeout(() => playTone(659.25, 0.4, 'sine', 0.05), 180);
  }

  simulateHeartbeat() {
    if (!this.heartbeat) return;
    this.heartbeat.t++;
    if (this.heartbeat.t >= this.heartbeat.duration) this.heartbeat = null;
  }

  pulseFactor() {
    if (!this.heartbeat) return 0;
    const p = this.heartbeat.t / this.heartbeat.duration;
    return Math.sin(p * Math.PI);
  }

  drawBackground() {
    const g = this.ctx.createRadialGradient(this.W / 2, this.H / 2, 0, this.W / 2, this.H / 2, Math.max(this.W, this.H));
    g.addColorStop(0, '#131820'); g.addColorStop(1, '#0a0d10');
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, this.W, this.H);
    if (this.primePhase || this.ordered.length === 0) {
      const G = this.geometry();
      this.ctx.strokeStyle = 'rgba(170, 180, 200, 0.12)'; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.arc(G.cx, G.cy, G.r, 0, Math.PI * 2); this.ctx.stroke();
    }
    // Astrolabe etching — four faint concentric rings between the data ring
    // and the canvas edge, each at <3% alpha. Reads as a measurement instrument.
    const G = this.geometry();
    this.ctx.lineWidth = 1;
    const offsets = [18, 36, 56, 78];
    const alphas = [0.028, 0.022, 0.016, 0.011];
    for (let i = 0; i < offsets.length; i++) {
      this.ctx.strokeStyle = `rgba(170, 180, 200, ${alphas[i]})`;
      this.ctx.beginPath();
      this.ctx.arc(G.cx, G.cy, G.r + offsets[i], 0, Math.PI * 2);
      this.ctx.stroke();
    }
  }

  drawTopicSegments() {
    if (this.ordered.length === 0) return;
    const ht = this.app.highlightedTopic;
    const G = this.geometry();
    const N = this.ordered.length;
    const step = (Math.PI * 2) / N;
    const segmentR = G.r + 16;
    let i = 0;
    while (i < N) {
      const topic = this.ordered[i].topic;
      let j = i;
      while (j < N && this.ordered[j].topic === topic) j++;
      const info = this.topicInfo(topic);
      const startAng = (i / N) * Math.PI * 2 - Math.PI / 2 - step * 0.35;
      const endAng = ((j - 1) / N) * Math.PI * 2 - Math.PI / 2 + step * 0.35;
      const isolationDim = this.isolated && this.isolated.kind === 'topic' && this.isolated.topicId !== topic ? 0.2 : 1;
      const legendDim = ht && topic !== ht ? 0.25 : 1;
      const dim = isolationDim * legendDim;
      const baseWidth = (this.isolated && this.isolated.kind === 'topic' && this.isolated.topicId === topic) ? 14 : 10;
      const incomingBoost = Math.min(8, this.topicIncomingSum(topic) * 0.8);
      this.ctx.strokeStyle = info.color; this.ctx.globalAlpha = dim;
      this.ctx.lineWidth = baseWidth + incomingBoost; this.ctx.lineCap = 'butt';
      this.ctx.beginPath(); this.ctx.arc(G.cx, G.cy, segmentR, startAng, endAng); this.ctx.stroke();
      this.ctx.globalAlpha = 1;
      i = j;
    }
  }

  chordControl(ax, ay, bx, by) {
    const G = this.geometry();
    const pf = this.pulseFactor();
    if (pf === 0) return { x: G.cx, y: G.cy };
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    return { x: G.cx + (mx - G.cx) * pf * 0.7, y: G.cy + (my - G.cy) * pf * 0.7 };
  }

  drawChords() {
    if (this.ordered.length < 2) return;
    if (this.sessionHasRefs()) this.drawRefsChords();
    else this.drawHeuristicChords();
  }

  drawHeuristicChords() {
    for (let i = 0; i < this.ordered.length; i++) {
      for (let j = i + 1; j < this.ordered.length; j++) {
        const a = this.ordered[i], b = this.ordered[j];
        if (a.topic !== b.topic) continue;
        const lit = this.isChordInIsolation(a, b);
        const [r, g, bb] = hexToRgb(this.topicInfo(a.topic).color);
        const alpha = lit ? 0.42 : 0.08;
        this.ctx.strokeStyle = `rgba(${r},${g},${bb},${alpha})`; this.ctx.lineWidth = lit ? 1.4 : 0.8;
        const cp = this.chordControl(a.x, a.y, b.x, b.y);
        this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y); this.ctx.stroke();
      }
    }
    for (let i = 0; i < this.ordered.length; i++) {
      for (let j = i + 1; j < this.ordered.length; j++) {
        const a = this.ordered[i], b = this.ordered[j];
        if (a.topic === b.topic || a.type !== b.type) continue;
        const lit = this.isChordInIsolation(a, b);
        const [ra, ga, ba] = hexToRgb(this.topicInfo(a.topic).color);
        const [rb, gb, bbb] = hexToRgb(this.topicInfo(b.topic).color);
        const r = (ra + rb) / 2, g = (ga + gb) / 2, b2 = (ba + bbb) / 2;
        const alpha = lit ? 0.16 : 0.04;
        this.ctx.strokeStyle = `rgba(${r},${g},${b2},${alpha})`; this.ctx.lineWidth = 0.7;
        const cp = this.chordControl(a.x, a.y, b.x, b.y);
        this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y); this.ctx.stroke();
      }
    }
  }

  drawRefsChords() {
    const chords = this.enumerateRefsChords();
    for (const c of chords) { const lit = this.isChordInIsolation(c.a, c.b); this.drawChordUndercoat(c, lit ? 0.22 : 0.05); }
    for (const c of chords) {
      const lit = this.isChordInIsolation(c.a, c.b);
      const baseAlpha = lit ? 1 : 0.15;
      const heatMult = (c.heat != null ? 0.55 + c.heat * 0.6 : 1);
      const stAlpha = c.stance === 'conceding' ? 0.45 : c.stance === 'questioning' ? 0.8 : c.stance === 'exploring' ? 0.9 : 1;
      const alpha = baseAlpha * heatMult * stAlpha;
      const color = relColor(c.rel);
      const stanceDash = (c.rel === 'refines' || c.rel === 'questions' || c.rel === 'supersedes') ? null : (c.stance === 'exploring' ? [6, 4] : c.stance === 'questioning' ? [2, 3] : null);
      this.drawRelChord(c, color, alpha, stanceDash);
    }
  }

  drawChordUndercoat(c, visibilityAlpha) {
    if (visibilityAlpha < 0.01) return;
    const [ar, ag, ab] = hexToRgb(this.topicInfo(c.a.topic).color);
    const [br, bg, bb] = hexToRgb(this.topicInfo(c.b.topic).color);
    const grad = this.ctx.createLinearGradient(c.a.x, c.a.y, c.b.x, c.b.y);
    grad.addColorStop(0, `rgba(${ar},${ag},${ab},${visibilityAlpha})`);
    grad.addColorStop(1, `rgba(${br},${bg},${bb},${visibilityAlpha})`);
    this.ctx.strokeStyle = grad; this.ctx.lineWidth = 5; this.ctx.lineCap = 'butt'; this.ctx.setLineDash([]); this.ctx.globalAlpha = 1;
    this.ctx.beginPath();
    if (c.rel === 'contradicts') {
      const G = this.geometry();
      const mx_c = (c.a.x + c.b.x) / 2, my_c = (c.a.y + c.b.y) / 2;
      const ocpx = mx_c + (mx_c - G.cx) * 0.7, ocpy = my_c + (my_c - G.cy) * 0.7;
      this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(ocpx, ocpy, c.b.x, c.b.y);
    } else {
      const cp = this.chordControl(c.a.x, c.a.y, c.b.x, c.b.y);
      this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, c.b.x, c.b.y);
    }
    this.ctx.stroke();
  }

  drawRelChord(c, color, alpha, dashOverride) {
    const G = this.geometry();
    const cp = this.chordControl(c.a.x, c.a.y, c.b.x, c.b.y);
    const mx = (c.a.x + c.b.x) / 2, my = (c.a.y + c.b.y) / 2;
    const qmx = (c.a.x + 2 * cp.x + c.b.x) / 4, qmy = (c.a.y + 2 * cp.y + c.b.y) / 4;
    const CONTRADICTS_OUT = 0.7;
    const ocpx = mx + (mx - G.cx) * CONTRADICTS_OUT, ocpy = my + (my - G.cy) * CONTRADICTS_OUT;
    const oqmx = (c.a.x + 2 * ocpx + c.b.x) / 4, oqmy = (c.a.y + 2 * ocpy + c.b.y) / 4;
    this.ctx.globalAlpha = alpha; this.ctx.strokeStyle = color;
    switch (c.rel) {
      case 'contradicts':
        this.ctx.lineWidth = 1.6; this.ctx.setLineDash(dashOverride || []);
        this.ctx.beginPath(); this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(ocpx, ocpy, c.b.x, c.b.y); this.ctx.stroke();
        this.ctx.setLineDash([]); break;
      case 'synthesizes':
        this.ctx.lineWidth = 3.2; this.ctx.setLineDash([]);
        this.ctx.beginPath(); this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, c.b.x, c.b.y); this.ctx.stroke(); break;
      case 'refines':
        this.ctx.lineWidth = 1; this.ctx.setLineDash([1, 3]);
        this.ctx.beginPath(); this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, c.b.x, c.b.y); this.ctx.stroke();
        this.ctx.setLineDash([]); break;
      case 'questions':
        this.ctx.lineWidth = 1.3; this.ctx.setLineDash([3, 4]);
        this.ctx.beginPath(); this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, c.b.x, c.b.y); this.ctx.stroke();
        this.ctx.setLineDash([]); break;
      case 'supersedes':
        this.ctx.globalAlpha = alpha * 0.5; this.ctx.lineWidth = 1; this.ctx.setLineDash([]);
        this.ctx.beginPath(); this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, c.b.x, c.b.y); this.ctx.stroke();
        this.ctx.globalAlpha = alpha; this.ctx.lineWidth = 1.4;
        this.ctx.beginPath();
        this.ctx.moveTo(c.a.x - 5, c.a.y - 5); this.ctx.lineTo(c.a.x + 5, c.a.y + 5);
        this.ctx.moveTo(c.a.x - 5, c.a.y + 5); this.ctx.lineTo(c.a.x + 5, c.a.y - 5);
        this.ctx.stroke(); break;
      case 'supports': default:
        this.ctx.lineWidth = 1.4; this.ctx.setLineDash(dashOverride || []);
        this.ctx.beginPath(); this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, c.b.x, c.b.y); this.ctx.stroke();
        this.ctx.setLineDash([]); break;
    }
    const chordLen = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
    if (chordLen >= 28) {
      const glyph = relGlyph(c.rel);
      if (glyph) {
        const gx = c.rel === 'contradicts' ? oqmx : qmx;
        const gy = c.rel === 'contradicts' ? oqmy : qmy;
        this.ctx.globalAlpha = alpha;
        this.ctx.font = "700 10px 'JetBrains Mono', monospace";
        const tw = this.ctx.measureText(glyph).width + 6, th = 12;
        this.ctx.fillStyle = `rgba(10, 13, 18, ${alpha * 0.82})`;
        if (this.ctx.roundRect) { this.ctx.beginPath(); this.ctx.roundRect(gx - tw / 2, gy - th / 2, tw, th, 2); this.ctx.fill(); }
        else this.ctx.fillRect(gx - tw / 2, gy - th / 2, tw, th);
        this.ctx.fillStyle = color; this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
        this.ctx.fillText(glyph, gx, gy + 0.5);
      }
    }
    this.ctx.globalAlpha = 1;
  }

  drawBecauseChords() {
    const { internal, external } = this.enumerateBecauseChords();
    const G = this.geometry();
    for (const c of internal) {
      if (!this.isChordInIsolation(c.a, c.b)) continue;
      this.ctx.strokeStyle = 'rgba(200, 210, 225, 0.32)'; this.ctx.lineWidth = 0.8;
      this.ctx.setLineDash([1, 3]);
      this.ctx.beginPath(); this.ctx.moveTo(c.a.x, c.a.y); this.ctx.quadraticCurveTo(G.cx, G.cy, c.b.x, c.b.y); this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
    for (const e of external) {
      if (!this.isNodeInIsolation(e.node)) continue;
      const outFactor = 1.35;
      const ox = G.cx + (e.node.x - G.cx) * outFactor, oy = G.cy + (e.node.y - G.cy) * outFactor;
      const grad = this.ctx.createLinearGradient(ox, oy, e.node.x, e.node.y);
      grad.addColorStop(0, 'rgba(200, 210, 225, 0)'); grad.addColorStop(1, 'rgba(200, 210, 225, 0.42)');
      this.ctx.strokeStyle = grad; this.ctx.lineWidth = 1; this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath(); this.ctx.moveTo(ox, oy); this.ctx.lineTo(e.node.x, e.node.y); this.ctx.stroke();
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = 'rgba(200, 210, 225, 0.55)'; this.ctx.font = "500 10px 'JetBrains Mono', monospace";
      this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle';
      this.ctx.fillText(e.tag === 'prior' ? '←' : '↗', ox, oy);
    }
  }

  drawUserChords() {
    if (this.userChords.length === 0) return;
    for (const uc of this.userChords) {
      const a = this.pointOnRing(uc.angleA), b = this.pointOnRing(uc.angleB);
      const cp = this.chordControl(a.x, a.y, b.x, b.y);
      this.ctx.strokeStyle = 'rgba(255, 245, 200, 0.58)'; this.ctx.lineWidth = 1; this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y); this.ctx.stroke();
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = 'rgba(255, 245, 200, 0.75)';
      this.ctx.beginPath(); this.ctx.arc(a.x, a.y, 2.2, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.beginPath(); this.ctx.arc(b.x, b.y, 2.2, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  drawDragPreview() {
    if (!this.dragFrom || !this.dragStarted) return;
    const G = this.geometry();
    this.ctx.strokeStyle = 'rgba(255, 245, 200, 0.4)'; this.ctx.lineWidth = 0.8; this.ctx.setLineDash([3, 4]);
    this.ctx.beginPath(); this.ctx.moveTo(this.dragFrom.x, this.dragFrom.y); this.ctx.quadraticCurveTo(G.cx, G.cy, this.dragMouse.x, this.dragMouse.y); this.ctx.stroke();
    this.ctx.setLineDash([]);
  }

  drawNodes() {
    const ht = this.app.highlightedTopic;
    const v2 = this.sessionHasRefs();
    for (const n of this.ordered) {
      const lit = this.isNodeInIsolation(n);
      const legendDim = ht && n.topic !== ht ? 0.25 : 1;
      let dim = (lit ? 1 : 0.15) * legendDim;
      if (v2 && lit && !this.nodeHasChord(n)) dim *= 0.4;
      const info = this.topicInfo(n.topic);
      const [r, g, b] = hexToRgb(info.color);
      this.ctx.fillStyle = `rgba(${r},${g},${b},${0.2 * dim})`;
      this.ctx.beginPath(); this.ctx.arc(n.x, n.y, 6 + n.confidence * 4, 0, Math.PI * 2); this.ctx.fill();
      this.ctx.fillStyle = `rgba(${r},${g},${b},${0.95 * dim})`;
      this.ctx.beginPath(); this.ctx.arc(n.x, n.y, 2.5 + n.confidence * 2, 0, Math.PI * 2); this.ctx.fill();
    }
  }

  simulateBatchRipples() {
    for (let i = this.batchRipples.length - 1; i >= 0; i--) {
      this.batchRipples[i].age++;
      if (this.batchRipples[i].age > 80) this.batchRipples.splice(i, 1);
    }
  }

  drawBatchRipples() {
    if (this.batchRipples.length === 0) return;
    const G = this.geometry();
    for (const rp of this.batchRipples) {
      const t = rp.age / 80;
      const alpha = (1 - t) * 0.28;
      if (alpha < 0.01) continue;
      const radius = G.r * (1 - t * 0.45);
      this.ctx.strokeStyle = `rgba(210, 220, 240, ${alpha})`; this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.arc(G.cx, G.cy, radius, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  onStart() {
    this.initAural();
    this.startPrime();
    this.unpackPrompt(this.app.prompt());
  }

  // Prompt-unpack: add one ghost chord arc per token at a hashed angle on the ring.
  // These are extra ghost arcs shown during prime, dissolving when nodes arrive.
  unpackPrompt(prompt) {
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return;
    const TAU = Math.PI * 2;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const h = this.hashToken(tok);
      // Deterministic angle for this token
      const angleA = (h % 1000) / 1000 * TAU;
      // Connect to next token's angle (wrap) for a faint chord
      const next = tokens[(i + 1) % tokens.length];
      const h2 = this.hashToken(next);
      const angleB = (h2 % 1000) / 1000 * TAU;
      if (Math.abs(angleA - angleB) < 0.2) continue;
      this.ghostChords.push({
        angleA, angleB,
        age: 0,
        maxAge: 180 + ((h >> 8) % 80),
        amp: 0.14 + ((h >> 12) % 10) / 100,
      });
    }
  }

  onNode(n) {
    if (this.primePhase) this.stopPrime();
    n.x = 0; n.y = 0; n.angle = 0;
    this.layout();
    this.playVoiceLeadChord(n);
  }

  onDone() { this.stopPrime(); }
  onError() { this.stopPrime(); }
  onStop() { this.stopPrime(); }

  onClear() {
    this.ordered = [];
    this.userChords = [];
    this.ghostChords = [];
    this.primePhase = false;
    this.pendingUserChord = null;
    this.isolated = null;
    this.heartbeat = null;
    this.dragFrom = null;
    this.dragStarted = false;
    this.incomingRefsMap = {};
    this.batchRipples = [];
    this.lastChord = null;
    this.canvas.style.cursor = 'crosshair';
  }

  draw() {
    if (this.app.isPaused()) return;
    this.simulatePrime();
    this.simulateHeartbeat();
    this.simulateBatchRipples();
    this.drawBackground();
    this.drawBatchRipples();
    this.drawGhostChords();
    this.drawBecauseChords();
    this.drawChords();
    this.drawUserChords();
    this.drawTopicSegments();
    this.drawNodes();
    this.drawDragPreview();
  }
}

export { ChordMode };
